/* POST /api/mnaiapi/:model — chat with any MNAI model.
   Auth:  Authorization: Bearer <Firebase ID token | mnai_sk_… | mnai-free-sk-…>
          (or X-API-Key header)
   Body:  { messages: [{role, content}, …], stream?: bool, max_tokens?: n }
   Free models (MNAI 6, MNAI 7, Glyph 1, Glyph 1.5): no charge.
   Pro models: mnai-free-sk- keys are rejected; mnai_sk_ keys and signed-in
   users pay credits from their wallet: ceil(tokens/1000) * rate.
   Every reply carries the MNAI identity (see ../_identity.js). */
const lib = require("../_lib");
const ident = require("../_identity");

module.exports.config = { maxDuration: 60 };

const XKIRO_CHAT = "https://api.xkiro.com/v1/chat/completions";

function needEnv(name) {
  const v = process.env[name];
  if (!v) throw { code: 503, message: `AI backend not configured (missing ${name} in Vercel env).` };
  return v;
}
function estimateTokens(text) { return Math.ceil(String(text || "").length / 4); }

/* Call the upstream provider. Returns { content, promptTokens, completionTokens, streamed } */
async function callUpstream(def, messages, opts, onToken) {
  const maxTokens = Math.min(Math.max(opts.max_tokens || 1024, 1), 4096);
  const body = { messages, max_tokens: maxTokens, stream: !!opts.stream };

  async function xkiro(key, model) {
    const r = await fetch(XKIRO_CHAT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
      body: JSON.stringify({ ...body, model }),
    });
    return r;
  }

  let res;
  if (def.provider === "xkiro" || def.provider === "xkiro2") {
    const k1 = needEnv("XKIRO_API_KEY");
    const k2 = process.env.XKIRO_API_KEY2 || null;
    const order = def.provider === "xkiro2" ? [k2, k1].filter(Boolean) : [k1, k2].filter(Boolean);
    let lastErr = null;
    for (const key of order) {
      res = await xkiro(key, def.model);
      if (res.ok) break;
      if ([401, 403, 429, 500, 502, 503].includes(res.status) && key !== order[order.length - 1]) {
        lastErr = res.status; continue; // fail over
      }
      break;
    }
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw { code: 502, message: `AI provider error (${res.status}${lastErr ? ", failover tried" : ""}).`, detail: t.slice(0, 300) };
    }
  } else if (def.provider === "nara") {
    const key = needEnv("NARA_API_KEY");
    res = await fetch("https://router.bynara.id/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
      body: JSON.stringify({ ...body, model: def.model }),
    });
  } else if (def.provider === "inception") {
    const key = needEnv("INCCH_API_KEY");
    res = await fetch("https://api.inceptionlabs.ai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
      body: JSON.stringify({ ...body, model: def.model }),
    });
  } else if (def.provider === "openrouter") {
    const key = needEnv("OPENROUTER_API_KEY");
    res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key,
        "HTTP-Referer": "https://dash-mnaii.vercel.app", "X-Title": "MNAI Console" },
      body: JSON.stringify({ ...body, model: def.model }),
    });
  } else {
    throw { code: 500, message: "Unknown provider." };
  }

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw { code: 502, message: `AI provider error (${res.status}).`, detail: t.slice(0, 300) };
  }

  if (opts.stream) {
    // SSE passthrough; accumulate for usage/credits after [DONE]
    let full = "";
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop();
      for (const p of parts) {
        onToken(p + "\n\n");
        const m = p.match(/"delta"\s*:\s*\{\s*"content"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        if (m) { try { full += JSON.parse('"' + m[1] + '"'); } catch {} }
        if (p.includes('"usage"')) {
          const u = p.match(/"usage"\s*:\s*\{[^}]*"total_tokens"\s*:\s*(\d+)/);
          if (u) opts._usage.total = parseInt(u[1], 10);
        }
      }
    }
    return { content: full, promptTokens: 0, completionTokens: 0, streamed: true, text: full };
  }

  const j = await res.json();
  const msg = j.choices && j.choices[0] && j.choices[0].message;
  const content = (msg && msg.content) || "";
  const u = j.usage || {};
  return {
    content,
    promptTokens: u.prompt_tokens || estimateTokens(JSON.stringify(messages)),
    completionTokens: u.completion_tokens || estimateTokens(content),
    streamed: false,
  };
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") { lib.cors(res); res.status(200).end(); return; }
  if (req.method !== "POST") return lib.json(res, 405, { error: "Use POST." });
  if (!lib.backendReady()) return lib.json(res, 503, { error: "Backend not configured (FIREBASE_SERVICE_ACCOUNT)." });

  const slug = String(req.query.model || "").toLowerCase();
  const def = lib.MODELS[slug];
  if (!def) return lib.json(res, 404, { error: "Unknown model.", models: lib.publicCatalog() });

  let a;
  try { a = await lib.authReq(req); }
  catch (e) { return lib.json(res, e.code || 500, { error: e.message }); }

  // free keys can only touch free models
  if (!def.free && a.via === "apikey" && a.key.kind === "free")
    return lib.json(res, 403, { error: `${def.label} needs credits. Free keys only cover free models — create a mnai_sk_ key or buy credits.` });

  const body = await lib.readBody(req);
  const messages = Array.isArray(body.messages) ? body.messages.filter(m => m && m.content).slice(-30) : [];
  if (!messages.length || !messages.some((m) => m.role === "user"))
    return lib.json(res, 400, { error: "Body needs messages: [{role:'user', content:'…'}]." });

  const t0 = Date.now();
  const sys = ident.systemPrompt(def.label);
  const withSys = [{ role: "system", content: sys }, ...messages];

  // identity fast-path: answered locally, costs nothing
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const local = lastUser ? ident.identityAnswer(def.label, lastUser.content) : null;

  let content, promptTokens = 0, completionTokens = 0, charged = 0, status = 200;

  try {
    if (local) {
      content = local;
      promptTokens = estimateTokens(lastUser.content); completionTokens = estimateTokens(content);
    } else {
      if (!def.free) {
        const bal = await lib.getCredits(a.uid);
        if (bal < 1) throw { code: 402, message: `Insufficient credits for ${def.label}. Buy credits to continue.`, credits: bal };
      }
      if (body.stream) {
        lib.cors(res);
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        const usage = { total: 0 };
        const r = await callUpstream(def, withSys, { stream: true, max_tokens: body.max_tokens, _usage: usage },
          (chunk) => res.write(chunk));
        res.write("data: [DONE]\n\n");
        res.end();
        content = r.content;
        const total = usage.total || (estimateTokens(JSON.stringify(withSys)) + estimateTokens(content));
        promptTokens = Math.round(total * 0.6); completionTokens = total - promptTokens;
        if (!def.free) {
          charged = Math.max(1, Math.ceil(total / 1000) * def.rate);
          try { await lib.addCredits(a.uid, -charged, "api-use", { model: slug }); }
          catch (e) { charged = 0; }
        }
        await lib.logUsage(a.uid, { ts: Date.now(), model: slug, tokens: total, ms: Date.now() - t0,
          status: 200, credits: charged, keyId: a.key ? a.key.id : null });
        return;
      }
      const r = await callUpstream(def, withSys, { max_tokens: body.max_tokens }, null);
      content = r.content; promptTokens = r.promptTokens; completionTokens = r.completionTokens;
      if (!def.free) {
        const total = promptTokens + completionTokens;
        charged = Math.max(1, Math.ceil(total / 1000) * def.rate);
        try { await lib.addCredits(a.uid, -charged, "api-use", { model: slug }); }
        catch (e) { throw { code: 402, message: "Insufficient credits.", credits: 0 }; }
      }
    }
  } catch (e) {
    status = e.code || 500;
    await lib.logUsage(a.uid, { ts: Date.now(), model: slug, tokens: 0, ms: Date.now() - t0,
      status, credits: 0, keyId: a.key ? a.key.id : null }).catch(() => {});
    return lib.json(res, status, { error: e.message || "AI error.", credits: e.credits, detail: e.detail });
  }

  const totalTokens = promptTokens + completionTokens;
  await lib.logUsage(a.uid, { ts: Date.now(), model: slug, tokens: totalTokens, ms: Date.now() - t0,
    status, credits: charged, keyId: a.key ? a.key.id : null }).catch(() => {});

  let credits = null;
  try { credits = await lib.getCredits(a.uid); } catch {}
  lib.json(res, 200, {
    id: "mnai-" + Date.now().toString(36),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: def.label,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens },
    credits_charged: charged,
    credits_balance: credits,
  });
};

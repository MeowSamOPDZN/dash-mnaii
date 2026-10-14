/* POST /api/mnaiapi/:model — chat with any MNAI model (thin wrapper).
   Streaming + OpenAI-style JSON handled here; the engine lives in ../_chat.js. */
const lib = require("../_lib");
const ident = require("../_identity");
const chat = require("../_chat");

module.exports.config = { maxDuration: 60 };

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") { lib.cors(res); res.status(200).end(); return; }
  if (req.method !== "POST") return lib.json(res, 405, { error: "Use POST." });
  if (!lib.backendReady()) return lib.json(res, 503, { error: "Backend not configured (FIREBASE_SERVICE_ACCOUNT)." });

  const slug = String(req.query.model || "").toLowerCase();
  const def = lib.MODELS[slug];
  if (!def) return lib.json(res, 404, { error: "Unknown model.", models: lib.publicCatalog() });

  let a;
  try { a = await lib.authReq(req); }
  catch (e) { return lib.json(res, lib.errCode(e), { error: e.message }); }

  const body = await lib.readBody(req);
  const t0 = Date.now();

  // ---- streaming path ----
  if (body.stream) {
    try {
      const messages = Array.isArray(body.messages) ? body.messages.filter((m) => m && m.content).slice(-30) : [];
      if (!messages.length || !messages.some((m) => m.role === "user"))
        return lib.json(res, 400, { error: "Body needs messages: [{role:'user', content:'…'}]." });
      if (!def.free && a.via === "apikey" && a.key.kind === "free")
        return lib.json(res, 403, { error: `${def.label} needs credits.` });
      await chat.checkKeyLimits(a, req);
      if (!def.free) {
        await chat.checkSpendCap(a.uid);
        const bal = await lib.getCredits(a.uid);
        if (bal < 1) throw { code: 402, message: `Insufficient credits for ${def.label}.` };
      }
      const withSys = [{ role: "system", content: ident.systemPrompt(def.label) }, ...messages];
      const maxTokens = Math.min(Math.max(body.max_tokens || 1024, 1), 4096);
      const upBody = { messages: withSys, max_tokens: maxTokens, stream: true };
      if (body.temperature != null) upBody.temperature = Math.min(Math.max(+body.temperature, 0), 2);
      if (body.top_p != null) upBody.top_p = Math.min(Math.max(+body.top_p, 0), 1);

      // route to the right upstream (same map as _chat.callUpstream)
      const key = chat.needEnv(def.provider === "nara" ? "NARA_API_KEY"
        : def.provider === "inception" ? "INCCH_API_KEY"
        : def.provider === "openrouter" ? "OPENROUTER_API_KEY" : "XKIRO_API_KEY");
      const key2 = process.env.XKIRO_API_KEY2 || null;
      const url = def.provider === "nara" ? "https://router.bynara.id/v1/chat/completions"
        : def.provider === "inception" ? "https://api.inceptionlabs.ai/v1/chat/completions"
        : def.provider === "openrouter" ? "https://openrouter.ai/api/v1/chat/completions"
        : "https://api.xkiro.com/v1/chat/completions";
      const order = (def.provider === "xkiro" || def.provider === "xkiro2")
        ? (def.provider === "xkiro2" ? [key2, key].filter(Boolean) : [key, key2].filter(Boolean))
        : [key];
      let res2 = null;
      for (const k of order) {
        const hdrs = { "Content-Type": "application/json", Authorization: "Bearer " + k };
        if (def.provider === "openrouter") { hdrs["HTTP-Referer"] = "https://dash-mnaii.vercel.app"; hdrs["X-Title"] = "MNAI Console"; }
        res2 = await fetch(url, { method: "POST", headers: hdrs,
          body: JSON.stringify({ ...upBody, model: def.model }) });
        if (res2.ok) break;
        if (![401, 403, 429, 500, 502, 503].includes(res2.status) || k === order[order.length - 1]) break;
      }
      if (!res2.ok) throw { code: 502, message: `AI provider error (${res2.status}).` };

      lib.cors(res);
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      const reader = res2.body.getReader(), decoder = new TextDecoder();
      let buf = "", full = "", total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split("\n\n"); buf = parts.pop();
        for (const p of parts) {
          res.write(p + "\n\n");
          const m = p.match(/"delta"\s*:\s*\{\s*"content"\s*:\s*"((?:[^"\\]|\\.)*)"/);
          if (m) { try { full += JSON.parse('"' + m[1] + '"'); } catch {} }
          if (p.includes('"usage"')) {
            const u = p.match(/"usage"\s*:\s*\{[^}]*"total_tokens"\s*:\s*(\d+)/);
            if (u) total = parseInt(u[1], 10);
          }
        }
      }
      res.write(`data: ${JSON.stringify({ credits_charged: charged, tokens: tot, model: slug })}\n\n`);
      res.write("data: [DONE]\n\n"); res.end();
      const tot = total || (chat.estimateTokens(JSON.stringify(withSys)) + chat.estimateTokens(full));
      let charged = 0;
      if (!def.free) {
        charged = Math.max(1, Math.ceil(tot / 1000) * def.rate);
        try { await lib.addCredits(a.uid, -charged, "api-use", { model: slug }); } catch (e) { charged = 0; }
      }
      await chat.bumpCounters(a, tot, charged);
      await lib.logUsage(a.uid, { ts: Date.now(), model: slug, tokens: tot, ms: Date.now() - t0,
        status: 200, credits: charged, keyId: a.key ? a.key.id : null }).catch(() => {});
      await lib.fireEvent(a.uid, "request.completed",
        { model: slug, label: def.label, tokens: tot, credits: charged, ms: Date.now() - t0 }).catch(() => {});
      if (!def.free) { try { await lib.maybeLowCreditAlert(a.uid, await lib.getCredits(a.uid)); } catch (e) {} }
      return;
    } catch (e) {
      const status = lib.errCode(e);
      if (!res.headersSent) return lib.json(res, status, { error: e.message || "AI error.", detail: e.detail });
      try { res.end(); } catch (e2) {}
      return;
    }
  }

  // ---- non-streaming: shared engine ----
  try {
    const r = await chat.runChat(a, slug, body, req);
    let credits = null;
    try { credits = await lib.getCredits(a.uid); } catch (e) {}
    lib.json(res, 200, {
      id: "mnai-" + Date.now().toString(36),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: r.label,
      choices: [{ index: 0, message: { role: "assistant", content: r.content }, finish_reason: "stop" }],
      usage: { prompt_tokens: r.promptTokens, completion_tokens: r.completionTokens, total_tokens: r.totalTokens },
      credits_charged: r.charged,
      credits_balance: credits,
    });
  } catch (e) {
    const status = lib.errCode(e);
    await lib.logUsage(a.uid, { ts: Date.now(), model: slug, tokens: 0, ms: Date.now() - t0,
      status, credits: 0, keyId: a.key ? a.key.id : null }).catch(() => {});
    return lib.json(res, status, { error: e.message || "AI error.", credits: e.credits, detail: e.detail });
  }
};

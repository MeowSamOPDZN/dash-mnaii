/* Shared chat engine: used by /api/mnaiapi/:model, /api/v1/chat/completions,
   /api/batch and /api/mcp. Non-streaming. Enforces key quotas, rate limits,
   IP allowlists, spend caps, credits; logs usage; fires events. */
const lib = require("./_lib");
const ident = require("./_identity");

const XKIRO_CHAT = "https://api.xkiro.com/v1/chat/completions";

function needEnv(name) {
  const v = process.env[name];
  if (!v) throw { code: 503, message: `AI backend not configured (missing ${name} in Vercel env).` };
  return v;
}
function estimateTokens(text) { return Math.ceil(String(text || "").length / 4); }

/* Call the upstream provider (non-streaming here; streaming lives in [model].js) */
async function callUpstream(def, messages, opts) {
  const maxTokens = Math.min(Math.max(opts.max_tokens || 1024, 1), 4096);
  const body = { messages, max_tokens: maxTokens, stream: false };
  if (opts.temperature != null) body.temperature = Math.min(Math.max(+opts.temperature, 0), 2);
  if (opts.top_p != null) body.top_p = Math.min(Math.max(+opts.top_p, 0), 1);

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
        lastErr = res.status; continue;
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
  const j = await res.json();
  const msg = j.choices && j.choices[0] && j.choices[0].message;
  const content = (msg && msg.content) || "";
  const u = j.usage || {};
  return {
    content,
    promptTokens: u.prompt_tokens || estimateTokens(JSON.stringify(messages)),
    completionTokens: u.completion_tokens || estimateTokens(content),
  };
}

function monthKey() { return new Date().toISOString().slice(0, 7); }

/* Guards for API-key callers: IP allowlist, monthly quota, per-minute rate. */
async function checkKeyLimits(a, req) {
  if (!a.key) return;
  const k = a.key;
  if (k.ipAllowlist) {
    const allowed = String(k.ipAllowlist).split(",").map((s) => s.trim()).filter(Boolean);
    const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (allowed.length && !allowed.includes(ip))
      throw { code: 403, message: "This API key is restricted to specific IP addresses." };
  }
  if (!k.quotaMonthly && !k.ratePerMin) return;
  const s = await lib.db().collection("apiKeys").doc(k.id).get().catch(() => null);
  const kd = s && s.exists ? s.data() : {};
  const now = Date.now(), mk = monthKey();
  if (kd.quotaMonthly && kd.quotaMonth === mk && (kd.quotaUsed || 0) >= kd.quotaMonthly)
    throw { code: 429, message: `Monthly key quota exceeded (${kd.quotaMonthly} requests).` };
  if (kd.ratePerMin && kd.rateWindowStart && now - kd.rateWindowStart < 60000 && (kd.rateWindowCount || 0) >= kd.ratePerMin)
    throw { code: 429, message: `Rate limit exceeded (${kd.ratePerMin} requests/min).` };
}

async function checkSpendCap(uid) {
  const s = await lib.db().collection("dashUsers").doc(uid).get().catch(() => null);
  const u = s && s.exists ? s.data() : {};
  const mk = monthKey();
  if (u.spendCap && u.spendMonth === mk && (u.spendUsed || 0) >= u.spendCap)
    throw { code: 402, message: `Monthly spend cap reached (${u.spendCap} credits). Raise it in Settings → Wallet.` };
}

async function bumpCounters(a, totalTokens, charged) {
  const adm = lib.admin(), db = lib.db(), now = Date.now(), mk = monthKey();
  const jobs = [];
  if (a.key) {
    const kref = db.collection("apiKeys").doc(a.key.id);
    jobs.push(kref.get().then((s) => {
      const kd = s.exists ? s.data() : {};
      const up = {
        requests: adm.firestore.FieldValue.increment(1),
        tokens: adm.firestore.FieldValue.increment(totalTokens),
        creditsUsed: adm.firestore.FieldValue.increment(charged),
      };
      if (kd.quotaMonth !== mk) { up.quotaMonth = mk; up.quotaUsed = 1; }
      else up.quotaUsed = adm.firestore.FieldValue.increment(1);
      const ws = kd.rateWindowStart || 0;
      if (now - ws > 60000) { up.rateWindowStart = now; up.rateWindowCount = 1; }
      else up.rateWindowCount = adm.firestore.FieldValue.increment(1);
      return kref.set(up, { merge: true });
    }).catch(() => {}));
  }
  if (charged > 0) {
    const uref = db.collection("dashUsers").doc(a.uid);
    jobs.push(uref.get().then((s) => {
      const u = s.exists ? s.data() : {};
      const up = u.spendMonth === mk
        ? { spendUsed: adm.firestore.FieldValue.increment(charged) }
        : { spendMonth: mk, spendUsed: charged };
      return uref.set(up, { merge: true });
    }).catch(() => {}));
  }
  await Promise.all(jobs);
}

/* One full non-streaming chat turn. Returns result or throws {code,message}. */
async function runChat(a, slug, body, req) {
  const def = lib.MODELS[slug];
  if (!def) throw { code: 404, message: "Unknown model." };
  if (!def.free && a.via === "apikey" && a.key.kind === "free")
    throw { code: 403, message: `${def.label} needs credits. Free keys only cover free models — create a mnai_sk_ key or buy credits.` };

  const messages = Array.isArray(body.messages) ? body.messages.filter((m) => m && m.content).slice(-30) : [];
  if (!messages.length || !messages.some((m) => m.role === "user"))
    throw { code: 400, message: "Body needs messages: [{role:'user', content:'…'}]." };

  await checkKeyLimits(a, req || { headers: {} });
  if (!def.free) await checkSpendCap(a.uid);

  const t0 = Date.now();
  const withSys = [{ role: "system", content: ident.systemPrompt(def.label, a.email) }, ...messages];
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const local = lastUser ? ident.identityAnswer(def.label, lastUser.content, a.email) : null;

  let content, promptTokens = 0, completionTokens = 0, charged = 0;
  if (local) {
    content = local;
    promptTokens = estimateTokens(lastUser.content);
    completionTokens = estimateTokens(content);
  } else {
    if (!def.free) {
      const bal = await lib.getCredits(a.uid);
      if (bal < 1) throw { code: 402, message: `Insufficient credits for ${def.label}. Buy credits to continue.`, credits: bal };
    }
    const r = await callUpstream(def, withSys, {
      max_tokens: body.max_tokens, temperature: body.temperature, top_p: body.top_p,
    });
    content = r.content; promptTokens = r.promptTokens; completionTokens = r.completionTokens;
    if (!def.free) {
      const total = promptTokens + completionTokens;
      charged = Math.max(1, Math.ceil(total / 1000) * def.rate);
      try { await lib.addCredits(a.uid, -charged, "api-use", { model: slug }); }
      catch (e) { throw { code: 402, message: "Insufficient credits.", credits: 0 }; }
    }
  }

  const total = promptTokens + completionTokens, ms = Date.now() - t0;
  await bumpCounters(a, total, charged);
  await lib.logUsage(a.uid, { ts: Date.now(), model: slug, tokens: total, ms,
    status: 200, credits: charged, keyId: a.key ? a.key.id : null }).catch(() => {});
  await lib.fireEvent(a.uid, "request.completed",
    { model: slug, label: def.label, tokens: total, credits: charged, ms }).catch(() => {});
  if (!def.free) {
    try { await lib.maybeLowCreditAlert(a.uid, await lib.getCredits(a.uid)); } catch (e) {}
  }
  return { content, promptTokens, completionTokens, totalTokens: total, charged, ms,
    label: def.label, slug };
}

module.exports = { callUpstream, runChat, checkKeyLimits, checkSpendCap, bumpCounters, estimateTokens, needEnv };

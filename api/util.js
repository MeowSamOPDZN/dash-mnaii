/* /api/util — small utilities router (keeps us under Vercel's function cap).
   Rewrites map the public URLs here:
     POST /api/estimate -> ?do=estimate   (no auth: token + credit estimate)
     GET/POST /api/share -> ?do=share     (share playground chats)
     GET /api/export     -> ?do=export    (usage CSV download, Firebase login) */
const lib = require("./_lib");
const chat = require("./_chat");
const crypto = require("crypto");

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") { lib.cors(res); res.status(200).end(); return; }
  if (!lib.backendReady()) return lib.json(res, 503, { error: "Backend not configured." });
  const job = req.query.do;

  if (job === "estimate" && req.method === "POST") {
    const body = await lib.readBody(req);
    const slug = String(body.model || "mnai6").toLowerCase();
    const def = lib.MODELS[slug];
    if (!def) return lib.json(res, 404, { error: "Unknown model." });
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const inTok = chat.estimateTokens(JSON.stringify(messages));
    const outTok = Math.min(body.max_tokens || 1024, 4096);
    const total = inTok + outTok;
    const credits = def.free ? 0 : Math.max(1, Math.ceil(total / 1000) * def.rate);
    return lib.json(res, 200, { model: def.label, slug, free: def.free,
      estimated_tokens: total, estimated_credits: credits, rate: def.free ? 0 : def.rate });
  }

  if (job === "share") {
    if (req.method === "GET") {
      const id = String(req.query.id || "");
      const d = await lib.db().collection("shares").doc(id).get().catch(() => null);
      if (!d || !d.exists) return lib.json(res, 404, { error: "Share not found." });
      const s = d.data();
      const m = lib.MODELS[s.model];
      return lib.json(res, 200, { id, model: s.model, label: m ? m.label : s.model,
        messages: s.messages || [], createdAt: s.createdAt });
    }
    if (req.method === "POST") {
      let a;
      try { a = await lib.requireFirebase(req); }
      catch (e) { return lib.json(res, lib.errCode(e), { error: e.message }); }
      const body = await lib.readBody(req);
      const slug = String(body.model || "");
      if (!lib.MODELS[slug]) return lib.json(res, 400, { error: "Unknown model." });
      const messages = (body.messages || []).filter((m) => m && (m.role === "user" || m.role === "assistant") && m.content)
        .slice(-20).map((m) => ({ role: m.role, content: String(m.content).slice(0, 6000) }));
      if (!messages.length) return lib.json(res, 400, { error: "Nothing to share." });
      const id = crypto.randomBytes(6).toString("hex");
      await lib.db().collection("shares").doc(id).set({
        uid: a.uid, model: slug, messages, createdAt: Date.now(),
      });
      return lib.json(res, 200, { id, url: "https://dash-mnaii.vercel.app/#/share/" + id });
    }
    return lib.json(res, 405, { error: "Method not allowed." });
  }

  if (job === "export" && req.method === "GET") {
    let a;
    try { a = await lib.requireFirebase(req); }
    catch (e) { return lib.json(res, lib.errCode(e), { error: e.message }); }
    const days = Math.min(Math.max(parseInt(req.query.days || "30", 10) || 30, 1), 90);
    const series = await lib.usageSeries(a.uid, days);
    const rows = [["date", "requests", "tokens", "credits_used", "errors"]];
    series.forEach((d) => rows.push([d.date, d.requests, d.tokens, d.credits, d.errors]));
    lib.cors(res);
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="mnai-usage-${days}d.csv"`);
    return res.end(rows.map((r) => r.join(",")).join("\n"));
  }

  return lib.json(res, 404, { error: "Unknown util job." });
};

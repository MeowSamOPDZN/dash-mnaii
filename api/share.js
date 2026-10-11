/* /api/share — share playground conversations via public link.
   POST {model, messages[]} (auth) -> { id, url }
   GET ?id= (public) -> { model, label, messages } */
const lib = require("./_lib");
const crypto = require("crypto");

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") { lib.cors(res); res.status(200).end(); return; }
  if (!lib.backendReady()) return lib.json(res, 503, { error: "Backend not configured." });

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
};

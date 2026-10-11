/* POST /api/batch — run up to 10 chat requests in one call.
   Body: { requests: [{ model: "<slug>", messages, max_tokens?, temperature? }] }
   Auth: Firebase ID token or API key. Credits/quotas apply per request. */
const lib = require("./_lib");
const chat = require("./_chat");

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") { lib.cors(res); res.status(200).end(); return; }
  if (req.method !== "POST") return lib.json(res, 405, { error: "Use POST." });
  if (!lib.backendReady()) return lib.json(res, 503, { error: "Backend not configured." });
  let a;
  try { a = await lib.authReq(req); }
  catch (e) { return lib.json(res, lib.errCode(e), { error: e.message }); }
  const body = await lib.readBody(req);
  const list = Array.isArray(body.requests) ? body.requests.slice(0, 10) : [];
  if (!list.length) return lib.json(res, 400, { error: "Body needs requests: [{model, messages}]. Max 10." });

  const results = await Promise.all(list.map(async (rq, i) => {
    try {
      const slug = String(rq.model || "mnai6").toLowerCase();
      const r = await chat.runChat(a, slug, rq || {}, req);
      return { index: i, ok: true, model: r.label, content: r.content,
        usage: { total_tokens: r.totalTokens }, credits_charged: r.charged };
    } catch (e) {
      return { index: i, ok: false, error: e.message || "Failed." };
    }
  }));
  lib.json(res, 200, { results });
};

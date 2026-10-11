/* /api/notifications — in-app notification bell. Auth: Firebase ID token.
   GET -> { notifications: [{ts, text, kind, read}], unread }
   POST {action:"read"} -> mark all read */
const lib = require("./_lib");

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") { lib.cors(res); res.status(200).end(); return; }
  if (!lib.backendReady()) return lib.json(res, 503, { error: "Backend not configured." });
  let a;
  try { a = await lib.requireFirebase(req); }
  catch (e) { return lib.json(res, lib.errCode(e), { error: e.message }); }
  const ref = lib.db().collection("dashUsers").doc(a.uid);

  if (req.method === "GET") {
    const s = await ref.get();
    const n = (s.exists && s.data().notifications) || [];
    return lib.json(res, 200, { notifications: n, unread: n.filter((x) => !x.read).length });
  }
  if (req.method === "POST") {
    const s = await ref.get();
    const n = ((s.exists && s.data().notifications) || []).map((x) => ({ ...x, read: true }));
    await ref.set({ notifications: n }, { merge: true });
    return lib.json(res, 200, { ok: true });
  }
  return lib.json(res, 405, { error: "Method not allowed." });
};

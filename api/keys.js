/* /api/keys — API key management. Auth: Firebase ID token.
   GET  -> list keys (masked)
   POST {name, kind: "free"|"pro"} -> create, returns full secret ONCE
   DELETE ?id= -> revoke */
const lib = require("./_lib");

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") { lib.cors(res); res.status(200).end(); return; }
  if (!lib.backendReady()) return lib.json(res, 503, { error: "Backend not configured (FIREBASE_SERVICE_ACCOUNT)." });
  let a;
  try { a = await lib.requireFirebase(req); }
  catch (e) { return lib.json(res, lib.errCode(e), { error: e.message }); }
  const db = lib.db();

  if (req.method === "GET") {
    const snap = await db.collection("apiKeys").where("uid", "==", a.uid)
      .orderBy("createdAt", "desc").get().catch(async () => db.collection("apiKeys").where("uid", "==", a.uid).get());
    const keys = snap.docs.map((d) => {
      const k = d.data();
      return { id: d.id, name: k.name, kind: k.kind, masked: lib.maskKey(k.prefix, k.last4),
        createdAt: k.createdAt, lastUsedAt: k.lastUsedAt || 0, revoked: !!k.revoked,
        requests: k.requests || 0, tokens: k.tokens || 0, creditsUsed: k.creditsUsed || 0 };
    });
    return lib.json(res, 200, { keys });
  }

  if (req.method === "POST") {
    const body = await lib.readBody(req);
    const name = String(body.name || "Untitled key").slice(0, 60);
    const kind = body.kind === "pro" ? "pro" : "free";
    const secret = lib.genKey(kind);
    const prefix = kind === "free" ? "mnai-free-sk-" : "mnai_sk_";
    const num = (v) => { const n = parseInt(v, 10); return n > 0 ? n : null; };
    const doc = await db.collection("apiKeys").add({
      uid: a.uid, email: a.email, name, kind, prefix,
      hash: lib.sha256(secret), last4: secret.slice(-4),
      createdAt: Date.now(), lastUsedAt: 0, revoked: false,
      requests: 0, tokens: 0, creditsUsed: 0,
      quotaMonthly: num(body.quotaMonthly), ratePerMin: num(body.ratePerMin),
      ipAllowlist: String(body.ipAllowlist || "").slice(0, 300),
    });
    await lib.fireEvent(a.uid, "key.created", { name, kind }).catch(() => {});
    return lib.json(res, 200, {
      id: doc.id, name, kind, secret,
      warning: "Copy this key now — it will never be shown again.",
    });
  }

  if (req.method === "PUT") {
    const body = await lib.readBody(req);
    const id = String(body.id || "");
    if (!id) return lib.json(res, 400, { error: "Missing id." });
    const ref = db.collection("apiKeys").doc(id);
    const s = await ref.get();
    if (!s.exists || s.data().uid !== a.uid) return lib.json(res, 404, { error: "Key not found." });
    const num = (v) => { const n = parseInt(v, 10); return n > 0 ? n : null; };
    const up = {};
    if (body.name != null) up.name = String(body.name).slice(0, 60);
    if (body.quotaMonthly !== undefined) up.quotaMonthly = num(body.quotaMonthly);
    if (body.ratePerMin !== undefined) up.ratePerMin = num(body.ratePerMin);
    if (body.ipAllowlist !== undefined) up.ipAllowlist = String(body.ipAllowlist).slice(0, 300);
    if (body.regenerate) {
      const secret = lib.genKey(s.data().kind);
      up.hash = lib.sha256(secret);
      up.last4 = secret.slice(-4);
      up.createdAt = Date.now();
      await ref.set(up, { merge: true });
      return lib.json(res, 200, { regenerated: true, secret,
        warning: "Copy this key now — it will never be shown again." });
    }
    await ref.set(up, { merge: true });
    return lib.json(res, 200, { updated: true });
  }

  if (req.method === "DELETE") {
    const id = String(req.query.id || "");
    if (!id) return lib.json(res, 400, { error: "Missing ?id=" });
    const ref = db.collection("apiKeys").doc(id);
    const s = await ref.get();
    if (!s.exists || s.data().uid !== a.uid) return lib.json(res, 404, { error: "Key not found." });
    await ref.set({ revoked: true }, { merge: true });
    return lib.json(res, 200, { revoked: true });
  }

  return lib.json(res, 405, { error: "Method not allowed." });
};

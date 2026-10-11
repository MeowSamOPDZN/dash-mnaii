/* GET /api/me — profile: credits, usage series, recent logs, keys count.
   Auth: Firebase ID token. */
const lib = require("./_lib");

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") { lib.cors(res); res.status(200).end(); return; }
  if (!lib.backendReady()) return lib.json(res, 503, { error: "Backend not configured (FIREBASE_SERVICE_ACCOUNT)." });

  // via rewrite: /api/notifications -> /api/me?do=notifications
  if (req.query.do === "notifications") {
    try {
      const a = await lib.requireFirebase(req);
      const ref = lib.db().collection("dashUsers").doc(a.uid);
      if (req.method === "POST") {
        const s = await ref.get();
        const n = ((s.exists && s.data().notifications) || []).map((x) => ({ ...x, read: true }));
        await ref.set({ notifications: n }, { merge: true });
        return lib.json(res, 200, { ok: true });
      }
      const s = await ref.get();
      const n = (s.exists && s.data().notifications) || [];
      return lib.json(res, 200, { notifications: n, unread: n.filter((x) => !x.read).length });
    } catch (e) { return lib.json(res, lib.errCode(e), { error: e.message }); }
  }

  try {
    const a = await lib.requireFirebase(req);
    const db = lib.db();
    const uref = db.collection("dashUsers").doc(a.uid);
    const snap = await uref.get();
    const u = snap.exists ? snap.data() : { credits: 0, recentLogs: [] };
    const keysSnap = await db.collection("apiKeys").where("uid", "==", a.uid).get();
    const keys = keysSnap.docs.map((d) => {
      const k = d.data();
      return { id: d.id, name: k.name, kind: k.kind, masked: lib.maskKey(k.prefix, k.last4),
        createdAt: k.createdAt, lastUsedAt: k.lastUsedAt || 0, revoked: !!k.revoked,
        requests: k.requests || 0, tokens: k.tokens || 0, creditsUsed: k.creditsUsed || 0,
        quotaMonthly: k.quotaMonthly || null, ratePerMin: k.ratePerMin || null,
        ipAllowlist: k.ipAllowlist || "" };
    });
    const series = await lib.usageSeries(a.uid, 30);
    const ledgerSnap = await uref.collection("ledger").orderBy("ts", "desc").limit(20).get().catch(() => ({ docs: [] }));
    lib.json(res, 200, {
      uid: a.uid, email: a.email,
      credits: u.credits || 0,
      spendCap: u.spendCap || null,
      alertWebhook: u.alertWebhook || "",
      keys, usage30d: series,
      recentLogs: u.recentLogs || [],
      ledger: ledgerSnap.docs.map((d) => d.data()),
      notifications: u.notifications || [],
      unread: (u.notifications || []).filter((x) => !x.read).length,
    });
  } catch (e) {
    lib.json(res, lib.errCode(e), { error: e.message || "Server error." });
  }
};

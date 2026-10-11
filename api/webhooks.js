/* /api/webhooks — manage webhook subscriptions. Auth: Firebase ID token.
   GET            -> list hooks (+ recent deliveries)
   POST {url, events[]} -> create (returns secret for signature verification)
   POST {test: hookId}  -> send a test event
   DELETE ?id=   -> delete */
const lib = require("./_lib");
const crypto = require("crypto");

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") { lib.cors(res); res.status(200).end(); return; }
  if (!lib.backendReady()) return lib.json(res, 503, { error: "Backend not configured." });
  let a;
  try { a = await lib.requireFirebase(req); }
  catch (e) { return lib.json(res, lib.errCode(e), { error: e.message }); }
  const db = lib.db();

  if (req.method === "GET") {
    const snap = await db.collection("webhooks").where("uid", "==", a.uid).get();
    const hooks = [];
    for (const d of snap.docs) {
      const h = d.data();
      const dels = await d.ref.collection("deliveries").orderBy("ts", "desc").limit(10).get().catch(() => ({ docs: [] }));
      hooks.push({ id: d.id, url: h.url, events: h.events || [], active: h.active !== false,
        createdAt: h.createdAt,
        deliveries: dels.docs.map((x) => x.data()) });
    }
    return lib.json(res, 200, { hooks, availableEvents: lib.WEBHOOK_EVENTS });
  }

  if (req.method === "POST") {
    const body = await lib.readBody(req);
    // test delivery
    if (body.test) {
      const d = await db.collection("webhooks").doc(String(body.test)).get();
      if (!d.exists || d.data().uid !== a.uid) return lib.json(res, 404, { error: "Webhook not found." });
      const h = d.data();
      const r = await lib.deliverWebhook(d.id, h, { event: "webhook.test", ts: Date.now(),
        data: { message: "This is a test delivery from MNAI Console." } }, true);
      return lib.json(res, 200, { delivered: r.ok, status: r.status, error: r.error || null });
    }
    const url = String(body.url || "").trim();
    if (!/^https:\/\/.+/.test(url)) return lib.json(res, 400, { error: "URL must start with https://" });
    const events = (body.events || []).filter((e) => lib.WEBHOOK_EVENTS.includes(e));
    if (!events.length) return lib.json(res, 400, { error: "Pick at least one event." });
    const secret = "whsec_" + crypto.randomBytes(24).toString("hex");
    const doc = await db.collection("webhooks").add({
      uid: a.uid, url, events, secret, active: true, createdAt: Date.now(),
    });
    await lib.notify(a.uid, `Webhook created for ${url}`, "info");
    return lib.json(res, 200, { id: doc.id, url, events, secret,
      note: "Save the secret — it's used to sign deliveries (X-MNAI-Signature)." });
  }

  if (req.method === "DELETE") {
    const id = String(req.query.id || "");
    const ref = db.collection("webhooks").doc(id);
    const s = await ref.get();
    if (!s.exists || s.data().uid !== a.uid) return lib.json(res, 404, { error: "Webhook not found." });
    await ref.delete();
    return lib.json(res, 200, { deleted: true });
  }

  return lib.json(res, 405, { error: "Method not allowed." });
};

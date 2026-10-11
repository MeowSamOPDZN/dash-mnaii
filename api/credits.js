/* /api/credits — wallet. Auth: Firebase ID token.
   GET  -> { credits, packs, ledger }
   POST { packId } -> creates a Razorpay order for the pack (needs
          RAZORPAY_KEY_ID + RAZORPAY_KEY_SECRET env). Frontend opens
          Razorpay checkout, then POSTs to /api/verify-payment. */
const lib = require("./_lib");
const https = require("https");

function rzp(path, keyId, keySecret, data) {
  return new Promise((resolve, reject) => {
    const body = data ? JSON.stringify(data) : "";
    const req = https.request({
      hostname: "api.razorpay.com", path, method: data ? "POST" : "GET",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      auth: keyId + ":" + keySecret,
    }, (res) => {
      let s = "";
      res.on("data", (c) => (s += c));
      res.on("end", () => { try { resolve({ code: res.statusCode, body: JSON.parse(s) }); }
        catch { resolve({ code: res.statusCode, body: { raw: s } }); } });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") { lib.cors(res); res.status(200).end(); return; }
  if (!lib.backendReady()) return lib.json(res, 503, { error: "Backend not configured (FIREBASE_SERVICE_ACCOUNT)." });
  let a;
  try { a = await lib.requireFirebase(req); }
  catch (e) { return lib.json(res, lib.errCode(e), { error: e.message }); }
  await lib.ensureUser(a.uid, a.email, "");

  if (req.method === "GET") {
    const db = lib.db();
    const uref = db.collection("dashUsers").doc(a.uid);
    const snap = await uref.get();
    const ledger = await uref.collection("ledger").orderBy("ts", "desc").limit(20).get().catch(() => ({ docs: [] }));
    return lib.json(res, 200, {
      credits: (snap.data() && snap.data().credits) || 0,
      packs: lib.CREDIT_PACKS,
      paymentsConfigured: !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET),
      razorpayKeyId: process.env.RAZORPAY_KEY_ID || null,
      ledger: ledger.docs.map((d) => d.data()),
    });
  }

  if (req.method === "POST") {
    const keyId = process.env.RAZORPAY_KEY_ID, keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keyId || !keySecret)
      return lib.json(res, 501, { error: "Payments are not configured yet (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET)." });
    const body = await lib.readBody(req);
    const pack = lib.CREDIT_PACKS.find((p) => p.id === body.packId);
    if (!pack) return lib.json(res, 400, { error: "Unknown pack." });
    const receipt = "mnai_" + a.uid.slice(0, 8) + "_" + Date.now().toString(36);
    const r = await rzp("/v1/orders", keyId, keySecret, {
      amount: pack.amount, currency: "INR", receipt,
      notes: { uid: a.uid, packId: pack.id, credits: String(pack.credits) },
    }).catch(() => null);
    if (!r || r.code >= 300 || !r.body.id)
      return lib.json(res, 502, { error: "Could not create payment order.", detail: r && r.body });
    return lib.json(res, 200, {
      orderId: r.body.id, amount: pack.amount, currency: "INR",
      packId: pack.id, credits: pack.credits, keyId,
    });
  }

  return lib.json(res, 405, { error: "Method not allowed." });
};

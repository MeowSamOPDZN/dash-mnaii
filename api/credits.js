/* /api/credits — wallet. Auth: Firebase ID token.
   GET  -> { credits, packs, ledger }
   POST { packId } -> creates a Razorpay order for the pack (needs
          RAZORPAY_KEY_ID + RAZORPAY_KEY_SECRET env). Frontend opens
          Razorpay checkout, then POSTs to /api/verify-payment. */
const lib = require("./_lib");
const https = require("https");
const crypto = require("crypto");

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

  // via rewrite: /api/verify-payment -> /api/credits?do=verify (POST)
  if (req.query.do === "verify" && req.method === "POST") {
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keySecret) return lib.json(res, 501, { error: "Payments are not configured yet." });
    const body = await lib.readBody(req);
    const { orderId, paymentId, signature, packId } = body;
    const pack = lib.CREDIT_PACKS.find((p) => p.id === packId);
    if (!orderId || !paymentId || !signature || !pack)
      return lib.json(res, 400, { error: "Missing payment fields." });
    const expected = crypto.createHmac("sha256", keySecret).update(orderId + "|" + paymentId).digest("hex");
    if (expected !== signature) return lib.json(res, 400, { error: "Payment verification failed." });
    const db = lib.db();
    const dup = await db.collection("dashUsers").doc(a.uid).collection("ledger")
      .where("meta.paymentId", "==", paymentId).limit(1).get().catch(() => ({ empty: true }));
    if (!dup.empty) {
      const credits = await lib.getCredits(a.uid);
      return lib.json(res, 200, { credited: false, credits, note: "Already credited." });
    }
    const credits = await lib.addCredits(a.uid, pack.credits, "purchase", { paymentId, orderId, packId });
    return lib.json(res, 200, { credited: true, credits });
  }

  // via rewrite: /api/voucher -> /api/credits?do=voucher (POST {code})
  if (req.query.do === "voucher" && req.method === "POST") {
    const body = await lib.readBody(req);
    try {
      const code = String(body.code || "").trim();
      const amount = lib.VOUCHERS[code] || 0;
      const credits = await lib.redeemVoucher(a.uid, code);
      await lib.fireEvent(a.uid, "voucher.redeemed", { code, credits }).catch(() => {});
      await lib.notify(a.uid, `Voucher redeemed: +${amount} credits (balance ${credits}).`, "info").catch(() => {});
      return lib.json(res, 200, { redeemed: true, credits });
    } catch (e) {
      return lib.json(res, lib.errCode(e), { error: e.message || "Could not redeem voucher." });
    }
  }

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

  if (req.method === "PUT") {
    // update settings: { spendCap } or { alertWebhook }
    const body = await lib.readBody(req);
    const up = {};
    if (body.spendCap !== undefined) {
      const n = parseInt(body.spendCap, 10);
      up.spendCap = n > 0 ? n : null;
    }
    if (body.alertWebhook !== undefined) {
      const u = String(body.alertWebhook || "").trim().slice(0, 300);
      if (u && !/^https:\/\/.+/.test(u)) return lib.json(res, 400, { error: "Webhook URL must start with https://" });
      up.alertWebhook = u;
    }
    if (!Object.keys(up).length && !body.testAlert) return lib.json(res, 400, { error: "Nothing to update." });
    if (Object.keys(up).length) await lib.db().collection("dashUsers").doc(a.uid).set(up, { merge: true });
    if (body.testAlert) {
      const url = up.alertWebhook !== undefined ? up.alertWebhook
        : ((await lib.db().collection("dashUsers").doc(a.uid).get()).data() || {}).alertWebhook;
      if (!url) return lib.json(res, 400, { error: "Save an alert webhook URL first." });
      try {
        await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: ":white_check_mark: MNAI API: test alert — your integration works!" }) });
      } catch (e) { return lib.json(res, 502, { error: "Could not reach that URL: " + String(e.message || e).slice(0, 120) }); }
      return lib.json(res, 200, { sent: true });
    }
    const credits = await lib.getCredits(a.uid);
    return lib.json(res, 200, { updated: true, credits });
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

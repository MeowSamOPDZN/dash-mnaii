/* POST /api/verify-payment — verify Razorpay signature, credit wallet.
   Body: { orderId, paymentId, signature, packId }. Auth: Firebase ID token. */
const lib = require("./_lib");
const crypto = require("crypto");

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") { lib.cors(res); res.status(200).end(); return; }
  if (req.method !== "POST") return lib.json(res, 405, { error: "Method not allowed." });
  if (!lib.backendReady()) return lib.json(res, 503, { error: "Backend not configured (FIREBASE_SERVICE_ACCOUNT)." });
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keySecret) return lib.json(res, 501, { error: "Payments are not configured yet." });
  let a;
  try { a = await lib.requireFirebase(req); }
  catch (e) { return lib.json(res, e.code || 500, { error: e.message }); }

  const body = await lib.readBody(req);
  const { orderId, paymentId, signature, packId } = body;
  const pack = lib.CREDIT_PACKS.find((p) => p.id === packId);
  if (!orderId || !paymentId || !signature || !pack)
    return lib.json(res, 400, { error: "Missing payment fields." });

  const expected = crypto.createHmac("sha256", keySecret).update(orderId + "|" + paymentId).digest("hex");
  if (expected !== signature) return lib.json(res, 400, { error: "Payment verification failed." });

  // idempotency: don't credit the same payment twice
  const db = lib.db();
  const dup = await db.collection("dashUsers").doc(a.uid).collection("ledger")
    .where("meta.paymentId", "==", paymentId).limit(1).get().catch(() => ({ empty: true }));
  if (!dup.empty) {
    const credits = await lib.getCredits(a.uid);
    return lib.json(res, 200, { credited: false, credits, note: "Already credited." });
  }
  await lib.ensureUser(a.uid, a.email, "");
  const credits = await lib.addCredits(a.uid, pack.credits, "purchase", { paymentId, orderId, packId });
  lib.json(res, 200, { credited: true, credits });
};

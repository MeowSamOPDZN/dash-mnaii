/* POST /api/voucher — redeem a voucher code for free credits.
   Body: { code }. Auth: Firebase ID token. Each code once per user. */
const lib = require("./_lib");

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") { lib.cors(res); res.status(200).end(); return; }
  if (req.method !== "POST") return lib.json(res, 405, { error: "Use POST." });
  if (!lib.backendReady()) return lib.json(res, 503, { error: "Backend not configured (FIREBASE_SERVICE_ACCOUNT)." });
  let a;
  try { a = await lib.requireFirebase(req); }
  catch (e) { return lib.json(res, lib.errCode(e), { error: e.message }); }
  const body = await lib.readBody(req);
  try {
    await lib.ensureUser(a.uid, a.email, "");
    const credits = await lib.redeemVoucher(a.uid, body.code);
    lib.json(res, 200, { redeemed: true, credits });
  } catch (e) {
    lib.json(res, lib.errCode(e), { error: e.message || "Could not redeem voucher." });
  }
};

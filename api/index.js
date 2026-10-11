/* GET /api — API directory */
const { json, publicCatalog, backendReady } = require("./_lib");

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") { require("./_lib").cors(res); res.status(200).end(); return; }
  const lib = require("./_lib");
  let probeErr = null;
  try { probeErr = lib.backendReady() ? await lib.adminProbe() : "FIREBASE_SERVICE_ACCOUNT is not set"; }
  catch (e) { probeErr = "probe-crash: " + (e.message || String(e)); }
  json(res, 200, {
    name: "MNAI API",
    by: "MeowSamOP DZN",
    backend: probeErr ? "error" : "connected",
    backendError: probeErr,
    endpoints: {
      "GET /api/models": "List all models (free vs credit-based).",
      "POST /api/mnaiapi/:model": "Chat with a model. Body: {messages:[{role,content}], stream?}. Auth: Bearer <Firebase ID token | mnai_sk_… | mnai-free-sk-…>.",
      "GET /api/me": "Your profile: credits, usage, recent logs. (Firebase login)",
      "GET/POST /api/keys": "List / create API keys. (Firebase login)",
      "DELETE /api/keys?id=…": "Revoke a key. (Firebase login)",
      "GET/POST /api/credits": "Balance, packs, and buy credits. (Firebase login)",
      "POST /api/voucher": "Redeem a voucher code for free credits. Body: {code}. (Firebase login)",
      "POST /api/verify-payment": "Verify a Razorpay payment and credit the wallet.",
    },
    keyTypes: {
      "mnai-free-sk-…": "Free models only (MNAI 6, MNAI 7, Glyph 1, Glyph 1.5).",
      "mnai_sk_…": "All models — credit-based models deduct credits from your wallet.",
    },
    models: publicCatalog(),
  });
};

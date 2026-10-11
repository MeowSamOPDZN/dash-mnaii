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
    serviceAccountProject: lib.serviceAccountProject(),
    endpoints: {
      "GET /api/models": "List all models (free vs credit-based).",
      "POST /api/mnaiapi/:model": "Chat with a model. Body: {messages:[{role,content}], stream?}. Auth: Bearer <Firebase ID token | mnai_sk_… | mnai-free-sk-…>.",
      "GET /api/me": "Your profile: credits, usage, recent logs, notifications. (Firebase login)",
      "GET/POST /api/keys": "List / create API keys. PUT edits quotas/limits or regenerates. (Firebase login)",
      "DELETE /api/keys?id=…": "Revoke a key. (Firebase login)",
      "GET/POST/PUT /api/credits": "Balance, packs, buy credits; PUT sets spend cap / alert webhook. (Firebase login)",
      "POST /api/voucher": "Redeem a voucher code for free credits. Body: {code}. (Firebase login)",
      "GET/POST/DELETE /api/webhooks": "Manage webhook subscriptions + test deliveries. (Firebase login)",
      "POST /api/mcp": "MCP JSON-RPC endpoint — every model as a tool. (Bearer token)",
      "POST /api/v1/chat/completions": "OpenAI-compatible chat. Body: {model, messages}. (Bearer token)",
      "POST /api/batch": "Up to 10 chat requests in one call. (Bearer token)",
      "POST /api/estimate": "Estimate tokens + credit cost without calling. (no auth)",
      "GET/POST /api/share": "Share playground chats via public link.",
      "GET /api/export?days=30": "Download usage as CSV. (Firebase login)",
      "GET/POST /api/notifications": "In-app notifications. (Firebase login)",
      "POST /api/verify-payment": "Verify a Razorpay payment and credit the wallet.",
    },
    keyTypes: {
      "mnai-free-sk-…": "Free models only (MNAI 6, MNAI 7, Glyph 1, Glyph 1.5).",
      "mnai_sk_…": "All models — credit-based models deduct credits from your wallet.",
    },
    models: publicCatalog(),
  });
};

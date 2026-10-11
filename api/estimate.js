/* POST /api/estimate — estimate tokens + credit cost WITHOUT calling the model.
   Body: { model: "<slug>", messages } -> { tokens, credits, free } */
const lib = require("./_lib");
const chat = require("./_chat");

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") { lib.cors(res); res.status(200).end(); return; }
  if (req.method !== "POST") return lib.json(res, 405, { error: "Use POST." });
  const body = await lib.readBody(req);
  const slug = String(body.model || "mnai6").toLowerCase();
  const def = lib.MODELS[slug];
  if (!def) return lib.json(res, 404, { error: "Unknown model." });
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const inTok = chat.estimateTokens(JSON.stringify(messages));
  const outTok = Math.min(body.max_tokens || 1024, 4096);
  const total = inTok + outTok;
  const credits = def.free ? 0 : Math.max(1, Math.ceil(total / 1000) * def.rate);
  lib.json(res, 200, { model: def.label, slug, free: def.free,
    estimated_tokens: total, estimated_credits: credits, rate: def.free ? 0 : def.rate });
};

/* POST /api/v1/chat/completions — OpenAI-compatible alias.
   Body: { model: "<slug or label>", messages, stream?, max_tokens?, temperature?, top_p? }
   Lets any OpenAI client point at the MNAI API by just changing base_url. */
const lib = require("../_lib");
const chat = require("../_chat");

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") { lib.cors(res); res.status(200).end(); return; }
  if (req.method !== "POST") return lib.json(res, 405, { error: "Use POST." });
  if (!lib.backendReady()) return lib.json(res, 503, { error: "Backend not configured." });

  let a;
  try { a = await lib.authReq(req); }
  catch (e) { return lib.json(res, lib.errCode(e), { error: e.message }); }
  const body = await lib.readBody(req);

  const want = String(body.model || "mnai6").toLowerCase();
  const slug = lib.MODELS[want] ? want
    : Object.keys(lib.MODELS).find((s) => lib.MODELS[s].label.toLowerCase() === want);
  if (!slug) return lib.json(res, 404, { error: `Unknown model "${body.model}".`, models: lib.publicCatalog() });

  if (body.stream) {
    // delegate to the canonical endpoint's streaming is complex here; do SSE manually via runChat? No — non-stream only.
    return lib.json(res, 400, { error: "Use POST /api/mnaiapi/:model with stream:true for streaming." });
  }
  try {
    const r = await chat.runChat(a, slug, body, req);
    let credits = null;
    try { credits = await lib.getCredits(a.uid); } catch (e) {}
    lib.json(res, 200, {
      id: "chatcmpl-" + Date.now().toString(36),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: slug,
      choices: [{ index: 0, message: { role: "assistant", content: r.content }, finish_reason: "stop" }],
      usage: { prompt_tokens: r.promptTokens, completion_tokens: r.completionTokens, total_tokens: r.totalTokens },
      credits_charged: r.charged, credits_balance: credits,
    });
  } catch (e) {
    return lib.json(res, lib.errCode(e), { error: e.message || "AI error." });
  }
};

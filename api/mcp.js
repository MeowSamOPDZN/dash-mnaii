/* POST /api/mcp — MCP (Model Context Protocol) JSON-RPC endpoint.
   Exposes every MNAI model as a tool: chat_with_<slug>.
   Auth: Authorization: Bearer <Firebase ID token | mnai_sk_… | mnai-free-sk-…>
   Methods: initialize, notifications/initialized, tools/list, tools/call, ping */
const lib = require("./_lib");
const chat = require("./_chat");

const toolName = (slug) => "chat_with_" + slug.replace(/[^a-z0-9]/g, "_");

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") { lib.cors(res); res.status(200).end(); return; }
  if (req.method !== "POST") return lib.json(res, 405, { error: "Use POST." });
  if (!lib.backendReady()) return lib.json(res, 503, { error: "Backend not configured." });

  // via rewrite: /api/batch -> /api/mcp?do=batch — up to 10 chat requests in one call
  if (req.query.do === "batch") {
    let a;
    try { a = await lib.authReq(req); }
    catch (e) { return lib.json(res, lib.errCode(e), { error: e.message }); }
    const body = await lib.readBody(req);
    const list = Array.isArray(body.requests) ? body.requests.slice(0, 10) : [];
    if (!list.length) return lib.json(res, 400, { error: "Body needs requests: [{model, messages}]. Max 10." });
    const results = await Promise.all(list.map(async (rq, i) => {
      try {
        const slug = String(rq.model || "mnai6").toLowerCase();
        const r = await chat.runChat(a, slug, rq || {}, req);
        return { index: i, ok: true, model: r.label, content: r.content,
          usage: { total_tokens: r.totalTokens }, credits_charged: r.charged };
      } catch (e) {
        return { index: i, ok: false, error: e.message || "Failed." };
      }
    }));
    return lib.json(res, 200, { results });
  }

  // via rewrite: /api/v1/chat/completions -> /api/mcp?do=v1chat — OpenAI-compatible alias
  if (req.query.do === "v1chat") {
    let a;
    try { a = await lib.authReq(req); }
    catch (e) { return lib.json(res, lib.errCode(e), { error: e.message }); }
    const body = await lib.readBody(req);
    const want = String(body.model || "mnai6").toLowerCase();
    const slug = lib.MODELS[want] ? want
      : Object.keys(lib.MODELS).find((s) => lib.MODELS[s].label.toLowerCase() === want);
    if (!slug) return lib.json(res, 404, { error: `Unknown model "${body.model}".`, models: lib.publicCatalog() });
    if (body.stream)
      return lib.json(res, 400, { error: "Use POST /api/mnaiapi/:model with stream:true for streaming." });
    try {
      const r = await chat.runChat(a, slug, body, req);
      let credits = null;
      try { credits = await lib.getCredits(a.uid); } catch (e) {}
      return lib.json(res, 200, {
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
  }

  // ---- MCP JSON-RPC ----
  const body = await lib.readBody(req);
  const reply = (result) => lib.json(res, 200, { jsonrpc: "2.0", id: body.id == null ? null : body.id, result });
  const fail = (code, message) => lib.json(res, 200, { jsonrpc: "2.0", id: body.id == null ? null : body.id,
    error: { code, message } });

  const method = body.method;
  if (method === "initialize")
    return reply({ protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "MNAI API", version: "2.0" } });
  if (method === "notifications/initialized" || method === "ping") return reply({});
  if (method === "tools/list") {
    return reply({ tools: lib.publicCatalog().map((m) => ({
      name: toolName(m.slug),
      description: `${m.label} — ${m.blurb} ${m.free ? "(free)" : `(uses ${m.rate} credits/1K tokens)`}. Made by MeowSamOP DZN.`,
      inputSchema: { type: "object",
        properties: {
          message: { type: "string", description: "The user message." },
          system: { type: "string", description: "Optional system instruction." },
          max_tokens: { type: "number", description: "Max tokens (default 1024)." },
        },
        required: ["message"] },
    })) });
  }
  if (method === "tools/call") {
    const name = body.params && body.params.name;
    const args = (body.params && body.params.arguments) || {};
    const slug = Object.keys(lib.MODELS).find((s) => toolName(s) === name);
    if (!slug) return fail(-32602, "Unknown tool: " + name);
    if (!args.message) return fail(-32602, "Missing required argument: message.");
    let a;
    try { a = await lib.authReq(req); }
    catch (e) { return fail(-32000, "Auth failed: " + e.message); }
    try {
      const messages = [];
      if (args.system) messages.push({ role: "system", content: String(args.system).slice(0, 2000) });
      messages.push({ role: "user", content: String(args.message).slice(0, 12000) });
      const r = await chat.runChat(a, slug, { messages, max_tokens: args.max_tokens }, req);
      return reply({ content: [{ type: "text",
        text: r.content + `\n\n[${r.totalTokens} tokens${r.charged ? ` · ${r.charged} credits` : ""}]` }] });
    } catch (e) { return fail(-32000, e.message || "Chat failed."); }
  }
  return fail(-32601, "Method not found: " + method);
};

/* POST /api/mcp — MCP (Model Context Protocol) JSON-RPC endpoint.
   Exposes every MNAI model as a tool: chat_with_<slug>.
   Auth: Authorization: Bearer <Firebase ID token | mnai_sk_… | mnai-free-sk-…>
   Methods: initialize, notifications/initialized, tools/list, tools/call, ping */
const lib = require("./_lib");
const chat = require("./_chat");

const toolName = (slug) => "chat_with_" + slug.replace(/[^a-z0-9]/g, "_");

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") { lib.cors(res); res.status(200).end(); return; }
  if (req.method !== "POST") return lib.json(res, 405, { error: "Use POST with JSON-RPC 2.0." });
  if (!lib.backendReady()) return lib.json(res, 503, { error: "Backend not configured." });

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

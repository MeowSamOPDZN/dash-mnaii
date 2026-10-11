/* GET /api/export?days=30&format=csv — download usage as CSV. Auth: Firebase ID token. */
const lib = require("./_lib");

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") { lib.cors(res); res.status(200).end(); return; }
  if (req.method !== "GET") return lib.json(res, 405, { error: "Use GET." });
  if (!lib.backendReady()) return lib.json(res, 503, { error: "Backend not configured." });
  let a;
  try { a = await lib.requireFirebase(req); }
  catch (e) { return lib.json(res, lib.errCode(e), { error: e.message }); }
  const days = Math.min(Math.max(parseInt(req.query.days || "30", 10) || 30, 1), 90);
  const series = await lib.usageSeries(a.uid, days);
  const rows = [["date", "requests", "tokens", "credits_used", "errors"]];
  series.forEach((d) => rows.push([d.date, d.requests, d.tokens, d.credits, d.errors]));
  const csv = rows.map((r) => r.join(",")).join("\n");
  lib.cors(res);
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="mnai-usage-${days}d.csv"`);
  res.end(csv);
};

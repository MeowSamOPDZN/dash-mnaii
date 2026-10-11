/* GET /api/models — public model catalog */
const lib = require("./_lib");

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") { lib.cors(res); res.status(200).end(); return; }
  if (req.method !== "GET") return lib.json(res, 405, { error: "Method not allowed." });
  lib.json(res, 200, { models: lib.publicCatalog() });
};

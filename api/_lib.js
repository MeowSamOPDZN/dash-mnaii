/* MNAI Console API — shared backend library.
   Models, auth (Firebase ID tokens + mnai API keys), credits, usage. */
const crypto = require("crypto");

let _admin = null;
function admin() {
  if (_admin) return _admin;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT env var is not set");
  let svc;
  try { svc = JSON.parse(raw); }
  catch { throw new Error("FIREBASE_SERVICE_ACCOUNT is not valid JSON (paste the whole file content)."); }
  if (svc.private_key) svc.private_key = svc.private_key.replace(/\\n/g, "\n");
  if (!svc.project_id || !svc.private_key || !svc.client_email)
    throw new Error("FIREBASE_SERVICE_ACCOUNT JSON is missing project_id / private_key / client_email.");
  const adm = require("firebase-admin");
  if (!adm.apps.length) adm.initializeApp({ credential: adm.credential.cert(svc) });
  _admin = adm;
  return adm;
}
/* Safe probe: returns null when admin init + Firestore work, else the failing step + message. */
async function adminProbe() {
  try { admin(); }
  catch (e) { return "init: " + (e.message || String(e)); }
  try { await db().collection("apiKeys").limit(1).get(); return null; }
  catch (e) { return "firestore: " + (e.message || String(e)); }
}
function db() { return admin().firestore(); }
function backendReady() { return !!process.env.FIREBASE_SERVICE_ACCOUNT; }

/* ---------------- model catalog (single source of truth) ---------------- */
const MODELS = {
  "mnai6":   { label: "MNAI 6",      free: true,  provider: "xkiro",     model: "mistralai/mistral-large-2512",
               blurb: "Fast, sharp everyday chat. The free default." },
  "mnai7":   { label: "MNAI 7",      free: true,  provider: "xkiro",     model: "qwen/qwen3.8-omni-flash:free",
               blurb: "Quick multimodal chat, free for everyone." },
  "glyph1":  { label: "Glyph 1",     free: true,  provider: "nara",      model: "nemotron-3-ultra-free",
               blurb: "Free chat via NaraRouter. Chat-only." },
  "glyph15": { label: "Glyph 1.5",   free: true,  provider: "inception", model: "mercury-2.5",
               blurb: "Free chat via Inception Labs. Chat-only." },
  "mnai61":  { label: "MNAI 6.1 Pro", free: false, rate: 2, provider: "xkiro", model: "mistralai/mistral-large-4-0",
               blurb: "Most capable Mistral-class chat. Costs credits." },
  "mnai7pro":{ label: "MNAI 7 Pro",  free: false, rate: 3, provider: "xkiro", model: "qwen/qwen3.8-max:free",
               blurb: "Best model right now. Costs credits." },
  "glyph2":  { label: "Glyph 2",     free: false, rate: 2, provider: "xkiro", model: "qwen/qwen3.8-omni-flash:free",
               blurb: "Glyph series chat. Costs credits." },
  "glyph25": { label: "Glyph 2.5",   free: false, rate: 3, provider: "openrouter", model: "nvidia/nemotron-3-ultra-550b-a55b:free",
               blurb: "550B-class reasoning. Costs credits." },
  "glyph3":  { label: "Glyph 3",     free: false, rate: 3, provider: "xkiro2", model: "stealth/space-bunny-alpha:free",
               blurb: "Stealth-tier chat. Costs credits." },
};
function publicCatalog() {
  return Object.entries(MODELS).map(([slug, m]) => ({
    slug, label: m.label, free: m.free, rate: m.free ? 0 : m.rate, blurb: m.blurb,
  }));
}

/* ---------------- http helpers ---------------- */
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,X-API-Key");
}
function json(res, code, obj) {
  cors(res);
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === "object") return resolve(req.body);
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => { try { resolve(s ? JSON.parse(s) : {}); } catch { resolve({}); } });
  });
}

/* ---------------- keys ---------------- */
function sha256(s) { return crypto.createHash("sha256").update(s).digest("hex"); }
function genKey(kind) {
  const prefix = kind === "free" ? "mnai-free-sk-" : "mnai_sk_";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const buf = crypto.randomBytes(32);
  let r = "";
  for (const b of buf) r += chars[b % 62];
  return prefix + r;
}
async function findKey(secret) {
  const h = sha256(secret);
  const snap = await db().collection("apiKeys").where("hash", "==", h).limit(1).get();
  if (snap.empty) return null;
  const d = snap.docs[0];
  return { id: d.id, ...d.data() };
}
function maskKey(prefix, last4) { return prefix + "••••" + last4; }

/* ---------------- auth ----------------
   Returns { uid, email, via: "firebase"|"apikey", key } or throws {code, message}. */
async function authReq(req) {
  const hdr = req.headers.authorization || req.headers["x-api-key"] || "";
  const token = hdr.replace(/^Bearer\s+/i, "").trim();
  if (!token) throw { code: 401, message: "Missing Authorization bearer token (Firebase ID token or API key)." };
  if (token.startsWith("mnai-free-sk-") || token.startsWith("mnai_sk_")) {
    const k = await findKey(token);
    if (!k) throw { code: 401, message: "Invalid API key." };
    if (k.revoked) throw { code: 401, message: "This API key has been revoked." };
    return { uid: k.uid, email: k.email || "", via: "apikey", key: k };
  }
  try {
    const decoded = await admin().auth().verifyIdToken(token);
    return { uid: decoded.uid, email: decoded.email || "", via: "firebase", key: null };
  } catch {
    throw { code: 401, message: "Invalid or expired login token. Sign in again." };
  }
}
async function requireFirebase(req) {
  const a = await authReq(req);
  if (a.via !== "firebase") throw { code: 401, message: "This endpoint needs a signed-in user (Firebase login)." };
  return a;
}

/* ---------------- users / credits ---------------- */
async function ensureUser(uid, email, name) {
  const ref = db().collection("dashUsers").doc(uid);
  const snap = await ref.get();
  if (!snap.exists) {
    await ref.set({ email: email || "", name: name || "", credits: 0,
      createdAt: Date.now(), recentLogs: [] });
    return { credits: 0 };
  }
  return snap.data();
}
async function getCredits(uid) {
  const snap = await db().collection("dashUsers").doc(uid).get();
  return snap.exists ? (snap.data().credits || 0) : 0;
}
async function addCredits(uid, delta, reason, meta) {
  const ref = db().collection("dashUsers").doc(uid);
  const out = await db().runTransaction(async (t) => {
    const s = await t.get(ref);
    const cur = s.exists ? (s.data().credits || 0) : 0;
    const next = cur + delta;
    if (next < 0) throw { code: 402, message: "Insufficient credits." };
    t.set(ref, { credits: next }, { merge: true });
    const lid = ref.collection("ledger").doc().id;
    t.set(ref.collection("ledger").doc(lid),
      { ts: Date.now(), delta, balance: next, reason, meta: meta || {} });
    return next;
  });
  return out;
}
const CREDIT_PACKS = [
  { id: "p100",  credits: 100,  amount: 2900,  label: "100 credits" },
  { id: "p550",  credits: 550,  amount: 14900, label: "550 credits" },
  { id: "p1200", credits: 1200, amount: 29900, label: "1,200 credits" },
];

/* ---------------- usage ---------------- */
function dayKey(ts) {
  const d = new Date(ts);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
async function logUsage(uid, e) {
  const d = db();
  const dk = dayKey(e.ts);
  const dayRef = d.collection("usageDays").doc(uid + "_" + dk);
  const adm = admin();
  await dayRef.set({
    uid, date: dk,
    requests: adm.firestore.FieldValue.increment(1),
    tokens: adm.firestore.FieldValue.increment(e.tokens || 0),
    credits: adm.firestore.FieldValue.increment(e.credits || 0),
    errors: adm.firestore.FieldValue.increment(e.status >= 400 ? 1 : 0),
  }, { merge: true });
  // recent logs ring (max 40) on user doc
  const uref = d.collection("dashUsers").doc(uid);
  await d.runTransaction(async (t) => {
    const s = await t.get(uref);
    const logs = (s.exists && s.data().recentLogs) || [];
    logs.unshift({ ts: e.ts, model: e.model, tokens: e.tokens || 0, ms: e.ms || 0,
      status: e.status || 200, credits: e.credits || 0, keyId: e.keyId || null });
    t.set(uref, { recentLogs: logs.slice(0, 40) }, { merge: true });
  }).catch(() => {});
  // key counters
  if (e.keyId) {
    await d.collection("apiKeys").doc(e.keyId).set({
      lastUsedAt: e.ts,
      requests: adm.firestore.FieldValue.increment(1),
      tokens: adm.firestore.FieldValue.increment(e.tokens || 0),
      creditsUsed: adm.firestore.FieldValue.increment(e.credits || 0),
    }, { merge: true }).catch(() => {});
  }
}
async function usageSeries(uid, days) {
  const out = [];
  const now = Date.now();
  for (let i = days - 1; i >= 0; i--) {
    const dk = dayKey(now - i * 864e5);
    const s = await db().collection("usageDays").doc(uid + "_" + dk).get();
    const v = s.exists ? s.data() : {};
    out.push({ date: dk, requests: v.requests || 0, tokens: v.tokens || 0,
      credits: v.credits || 0, errors: v.errors || 0 });
  }
  return out;
}

module.exports = {
  admin, db, backendReady, MODELS, publicCatalog,
  cors, json, readBody, authReq, requireFirebase,
  sha256, genKey, findKey, maskKey,
  ensureUser, getCredits, addCredits, CREDIT_PACKS,
  logUsage, usageSeries, dayKey, adminProbe,
};

/* MNAI Console v2 — Firebase login + real backend (/api). */
"use strict";

/* ---------- utils ---------- */
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fmt = n => { n = +n || 0;
  if (n >= 1e9) return (n/1e9).toFixed(2)+"B";
  if (n >= 1e6) return (n/1e6).toFixed(2)+"M";
  if (n >= 1e3) return (n/1e3).toFixed(1)+"K";
  return String(Math.round(n)); };
const fmtInt = n => Math.round(+n || 0).toLocaleString("en-US");
const fmtDate = ts => new Date(ts).toLocaleDateString("en-US",{month:"short",day:"numeric"});
function timeAgo(ts){ const s=Math.floor((Date.now()-ts)/1000);
  if (s<10) return "just now"; if (s<60) return s+"s ago";
  const m=Math.floor(s/60); if (m<60) return m+"m ago";
  const h=Math.floor(m/60); if (h<24) return h+"h ago";
  const d=Math.floor(h/24); if (d<30) return d+"d ago";
  return new Date(ts).toLocaleDateString(); }
function toast(msg, kind){
  const el = document.createElement("div"); el.className = "toast";
  el.innerHTML = (kind === "err"
    ? '<svg viewBox="0 0 24 24" style="stroke:var(--red)"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5v.1"/></svg>'
    : '<svg viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg>')
    + "<span>"+esc(msg)+"</span>";
  $("#toasts").appendChild(el);
  setTimeout(()=>{ el.style.opacity="0"; el.style.transition="opacity .3s"; setTimeout(()=>el.remove(),320); }, 2800);
}
function copyText(t, msg){
  (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject())
    .then(()=>toast(msg || "Copied to clipboard"))
    .catch(()=>{ const ta=document.createElement("textarea"); ta.value=t; document.body.appendChild(ta);
      ta.select(); try{ document.execCommand("copy"); toast(msg||"Copied to clipboard"); }catch(e){ toast("Copy failed","err"); } ta.remove(); });
}

/* ---------- firebase ---------- */
const FIREBASE_CONFIG = {"apiKey":"AIzaSyC0xh1F3TUxbaVY0GDZTfEb4H82pxLBMQA","authDomain":"gl1tchbrainai.firebaseapp.com","projectId":"gl1tchbrainai","storageBucket":"gl1tchbrainai.firebasestorage.app","messagingSenderId":"139629266691","appId":"1:139629266691:web:f255525aeb72b3a3378b36","measurementId":"G-1QTLT0G99B"};
let AUTH = null, USER = null;
function initFirebase(){
  firebase.initializeApp(FIREBASE_CONFIG);
  AUTH = firebase.auth();
  AUTH.onAuthStateChanged(async (u) => {
    USER = u;
    if (u) {
      $("#loginOverlay").classList.add("hidden");
      const name = u.displayName || (u.email||"").split("@")[0] || "User";
      $("#sideName").textContent = name;
      $("#sideEmail").textContent = u.email || "";
      const av = (name[0]||"?").toUpperCase();
      $("#sideAvatar").textContent = av; $("#userAvatar").textContent = av;
      render(); // skeleton pass — instant paint while data loads
      await refreshAll();
      updateBell();
    } else if (currentRoute() !== "share") {
      $("#loginOverlay").classList.remove("hidden");
    }
  });
}
async function idToken(){ return USER ? USER.getIdToken(true) : null; }

/* ---------- api client ---------- */
async function api(path, opts){
  opts = opts || {};
  const headers = { "Content-Type": "application/json" };
  if (opts.auth !== false) {
    const t = await idToken();
    if (!t) throw new Error("Not signed in.");
    headers.Authorization = "Bearer " + t;
  }
  const r = await fetch(path, { method: opts.method || "GET", headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || ("Request failed ("+r.status+")")); e.code = r.status; e.data = j; throw e; }
  return j;
}

/* ---------- state ---------- */
let PROFILE = null;   // /api/me
let CATALOG = [];     // /api/models
try { const _cc = JSON.parse(localStorage.getItem("dashmnai.catalog") || "null");
  if (Array.isArray(_cc) && _cc.length) CATALOG = _cc; } catch(e){}
let THEME = localStorage.getItem("dashmnai.theme") || "dark";

async function refreshAll(){
  try {
    const [me, models, wh] = await Promise.all([
      api("/api/me"),
      api("/api/models", {auth:false}),
      api("/api/webhooks").catch(()=>null),
    ]);
    PROFILE = me; CATALOG = models.models || [];
    try { localStorage.setItem("dashmnai.catalog", JSON.stringify(CATALOG)); } catch(e){}
    if (wh) PROFILE.hookCount = (wh.hooks||[]).length;
  } catch (e) {
    // backend may not be configured yet
    PROFILE = PROFILE || { credits: 0, keys: [], usage30d: [], recentLogs: [], ledger: [] };
    try { const m = await api("/api/models", {auth:false}); CATALOG = m.models || []; } catch {}
    if (e && e.code === 503) toast("Backend not configured yet — add env vars in Vercel.", "err");
  }
  $("#creditsVal").textContent = fmtInt(PROFILE.credits || 0);
  render();
}

/* ---------- live updates: overview / usage / logs refresh themselves ---------- */
const LIVE_ROUTES = ["overview", "usage", "logs"];
let liveTimer = null;
async function pollLive(){
  if (document.hidden || !USER || !PROFILE) return;
  if (!LIVE_ROUTES.includes(currentRoute())) return;
  try {
    PROFILE = await api("/api/me");
    $("#creditsVal").textContent = fmtInt(PROFILE.credits || 0);
    const r = currentRoute(), route = ROUTES[r];
    if (!route) return;
    $("#page").innerHTML = route.page();
    if (route.mount) route.mount();
    $$("#nav a").forEach(a=>a.classList.toggle("active", a.dataset.route===r));
  } catch(e){ /* silent — retry on next tick */ }
}
function startLive(){
  if (liveTimer) return;
  liveTimer = setInterval(pollLive, 10000);
  document.addEventListener("visibilitychange", ()=>{ if (!document.hidden) pollLive(); });
}

/* ---------- charts (canvas, Vercel style) ---------- */
function setupCanvas(cv, h){
  const dpr = window.devicePixelRatio || 1, w = cv.clientWidth;
  cv.width = w*dpr; cv.height = h*dpr;
  const ctx = cv.getContext("2d"); ctx.scale(dpr,dpr);
  return { ctx, w, h };
}
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
function hexA(hex, a){
  hex = String(hex||"#888").replace("#","");
  if (hex.length === 3) hex = hex.split("").map(c=>c+c).join("");
  const r=parseInt(hex.slice(0,2),16), g=parseInt(hex.slice(2,4),16), b=parseInt(hex.slice(4,6),16);
  return `rgba(${r},${g},${b},${a})`;
}
function areaChart(cv, points, opts){
  opts = opts || {};
  if (!points.length) { cv.parentElement.innerHTML = '<div class="empty"><h3>No data yet</h3><p>Make some API calls first.</p></div>'; return; }
  const H = parseInt(getComputedStyle(cv).height) || 260;
  const { ctx, w, h } = setupCanvas(cv, H);
  const padL=46, padR=12, padT=14, padB=26, iw=w-padL-padR, ih=h-padT-padB;
  const vals = points.map(p=>p.v);
  let max = Math.max(...vals, 1) * 1.12;
  const X = i => padL + iw*i/(points.length-1), Y = v => padT + ih*(1-v/max);
  const accent = opts.color || css("--chart-line") || "#fff";
  const gridC = css("--border-soft") || "rgba(128,128,128,.15)", txtC = css("--text-3") || "#666";
  const step = Math.max(1, Math.floor(points.length/6));
  function draw(){
    ctx.clearRect(0,0,w,h); ctx.font = "10.5px Geist, sans-serif";
    for (let g=0; g<=4; g++){ const v=max*g/4, y=Y(v);
      ctx.strokeStyle=gridC; ctx.lineWidth=1; ctx.beginPath(); ctx.moveTo(padL,y); ctx.lineTo(w-padR,y); ctx.stroke();
      ctx.fillStyle=txtC; ctx.textAlign="right"; ctx.fillText(fmt(v), padL-8, y+3.5); }
    ctx.textAlign="center"; ctx.fillStyle=txtC;
    for (let i=0;i<points.length;i+=step) ctx.fillText(fmtDate(points[i].t), X(i), h-8);
    const gr=ctx.createLinearGradient(0,padT,0,h-padB);
    gr.addColorStop(0,hexA(accent,.22)); gr.addColorStop(1,hexA(accent,0));
    ctx.beginPath(); points.forEach((p,i)=> i?ctx.lineTo(X(i),Y(p.v)):ctx.moveTo(X(0),Y(p.v)));
    ctx.lineTo(X(points.length-1),h-padB); ctx.lineTo(X(0),h-padB); ctx.closePath(); ctx.fillStyle=gr; ctx.fill();
    ctx.beginPath(); points.forEach((p,i)=> i?ctx.lineTo(X(i),Y(p.v)):ctx.moveTo(X(0),Y(p.v)));
    ctx.strokeStyle=accent; ctx.lineWidth=2; ctx.lineJoin="round"; ctx.stroke();
  }
  draw();
  const tip = document.createElement("div"); tip.className="chart-tip";
  cv.parentElement.style.position="relative"; cv.parentElement.appendChild(tip);
  cv.onmousemove = e => {
    const r = cv.getBoundingClientRect(), mx = e.clientX - r.left;
    let i = Math.max(0, Math.min(points.length-1, Math.round((mx-padL)/iw*(points.length-1))));
    const p = points[i]; draw();
    ctx.strokeStyle=gridC; ctx.setLineDash([4,4]); ctx.beginPath(); ctx.moveTo(X(i),padT); ctx.lineTo(X(i),h-padB); ctx.stroke(); ctx.setLineDash([]);
    ctx.beginPath(); ctx.arc(X(i),Y(p.v),4,0,7); ctx.fillStyle=accent; ctx.fill();
    tip.style.display="block";
    tip.innerHTML = "<b>"+fmtInt(p.v)+"</b> "+esc(opts.label||"")+"<span>"+esc(p.label||"")+"</span>";
    tip.style.left = Math.min(Math.max(X(i)-60,4), w-160)+"px";
    tip.style.top = Math.max(Y(p.v)-64,0)+"px";
  };
  cv.onmouseleave = () => { tip.style.display="none"; draw(); };
}
function donutChart(cv, segments){
  const H=200, { ctx, w } = setupCanvas(cv, H);
  const cx=w/2, cy=H/2, R=78, r0=54;
  const total = segments.reduce((a,s)=>a+s.v,0) || 1;
  let a0=-Math.PI/2; ctx.clearRect(0,0,w,H);
  segments.forEach(s=>{ const a1=a0+(s.v/total)*Math.PI*2;
    ctx.beginPath(); ctx.arc(cx,cy,R,a0,a1); ctx.arc(cx,cy,r0,a1,a0,true); ctx.closePath();
    ctx.fillStyle=s.color; ctx.fill(); a0=a1; });
  ctx.fillStyle=css("--text"); ctx.textAlign="center"; ctx.font="700 22px Geist, sans-serif";
  ctx.fillText(fmt(total), cx, cy+2);
  ctx.font="11px Geist, sans-serif"; ctx.fillStyle=css("--text-3"); ctx.fillText("requests", cx, cy+20);
}

/* ---------- modal / palette ---------- */
function openModal(html){ $("#modal").innerHTML = html; $("#modalOverlay").classList.remove("hidden"); }
function closeModal(){ $("#modalOverlay").classList.add("hidden"); }

let palSel = 0;
function paletteCommands(){
  return [
    {group:"Go to", label:"Overview", hint:"⌘1", run:()=>location.hash="#/overview"},
    {group:"Go to", label:"Models", hint:"⌘2", run:()=>location.hash="#/models"},
    {group:"Go to", label:"Playground", hint:"⌘3", run:()=>location.hash="#/playground"},
    {group:"Go to", label:"Webhooks", hint:"⌘4", run:()=>location.hash="#/webhooks"},
    {group:"Go to", label:"Integrations", hint:"⌘5", run:()=>location.hash="#/integrations"},
    {group:"Go to", label:"Docs", hint:"⌘6", run:()=>location.hash="#/docs"},
    {group:"Go to", label:"API Keys", hint:"⌘7", run:()=>location.hash="#/keys"},
    {group:"Go to", label:"Usage", hint:"⌘8", run:()=>location.hash="#/usage"},
    {group:"Go to", label:"Logs", hint:"⌘9", run:()=>location.hash="#/logs"},
    {group:"Go to", label:"Settings", hint:"⌘0", run:()=>location.hash="#/settings"},
    {group:"Actions", label:"Create API key", run:()=>openCreateKey()},
    {group:"Actions", label:"Buy credits", run:()=>openBuyCredits()},
    {group:"Actions", label:"Try MNAI 6", run:()=>{ location.hash="#/playground?model=mnai6"; }},
    {group:"Actions", label:"Toggle theme", run:()=>cycleTheme()},
    {group:"Actions", label:"Sign out", run:()=>AUTH.signOut()},
  ];
}
function openPalette(){ $("#paletteOverlay").classList.remove("hidden"); $("#paletteInput").value=""; renderPalette(""); setTimeout(()=>$("#paletteInput").focus(),30); }
function closePalette(){ $("#paletteOverlay").classList.add("hidden"); }
function renderPalette(q){
  q=(q||"").toLowerCase();
  const cmds = paletteCommands().filter(c=>c.label.toLowerCase().includes(q));
  palSel=0; let html="", lg="";
  cmds.forEach(c=>{ if(c.group!==lg){ html+='<div class="pal-group">'+c.group+"</div>"; lg=c.group; }
    html+='<div class="pal-item" data-i="'+paletteCommands().indexOf(c)+'"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/></svg>'+esc(c.label)+(c.hint?'<span class="hint">'+c.hint+"</span>":"")+"</div>"; });
  $("#paletteList").innerHTML = html || '<div class="empty">No matches</div>';
  $$(".pal-item").forEach(el=>el.onclick=()=>{ closePalette(); paletteCommands()[+el.dataset.i].run(); });
  markPalSel();
}
function markPalSel(){ const items=$$(".pal-item");
  items.forEach((el,i)=>el.classList.toggle("sel",i===palSel));
  if (items[palSel] && items[palSel].scrollIntoView) items[palSel].scrollIntoView({block:"nearest"}); }

/* ---------- shared bits ---------- */
function modelBySlug(slug){ return CATALOG.find(m=>m.slug===slug) || { slug, label: slug, free: true }; }
function maskOf(k){ return esc(k.masked || ""); }
function statusBadge(k){
  if (k.revoked) return '<span class="badge red">Revoked</span>';
  return '<span class="badge green">Active</span>';
}
function freeBadge(m){
  const isNew = m.isNew ? '<span class="badge blue">NEW</span>' : '';
  return (m.free ? '<span class="badge green">FREE</span>'
    : '<span class="badge amber">'+m.rate+' credits / 1K tokens</span>') + isNew;
}
function deltaHTML(cur, prev, invert){
  if (prev == null || prev === 0) return '<span class="delta-flat">—</span>';
  const pct = (cur-prev)/prev*100, up = pct>=0;
  const good = invert ? !up : up;
  const cls = Math.abs(pct)<0.5 ? "delta-flat" : (good?"delta-up":"delta-down");
  return `<span class="${cls}">${Math.abs(pct)<0.5?"→":(up?"↑":"↓")} ${Math.abs(pct).toFixed(1)}% <span style="color:var(--text-3)">vs prior</span></span>`;
}
function bindCopy(root){
  $$("[data-copy]", root).forEach(b=>{ b.onclick=e=>{ e.stopPropagation(); copyText(b.dataset.copy); }; });
}

/* ---------- overview ---------- */
function pageOverview(){
  const onboard = onboardingCard();
  const s30 = PROFILE.usage30d || [];
  const sum = f => s30.reduce((a,d)=>a+(d[f]||0),0);
  const req=sum("requests"), tok=sum("tokens"), cred=sum("credits"), err=sum("errors");
  const half = Math.floor(s30.length/2);
  const prev = s30.slice(0,half), cur = s30.slice(half);
  const ps = f => prev.reduce((a,d)=>a+(d[f]||0),0), cs = f => cur.reduce((a,d)=>a+(d[f]||0),0);
  const act = (PROFILE.keys||[]).filter(k=>!k.revoked).length;
  const logs = (PROFILE.recentLogs||[]).slice(0,6);
  return `
  ${onboard}
  <div class="page-head"><div><h1>Overview</h1><p>Your MNAI API at a glance — last 30 days.</p></div>
    <div class="page-actions"><button class="btn primary" onclick="openPlayground(CATALOG.find(m=>m.slug==='mnai6')||{slug:'mnai6',label:'MNAI 6'})"><span>Try MNAI 6</span></button></div></div>
  <div class="grid stats">
    <div class="card stat"><div class="stat-label">Total requests</div><div class="stat-value">${fmt(req)}</div><div class="stat-delta">${deltaHTML(cs("requests"),ps("requests"))}</div></div>
    <div class="card stat"><div class="stat-label">Tokens processed</div><div class="stat-value">${fmt(tok)}</div><div class="stat-delta">${deltaHTML(cs("tokens"),ps("tokens"))}</div></div>
    <div class="card stat"><div class="stat-label">Credits used</div><div class="stat-value">${fmtInt(cred)}</div><div class="stat-delta"><span class="delta-flat">balance: ${fmtInt(PROFILE.credits||0)}</span></div></div>
    <div class="card stat"><div class="stat-label">Active API keys</div><div class="stat-value">${act}</div><div class="stat-delta"><span class="delta-flat">${(PROFILE.keys||[]).length-act} revoked</span></div></div>
  </div>
  <div class="grid cols-2">
    <div class="card"><div class="card-head"><h2>Requests</h2><span class="sub">per day</span></div><canvas class="chart" id="chReq"></canvas></div>
    <div class="card"><div class="card-head"><h2>Free vs credit models</h2><span class="sub">try them below</span></div>
      <div class="models-grid" style="grid-template-columns:1fr 1fr">
        ${(CATALOG.filter(m=>m.free).slice(0,2)).map(m=>`
          <div class="model-card"><div class="mc-top"><h3>${esc(m.label)}</h3>${freeBadge(m)}</div>
          <div class="blurb">${esc(m.blurb||"")}</div>
          <div class="mc-foot"><button class="btn sm primary" data-try="${m.slug}"><span>Try</span></button></div></div>`).join("")}
      </div>
      <div style="margin-top:12px"><a href="#/models" class="btn sm"><span>All ${CATALOG.length} models →</span></a></div>
    </div>
  </div>
  <div class="card" style="margin-top:16px"><div class="card-head"><h2>Recent activity</h2><div style="display:flex;align-items:center;gap:12px"><span class="live-tag" title="Updates automatically"><span class="live-dot"></span>Live</span><a href="#/logs" class="btn sm">View all logs</a></div></div>
    <div class="activity">${logs.length ? logs.map(logRow).join("") : '<div class="empty"><h3>No activity yet</h3><p>Call the API or try a model to see usage here.</p></div>'}</div></div>`;
}
function logRow(l){
  const m = modelBySlug(l.model);
  const ok = (l.status||200) < 400;
  return `<div class="act-row"><span class="act-dot" style="background:${ok?"var(--green)":"var(--red)"}"></span>
    <div><b class="mono">${esc(m.label)}</b> <span style="color:var(--text-3)">·</span>
    <span style="color:var(--text-2);font-size:12.5px">${fmtInt(l.tokens)} tokens · ${l.ms}ms${l.credits?` · <b style="color:var(--amber)">-${l.credits} cr</b>`:""}</span><br>
    <span class="${ok?"status-2xx":"status-4xx"}" style="font-size:12px">${l.status||200}</span>
    <span style="color:var(--text-3);font-size:12px"> · ${timeAgo(l.ts)}</span></div></div>`;
}
function mountOverview(){
  mountOnboarding();
  const pts = (PROFILE.usage30d||[]).map((d,i)=>({ t: Date.now()-(29-i)*864e5, v: d.requests||0, label: d.date }));
  areaChart($("#chReq"), pts, { label:"requests" });
  bindTry();
}
function bindTry(){
  $$("[data-try]").forEach(b=>b.onclick=()=>{ const m=modelBySlug(b.dataset.try); openPlayground(m); });
}

/* ---------- models ---------- */
function pageModels(){
  const free = CATALOG.filter(m=>m.free), pro = CATALOG.filter(m=>!m.free);
  const card = m => `
    <div class="model-card">
      <div class="mc-top"><h3>${esc(m.label)}</h3>${freeBadge(m)}</div>
      <div class="blurb">${esc(m.blurb||"")}</div>
      <pre class="api-hint"><code>POST /api/mnaiapi/${esc(m.slug)}</code><button class="copy-btn" data-copy="https://dash-mnaii.vercel.app/api/mnaiapi/${esc(m.slug)}" title="Copy endpoint URL"><svg viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 012-2h10"/></svg></button></pre>
      <div class="mc-foot">
        <span class="rate">${m.free ? "Free for everyone" : `Costs <b>${m.rate}</b> credits / 1K tokens`}</span>
        <button class="btn sm ${m.free?"primary":""}" data-try="${m.slug}"><span>Try</span></button>
      </div>
    </div>`;
  return `
  <div class="page-head"><div><h1>Models</h1><p>Every model on the MNAI API. Free models cost nothing — credit models deduct from your wallet.</p></div>
    <div class="page-actions"><button class="btn" onclick="openBuyCredits()"><span>Buy credits</span></button></div></div>
  <h3 style="font-size:13px;color:var(--text-2);margin:0 0 12px;text-transform:uppercase;letter-spacing:.06em">Free forever</h3>
  <div class="models-grid" style="margin-bottom:28px">${free.map(card).join("")}</div>
  <h3 style="font-size:13px;color:var(--text-2);margin:0 0 12px;text-transform:uppercase;letter-spacing:.06em">Credit-based</h3>
  <div class="models-grid">${pro.map(card).join("")}</div>
  <div class="card" style="margin-top:24px"><div class="card-head"><h2>Quick start</h2></div>
  <pre class="api-hint" style="margin:0"><code>curl -X POST https://dash-mnaii.vercel.app/api/mnaiapi/mnai6 \\
  -H "Authorization: Bearer YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"messages":[{"role":"user","content":"Hello!"}]}'</code><button class="copy-btn" data-copy="curl -X POST https://dash-mnaii.vercel.app/api/mnaiapi/mnai6 -H &quot;Authorization: Bearer YOUR_KEY&quot; -H &quot;Content-Type: application/json&quot; -d '{\"messages\":[{\"role\":\"user\",\"content\":\"Hello!\"}]}'"><svg viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 012-2h10"/></svg></button></pre>
  <p style="font-size:12.5px;color:var(--text-3);margin-top:10px">Use a <span class="mono">mnai-free-sk-…</span> key for free models, or a <span class="mono">mnai_sk_…</span> key for everything (credits apply). Every model answers as MNAI — made by MeowSamOP DZN.</p></div>`;
}
function mountModels(){ bindCopy($("#page")); bindTry(); }

/* ---------- keys ---------- */
function pageKeys(){
  const keys = PROFILE.keys || [];
  const rows = keys.map(k=>`
    <tr>
      <td><b>${esc(k.name)}</b><div style="color:var(--text-3);font-size:12px;margin-top:2px">${k.kind==="free"?'<span class="badge green">FREE KEY</span>':'<span class="badge amber">PRO KEY</span>'} · created ${timeAgo(k.createdAt)}</div></td>
      <td><span class="mono">${maskOf(k)}</span>${k.quotaMonthly||k.ratePerMin||k.ipAllowlist?`<div style="color:var(--text-3);font-size:11px;margin-top:2px">${[k.quotaMonthly?k.quotaMonthly+"/mo":"",k.ratePerMin?k.ratePerMin+"/min":"",k.ipAllowlist?"IP-locked":""].filter(Boolean).join(" · ")}</div>`:""}</td>
      <td class="mono">${fmt(k.requests||0)}</td>
      <td class="mono" style="color:var(--amber)">${fmtInt(k.creditsUsed||0)}</td>
      <td style="color:var(--text-3);font-size:12.5px">${k.lastUsedAt?timeAgo(k.lastUsedAt):"never"}</td>
      <td>${statusBadge(k)}</td>
      <td style="text-align:right;white-space:nowrap">${k.revoked?"":'<button class="btn sm" data-editkey="'+k.id+'">Edit</button> <button class="btn sm danger" data-revoke="'+k.id+'">Revoke</button>'}</td>
    </tr>`).join("");
  return `
  <div class="page-head"><div><h1>API Keys</h1><p>Free keys (<span class="mono">mnai-free-sk-…</span>) unlock free models only. Pro keys (<span class="mono">mnai_sk_…</span>) unlock everything with credits.</p></div>
    <div class="page-actions"><button class="btn primary" onclick="openCreateKey()"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg><span>New key</span></button></div></div>
  <div class="table-wrap"><table><thead><tr><th>Name</th><th>Key</th><th>Requests</th><th>Credits used</th><th>Last used</th><th>Status</th><th></th></tr></thead>
  <tbody>${rows}</tbody></table>
  ${keys.length?"":'<div class="empty"><svg viewBox="0 0 24 24"><circle cx="8" cy="15" r="4"/><path d="M11 12l9-9m-4 4l3 3"/></svg><h3>No API keys yet</h3><p>Create your first key to start calling the API.</p></div>'}</div>`;
}
function mountKeys(){
  $$("[data-editkey]").forEach(b=>b.onclick=()=>openEditKey((PROFILE.keys||[]).find(x=>x.id===b.dataset.editkey)));
  $$("[data-revoke]").forEach(b=>b.onclick=()=>{
    const k=(PROFILE.keys||[]).find(x=>x.id===b.dataset.revoke);
    openModal(`<div class="modal-head"><div><h2>Revoke key?</h2><p>“${esc(k.name)}” stops working immediately.</p></div><button class="modal-x" onclick="closeModal()">×</button></div>
      <div class="modal-foot"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn danger" id="cfRevoke">Revoke key</button></div>`);
    $("#cfRevoke").onclick=async()=>{
      $("#cfRevoke").disabled=true;
      try{ await api("/api/keys?id="+k.id,{method:"DELETE"}); toast("Key revoked"); closeModal(); await refreshAll(); }
      catch(e){ toast(e.message,"err"); $("#cfRevoke").disabled=false; }
    };
  });
}
let newKeyKind = "free";
function openCreateKey(){
  newKeyKind = "free";
  openModal(`
  <div class="modal-head"><div><h2>Create API key</h2><p>The full key is shown once — copy it immediately.</p></div><button class="modal-x" onclick="closeModal()">×</button></div>
  <div class="modal-body">
    <div class="field"><label>Key name</label><input type="text" id="nkName" placeholder="e.g. My website" maxlength="60"></div>
    <div class="field"><label>Limits <span style="color:var(--text-3);font-weight:400">(optional)</span></label>
      <div class="form-grid">
        <div class="field" style="margin:0"><label style="font-size:11.5px">Monthly quota</label><input type="number" id="nkQuota" placeholder="Unlimited" min="1"></div>
        <div class="field" style="margin:0"><label style="font-size:11.5px">Rate / minute</label><input type="number" id="nkRate" placeholder="Unlimited" min="1"></div>
        <div class="field full" style="margin:0"><label style="font-size:11.5px">IP allowlist</label><input type="text" id="nkIps" placeholder="e.g. 1.2.3.4, 5.6.7.8 — empty = anywhere"></div>
      </div></div>
    <div class="field"><label>Key type</label><div class="ktype-grid">
      <div class="ktype on" data-k="free"><b>Free key</b><span class="mono">mnai-free-sk-…</span><p>Free models only: MNAI 6, MNAI 7, Glyph 1, Glyph 1.5.</p></div>
      <div class="ktype" data-k="pro"><b>Pro key</b><span class="mono">mnai_sk_…</span><p>All models. Credit models deduct credits from your wallet.</p></div>
    </div></div>
  </div>
  <div class="modal-foot"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn blue" id="nkGo">Create key</button></div>`);
  $$(".ktype").forEach(el=>el.onclick=()=>{ newKeyKind=el.dataset.k; $$(".ktype").forEach(x=>x.classList.toggle("on",x===el)); });
  setTimeout(()=>{ const i=$("#nkName"); if(i&&document.contains(i)) i.focus(); },60);
  $("#nkGo").onclick=async()=>{
    const name=$("#nkName").value.trim()||"Untitled key";
    $("#nkGo").disabled=true; $("#nkGo").innerHTML='<span class="spin"></span>';
    try{
      const k=await api("/api/keys",{method:"POST",body:{name,kind:newKeyKind,
        quotaMonthly:$("#nkQuota").value||null, ratePerMin:$("#nkRate").value||null, ipAllowlist:$("#nkIps").value.trim()||""}});
      openModal(`
      <div class="modal-head"><div><h2>Key created</h2><p>Copy it now — you won't see it again.</p></div><button class="modal-x" onclick="closeModal()">×</button></div>
      <div class="modal-body">
        <div class="key-reveal"><code>${esc(k.secret)}</code><button class="copy-btn" id="rkCopy"><svg viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 012-2h10"/></svg></button></div>
        <div class="warn"><svg viewBox="0 0 24 24"><path d="M12 9v4m0 4v.1M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/></svg><span>Treat this like a password. Anyone with it can spend your credits.</span></div>
      </div>
      <div class="modal-foot"><button class="btn primary" id="rkDone">Done</button></div>`);
      $("#rkCopy").onclick=()=>copyText(k.secret,"API key copied");
      $("#rkDone").onclick=async()=>{ closeModal(); await refreshAll(); };
    }catch(e){ toast(e.message,"err"); $("#nkGo").disabled=false; $("#nkGo").textContent="Create key"; }
  };
}


function openEditKey(k){
  if (!k) return;
  openModal(`
  <div class="modal-head"><div><h2>Edit key</h2><p>“${esc(k.name)}” — limits apply instantly.</p></div><button class="modal-x" onclick="closeModal()">×</button></div>
  <div class="modal-body">
    <div class="field"><label>Key name</label><input type="text" id="ekName" value="${esc(k.name)}" maxlength="60"></div>
    <div class="form-grid">
      <div class="field" style="margin:0"><label>Monthly quota</label><input type="number" id="ekQuota" value="${k.quotaMonthly||""}" placeholder="Unlimited" min="1"></div>
      <div class="field" style="margin:0"><label>Rate / minute</label><input type="number" id="ekRate" value="${k.ratePerMin||""}" placeholder="Unlimited" min="1"></div>
      <div class="field full" style="margin:0"><label>IP allowlist</label><input type="text" id="ekIps" value="${esc(k.ipAllowlist||"")}" placeholder="empty = anywhere"></div>
    </div>
    <div class="warn" style="margin-top:14px"><svg viewBox="0 0 24 24"><path d="M12 9v4m0 4v.1M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/></svg><span>Regenerating replaces the key — the old one stops working immediately.</span></div>
  </div>
  <div class="modal-foot"><button class="btn" onclick="closeModal()">Cancel</button>
    <button class="btn danger" id="ekRegen">Regenerate</button>
    <button class="btn blue" id="ekSave">Save</button></div>`);
  $("#ekSave").onclick = async ()=>{
    $("#ekSave").disabled = true;
    try {
      await api("/api/keys",{method:"PUT",body:{id:k.id, name:$("#ekName").value.trim()||k.name,
        quotaMonthly:$("#ekQuota").value||null, ratePerMin:$("#ekRate").value||null, ipAllowlist:$("#ekIps").value.trim()}});
      toast("Key updated"); closeModal(); await refreshAll();
    } catch(e){ toast(e.message,"err"); $("#ekSave").disabled = false; }
  };
  $("#ekRegen").onclick = async ()=>{
    if (!confirm("Regenerate this key? The old key stops working immediately.")) return;
    $("#ekRegen").disabled = true;
    try {
      const r = await api("/api/keys",{method:"PUT",body:{id:k.id, regenerate:true}});
      openModal(`
      <div class="modal-head"><div><h2>Key regenerated</h2><p>Copy it now — you won't see it again.</p></div><button class="modal-x" onclick="closeModal()">×</button></div>
      <div class="modal-body"><div class="key-reveal"><code>${esc(r.secret)}</code><button class="copy-btn" id="rgCopy"><svg viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 012-2h10"/></svg></button></div></div>
      <div class="modal-foot"><button class="btn primary" id="rgDone">Done</button></div>`);
      $("#rgCopy").onclick = ()=>copyText(r.secret,"API key copied");
      $("#rgDone").onclick = async()=>{ closeModal(); await refreshAll(); };
    } catch(e){ toast(e.message,"err"); $("#ekRegen").disabled = false; }
  };
}

/* ---------- usage ---------- */
let usageRange="30D", usageMetric="requests";
function pageUsage(){
  return `
  <div class="page-head"><div><h1>Usage</h1><p>Requests, tokens and credits across your account.</p></div>
    <div class="page-actions">
      <button class="btn sm" id="csvBtn"><span>Export CSV</span></button><span class="live-tag" title="Updates automatically"><span class="live-dot"></span>Live</span>
      <div class="seg" id="uRange">${["7D","30D"].map(r=>`<button data-r="${r}" class="${r===usageRange?"on":""}">${r}</button>`).join("")}</div>
      <div class="seg" id="uMetric">${["requests","tokens","credits"].map(m=>`<button data-m="${m}" class="${m===usageMetric?"on":""}">${m[0].toUpperCase()+m.slice(1)}</button>`).join("")}</div>
    </div></div>
  <div class="card"><div class="card-head"><h2 id="uTitle"></h2><span class="sub" id="uTotal"></span></div><canvas class="chart" id="chUsage"></canvas></div>
  <div class="card" style="margin-top:16px"><div class="card-head"><h2>Usage by key</h2><span class="sub">all time</span></div><div id="keyBars"></div></div>`;
}
function mountUsage(){
  const draw=()=>{
    const days=usageRange==="7D"?7:30;
    const s=(PROFILE.usage30d||[]).slice(-days);
    const pts=s.map((d,i)=>({ t: Date.now()-(s.length-1-i)*864e5, v: d[usageMetric]||0, label: d.date }));
    const total=pts.reduce((a,p)=>a+p.v,0);
    $("#uTitle").textContent=`${usageMetric[0].toUpperCase()+usageMetric.slice(1)} — last ${days} days`;
    $("#uTotal").textContent=fmtInt(total)+" total";
    areaChart($("#chUsage"), pts, { label: usageMetric, color: usageMetric==="credits" ? "#f5a623" : "#0070f3" });
  };
  draw();
  const cb = $("#csvBtn"); if (cb) cb.onclick = async ()=>{
    try {
      const t = await idToken();
      const r = await fetch("/api/export?days="+(usageRange==="7D"?7:30),
        { headers: { Authorization: "Bearer "+t } });
      if (!r.ok) throw new Error("Export failed ("+r.status+")");
      const blob = await r.blob(), a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = "mnai-usage.csv"; a.click();
      setTimeout(()=>URL.revokeObjectURL(a.href), 5000);
      toast("CSV downloaded");
    } catch(e){ toast(e.message,"err"); }
  };
  $$("#uRange button").forEach(b=>b.onclick=()=>{ usageRange=b.dataset.r; $$("#uRange button").forEach(x=>x.classList.toggle("on",x===b)); draw(); });
  $$("#uMetric button").forEach(b=>b.onclick=()=>{ usageMetric=b.dataset.m; $$("#uMetric button").forEach(x=>x.classList.toggle("on",x===b)); draw(); });
  const ks=[...(PROFILE.keys||[])].sort((a,b)=>(b.requests||0)-(a.requests||0));
  const max=Math.max(...ks.map(k=>k.requests||0),1);
  $("#keyBars").innerHTML=ks.map(k=>`
    <div class="bar-row"><div class="bar-label">${esc(k.name)}<span class="mono">${maskOf(k)}</span></div>
    <div class="bar-track"><div class="bar-fill" style="width:${((k.requests||0)/max*100).toFixed(1)}%"></div></div>
    <span class="bar-val">${fmt(k.requests||0)} req</span></div>`).join("")
    || '<div class="empty"><h3>No usage yet</h3></div>';
}

/* ---------- logs ---------- */
function pageLogs(){
  const logs=PROFILE.recentLogs||[];
  return `
  <div class="page-head"><div><h1>Logs</h1><p>Your recent API requests, newest first.</p></div><div class="page-actions"><span class="live-tag" title="Updates automatically"><span class="live-dot"></span>Live</span></div></div>
  <div class="table-wrap"><table><thead><tr><th>Time</th><th>Model</th><th>Tokens</th><th>Latency</th><th>Credits</th><th>Status</th></tr></thead>
  <tbody>${logs.map(l=>{ const m=modelBySlug(l.model), ok=(l.status||200)<400;
    return `<tr><td style="color:var(--text-3);font-size:12.5px;white-space:nowrap">${new Date(l.ts).toLocaleString()}</td>
    <td><span class="mono">${esc(m.label)}</span></td><td class="mono">${fmtInt(l.tokens)}</td><td class="mono">${l.ms}ms</td>
    <td class="mono" style="color:${l.credits?"var(--amber)":"var(--text-3)"}">${l.credits?"-"+l.credits:"0"}</td>
    <td><span class="${ok?"status-2xx":"status-4xx"}">${l.status||200}</span></td></tr>`; }).join("")}
  </tbody></table>${logs.length?"":'<div class="empty"><h3>No logs yet</h3><p>Try a model or call the API.</p></div>'}</div>`;
}
function mountLogs(){}

/* ---------- settings ---------- */
function voucherListHTML(){
  const claimed = (PROFILE.redeemedVouchers || []);
  const ledger = (PROFILE.ledger || []).filter(e=>e.reason==="voucher");
  if (!claimed.length && !ledger.length)
    return '<p style="color:var(--text-3);font-size:12.5px;margin:4px 0 0">No vouchers claimed yet.</p>';
  const rows = claimed.map(code=>{
    const entry = ledger.find(e=>e.meta && e.meta.code===code);
    const when = entry ? new Date(entry.ts).toLocaleDateString() : "";
    const amt = entry ? `+${fmtInt(entry.delta)} credits` : "";
    return `<div class="ledger-row"><div><span class="mono">${esc(code)}</span> <span class="badge green">Claimed</span><small>${amt}${when?" · "+when:""}</small></div></div>`;
  }).join("");
  return `<div style="font-size:12px;color:var(--text-3);margin:10px 0 2px;font-weight:700;text-transform:uppercase;letter-spacing:.06em">Your vouchers</div>${rows}`;
}
function pageSettings(){
  const t=THEME;
  const ledger=(PROFILE.ledger||[]).slice(0,10);
  return `
  <div class="page-head"><div><h1>Settings</h1><p>Console preferences, wallet and account.</p></div></div>
  <div class="settings-grid">
    <div class="card"><div class="card-head"><h2>Wallet</h2><button class="btn sm blue" onclick="openBuyCredits()"><span>Buy credits</span></button></div>
      <div class="row-between"><div><div class="t">Balance</div><div class="d">Credits pay for pro models.</div></div><b style="font-size:20px;font-variant-numeric:tabular-nums">${fmtInt(PROFILE.credits||0)}</b></div>
      <div class="row-between"><div><div class="t">Monthly spend cap</div><div class="d">Stop credit models after this many credits/month. Empty = unlimited.</div></div>
        <div style="display:flex;gap:8px"><input type="number" id="spendCapInput" placeholder="Unlimited" min="1" value="${PROFILE.spendCap||""}" style="width:110px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-size:13px;padding:8px 12px;outline:none"><button class="btn sm" id="spendCapBtn">Save</button></div></div>
      <div class="row-between"><div><div class="t">Redeem voucher</div><div class="d">Have a code? Get free credits.</div></div>
        <div style="display:flex;gap:8px"><input type="text" id="voucherInput" placeholder="Enter code" style="width:130px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-size:13px;padding:8px 12px;outline:none;font-family:var(--mono)"><button class="btn sm" id="voucherBtn">Redeem</button></div></div>
      <div id="voucherList">${voucherListHTML()}</div>
      ${ledger.map(e=>`<div class="ledger-row"><div>${esc(e.reason||"")}<small>${new Date(e.ts).toLocaleString()}</small></div><span class="${e.delta>=0?"pos":"neg"}">${e.delta>=0?"+":""}${e.delta}</span></div>`).join("") || '<p style="color:var(--text-3);font-size:13px">No transactions yet.</p>'}
    </div>
    <div class="card"><div class="card-head"><h2>Appearance</h2></div>
      <div class="theme-pick">${["dark","light","system"].map(x=>`
        <div class="theme-opt ${t===x?"on":""}" data-theme-pick="${x}">
          <div class="theme-swatch" style="background:${x==="dark"?"#000":x==="light"?"#fff":"linear-gradient(135deg,#000 50%,#fff 50%)"}"></div>
          ${x[0].toUpperCase()+x.slice(1)}</div>`).join("")}</div></div>
    <div class="card"><div class="card-head"><h2>Account</h2></div>
      <div class="row-between"><div><div class="t">${esc(USER.displayName||USER.email||"User")}</div><div class="d mono">${esc(USER.email||"")}</div></div></div>
      <div class="row-between"><div><div class="t">Sign out</div><div class="d">End this session.</div></div><button class="btn sm" id="signOutBtn">Sign out</button></div>
    </div>
  </div>`;
}
function mountSettings(){
  $$("[data-theme-pick]").forEach(el=>el.onclick=()=>{ setTheme(el.dataset.themePick); render(); });
  $("#signOutBtn").onclick=()=>AUTH.signOut();
  const doRedeem = async ()=>{
    const code = $("#voucherInput").value.trim();
    if (!code) { toast("Enter a voucher code.", "err"); return; }
    $("#voucherBtn").disabled = true;
    try {
      const r = await api("/api/voucher", { method: "POST", body: { code } });
      toast(`Voucher redeemed! +${fmtInt(r.credits - (PROFILE.credits||0))} credits.`);
      $("#voucherInput").value = "";
      await refreshAll();
    } catch(e){ toast(e.message, "err"); $("#voucherBtn").disabled = false; }
  };
  $("#voucherBtn").onclick = doRedeem;
  $("#spendCapBtn").onclick = async ()=>{
    $("#spendCapBtn").disabled = true;
    try { await api("/api/credits",{method:"PUT",body:{spendCap:$("#spendCapInput").value||null}});
      toast("Spend cap updated"); await refreshAll(); }
    catch(e){ toast(e.message,"err"); $("#spendCapBtn").disabled = false; }
  };
  $("#voucherInput").addEventListener("keydown", e=>{ if(e.key==="Enter") doRedeem(); });
}
function setTheme(t){ THEME=t; localStorage.setItem("dashmnai.theme",t); applyTheme(); }
function cycleTheme(){ setTheme(THEME==="dark"?"light":THEME==="light"?"system":"dark"); render(); }
function applyTheme(){
  let t=THEME; if(t==="system") t=matchMedia("(prefers-color-scheme: light)").matches?"light":"dark";
  document.documentElement.dataset.theme=t;
}

/* ---------- playground (full page, pro) ---------- */
let PG = { slug: "mnai6", cmp: null, temp: 0.7, maxTok: 1024, sys: "",
           hist: {}, abort: null, busy: false };
function pgHist(slug){ return PG.hist[slug] || (PG.hist[slug] = []); }
function pgOpts(){ return { temperature: PG.temp, max_tokens: PG.maxTok }; }

/* inline SVG icons */
const SVG = {
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2.5"/></svg>',
  regen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.5 9a9 9 0 0114.9-3.4L23 10"/><path d="M1 14l4.6 4.4A9 9 0 0020.5 15"/></svg>',
  share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/></svg>',
  code: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 18l6-6-6-6"/><path d="M8 6l-6 6 6 6"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 012-2h10"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6"/></svg>',
  sliders: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 21v-7"/><path d="M4 10V3"/><path d="M12 21v-9"/><path d="M12 8V3"/><path d="M20 21v-5"/><path d="M20 12V3"/><path d="M1 14h6"/><path d="M9 8h6"/><path d="M17 16h6"/></svg>',
  cols: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 3v18"/></svg>',
  bolt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>',
  spark: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.1 7.9L22 12l-7.9 2.1L12 22l-2.1-7.9L2 12l7.9-2.1z"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>',
};

function pagePlayground(){
  const q = new URLSearchParams((location.hash.split("?")[1]||""));
  const fromQ = q.get("model");
  if (fromQ && CATALOG.some(m=>m.slug===fromQ)) PG.slug = fromQ;
  const def = CATALOG.find(m=>m.slug===PG.slug) || CATALOG[0] || {slug:"mnai6",label:"MNAI 6",free:true,rate:0};
  const cmpDef = PG.cmp ? CATALOG.find(m=>m.slug===PG.cmp) : null;
  const opt = (sel)=>CATALOG.map(m=>`<option value="${m.slug}"${m.slug===sel?" selected":""}>${esc(m.label)}${m.free?"":" · "+m.rate+"cr"}</option>`).join("");
  return `
  <div class="pg-shell">
    <div class="pg-head">
      <div class="pg-model">
        <span class="pg-avatar">${SVG.spark}</span>
        <div><h1>${esc(def.label)}</h1><p>${esc(def.blurb||"")}</p></div>
        ${def.free?'<span class="badge green">FREE</span>':`<span class="badge amber">${def.rate} credits / 1K</span>`}
        ${def.isNew?'<span class="badge blue">NEW</span>':''}
      </div>
      <div class="pg-tools">
        <button class="pg-iconbtn" id="pgShareBtn" title="Share chat link">${SVG.share}</button>
        <button class="pg-iconbtn" id="pgSnippetBtn" title="Copy code snippet">${SVG.code}</button>
        <button class="pg-iconbtn" id="pgRegenBtn" title="Regenerate last answer" style="display:none">${SVG.regen}</button>
        <button class="pg-iconbtn danger" id="pgStopBtn" title="Stop generating" style="display:none">${SVG.stop}</button>
        <button class="pg-iconbtn" id="pgClearBtn" title="Clear chat">${SVG.trash}</button>
      </div>
    </div>
    <div class="pg-toolbar">
      <select id="pgModel" class="pg-select">${opt(PG.slug)}</select>
      <label class="fld" title="Creativity"><span class="fld-ico">${SVG.sliders}</span><input type="range" id="pgTemp" min="0" max="2" step="0.1" value="${PG.temp}"><span class="val" id="pgTempV">${PG.temp.toFixed(1)}</span></label>
      <label class="fld" title="Max tokens">Max <input type="number" id="pgMax" min="64" max="4096" step="64" value="${PG.maxTok}"></label>
      <div class="pg-actions">
        <button class="chip-btn" id="pgSysBtn">System prompt</button>
        <button class="chip-btn ${PG.cmp?"on":""}" id="pgCmpBtn"><span class="chip-ico">${SVG.cols}</span>Compare</button>
        <select id="pgCmpSel" class="pg-select" style="${PG.cmp?"":"display:none"}">${opt(PG.cmp||"mnai7")}</select>
      </div>
    </div>
    <div id="pgSysRow" class="${PG.sys?"open":""}"><textarea id="pgSys" placeholder="Optional system instruction for this session…">${esc(PG.sys)}</textarea></div>
    <div class="pg-cols ${PG.cmp?"cmp":""}">
      <div class="pg-col"><div class="pg-col-label" style="${PG.cmp?"":"display:none"}">${esc(def.label)}</div><div id="pgChat" class="pg-chat"></div></div>
      <div class="pg-col"><div class="pg-col-label" style="${PG.cmp?"":"display:none"}">${esc(cmpDef?cmpDef.label:"")}</div><div id="pgChat2"></div></div>
    </div>
    <div class="est-line" id="pgEst"></div>
    <div class="pg-inputbar">
      <div class="pg-creditpill" id="pgCredits" title="Your credit balance">${SVG.bolt}<b>${fmtInt(PROFILE.credits||0)}</b></div>
      <input type="text" id="pgInput" placeholder="Message ${esc(def.label)}…  (Enter to send)" autocomplete="off">
      <button class="pg-send" id="pgSend" title="Send">${SVG.send}</button>
    </div>
    <div id="pgShareBox"></div>
  </div>`;
}

function mountPlayground(){
  pgRenderHist(PG.slug, $("#pgChat"));
  if (PG.cmp) pgRenderHist(PG.cmp, $("#pgChat2"));
  $("#pgModel").onchange = e=>{ PG.slug = e.target.value; render(); };
  $("#pgTemp").oninput = e=>{ PG.temp = +e.target.value; $("#pgTempV").textContent = PG.temp.toFixed(1); };
  $("#pgMax").onchange = e=>{ PG.maxTok = Math.min(Math.max(+e.target.value||1024,64),4096); };
  $("#pgSysBtn").onclick = ()=>$("#pgSysRow").classList.toggle("open");
  $("#pgSys").oninput = e=>{ PG.sys = e.target.value; };
  $("#pgCmpBtn").onclick = ()=>{
    PG.cmp = PG.cmp ? null : ($("#pgCmpSel").value === PG.slug ? "mnai7" : $("#pgCmpSel").value);
    render();
  };
  $("#pgCmpSel").onchange = e=>{ PG.cmp = e.target.value; render(); };
  $("#pgShareBtn").onclick = pgShare;
  $("#pgSnippetBtn").onclick = pgSnippet;
  $("#pgRegenBtn").onclick = pgRegen;
  $("#pgClearBtn").onclick = ()=>{ PG.hist[PG.slug] = []; if (PG.cmp) PG.hist[PG.cmp] = []; render(); toast("Chat cleared"); };
  $("#pgStopBtn").onclick = ()=>{ if (PG.abort) PG.abort.abort(); };
  const inp = $("#pgInput");
  inp.focus();
  inp.onkeydown = e=>{ if (e.key === "Enter") pgSend(); };
  $("#pgSend").onclick = pgSend;
  let estT = null;
  inp.oninput = ()=>{ clearTimeout(estT); estT = setTimeout(pgEstimate, 500); };
  pgEstimate();
}

function pgRenderHist(slug, el){
  const h = pgHist(slug);
  el.innerHTML = h.length ? h.map(m=>pgMsgHTML(m)).join("")
    : `<div class="pg-empty"><div class="pg-empty-ico">${SVG.spark}</div>
       <p>Ask anything — try "Who is your owner?"</p>
       <div class="pg-suggest">${["Who is your owner?","Write a haiku about code","Explain quantum computing simply"].map(s=>`<button class="chip-btn" data-sug="${esc(s)}">${esc(s)}</button>`).join("")}</div></div>`;
  el.querySelectorAll("[data-sug]").forEach(b=>b.onclick=()=>{ $("#pgInput").value = b.dataset.sug; pgSend(); });
  el.querySelectorAll("[data-copy]").forEach(b=>b.onclick=()=>copyText(b.dataset.copy,"Copied"));
  el.scrollTop = el.scrollHeight;
}

function pgMsgHTML(m){
  if (m.role === "user")
    return `<div class="pg-row user"><div class="pg-bubble user">${esc(m.text)}</div><span class="pg-who">${SVG.user}</span></div>`;
  const cost = m.charged ? `<span class="pg-cost">${SVG.bolt}−${m.charged} credit${m.charged===1?"":"s"}</span>` : "";
  const copy = m.text ? `<button class="pg-mini" data-copy="${esc(m.text)}" title="Copy">${SVG.copy}</button>` : "";
  return `<div class="pg-row ai"><span class="pg-who ai">${SVG.spark}</span>
    <div><div class="pg-bubble ai">${esc(m.text)}</div>
    <div class="pg-meta">${copy}${cost}</div></div></div>`;
}

function pgBubble(el, role){
  const wrap = document.createElement("div");
  wrap.className = "pg-row " + role;
  wrap.innerHTML = role === "user"
    ? `<div class="pg-bubble user"></div><span class="pg-who">${SVG.user}</span>`
    : `<span class="pg-who ai">${SVG.spark}</span><div><div class="pg-bubble ai"></div><div class="pg-meta"></div></div>`;
  el.appendChild(wrap); el.scrollTop = el.scrollHeight;
  return wrap.querySelector(".pg-bubble");
}

function pgFinishBubble(el, text, charged){
  // re-render the last row of this column with full metadata
  const rows = el.querySelectorAll(".pg-row.ai");
  const last = rows[rows.length - 1];
  if (last) {
    const tmp = document.createElement("div");
    tmp.innerHTML = pgMsgHTML({ role: "assistant", text, charged });
    last.replaceWith(tmp.firstChild);
    tmp.querySelector("[data-copy]")?.addEventListener("click", e=>copyText(text,"Copied"));
  }
  el.scrollTop = el.scrollHeight;
}

async function pgRun(slug, text, el){
  const hist = pgHist(slug);
  hist.push({ role: "user", text });
  pgRenderHist(slug, el);
  const ai = pgBubble(el, "ai");
  ai.innerHTML = '<span class="pg-think"><span class="spin"></span> thinking…</span>';
  const msgs = [];
  if (PG.sys.trim()) msgs.push({ role: "system", content: PG.sys.trim().slice(0,2000) });
  hist.forEach(m=>{ if (m.role==="user"||m.role==="assistant") msgs.push({ role: m.role, content: m.text }); });
  const ctrl = new AbortController();
  PG.abort = ctrl;
  $("#pgStopBtn").style.display = "";
  $("#pgSend").classList.add("hidden");
  let out = "", charged = 0;
  try {
    const r = await fetch("/api/mnaiapi/" + slug, {
      method: "POST", signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + await idToken() },
      body: JSON.stringify({ messages: msgs, stream: true, ...pgOpts() }),
    });
    const ct = r.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || ("Request failed (" + r.status + ")"));
      out = (j.choices && j.choices[0] && j.choices[0].message.content) || "";
      charged = j.credits_charged || 0;
      ai.textContent = out;
    } else {
      if (!r.ok) throw new Error("Request failed (" + r.status + ")");
      const reader = r.body.getReader(), decoder = new TextDecoder();
      let buf = "", started = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split("\\n\\n"); buf = parts.pop();
        for (const p of parts) {
          if (!p.startsWith("data:")) continue;
          const data = p.slice(5).trim();
          if (data === "[DONE]") continue;
          try {
            const j = JSON.parse(data);
            if (j.credits_charged != null) { charged = j.credits_charged; continue; }
            const tok = (j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content) || "";
            if (tok) { if (!started) { ai.textContent = ""; started = true; } out += tok; ai.textContent = out; el.scrollTop = el.scrollHeight; }
          } catch (e) {}
        }
      }
      if (!out) ai.innerHTML = '<span style="color:var(--text-3)">(empty response)</span>';
    }
    hist.push({ role: "assistant", text: out, charged });
    pgFinishBubble(el, out, charged);
    await refreshAll().catch(()=>{});
    const pc = $("#pgCredits"); if (pc) pc.innerHTML = `${SVG.bolt}<b>${fmtInt(PROFILE.credits||0)}</b>`;
  } catch (e) {
    if (e.name === "AbortError") {
      hist.push({ role: "assistant", text: out, charged });
      pgFinishBubble(el, out + " (stopped)", charged);
    }
    else { ai.innerHTML = `<span style="color:var(--red)">Error: ${esc(e.message)}</span>`; }
  } finally {
    if (PG.abort === ctrl) PG.abort = null;
    $("#pgStopBtn").style.display = "none";
    $("#pgSend").classList.remove("hidden");
    $("#pgRegenBtn").style.display = "";
  }
}

async function pgSend(){
  const text = $("#pgInput").value.trim();
  if (!text || PG.busy) return;
  PG.busy = true;
  $("#pgInput").value = "";
  $("#pgEst").textContent = "";
  const jobs = [pgRun(PG.slug, text, $("#pgChat"))];
  if (PG.cmp) jobs.push(pgRun(PG.cmp, text, $("#pgChat2")));
  await Promise.all(jobs);
  PG.busy = false;
}

function pgRegen(){
  const hist = pgHist(PG.slug);
  const li = [...hist].reverse().findIndex(m=>m.role==="user");
  if (li < 0 || PG.busy) return;
  const lastUser = hist[hist.length - 1 - li];
  PG.hist[PG.slug] = hist.slice(0, hist.length - li);
  (async ()=>{ PG.busy = true; await pgRun(PG.slug, lastUser.text, $("#pgChat")); PG.busy = false; })();
}

async function pgShare(){
  const hist = pgHist(PG.slug);
  const clean = hist.filter(m=>m.role==="user"||m.role==="assistant").map(m=>({role:m.role, content:m.text}));
  if (!clean.length) { toast("Nothing to share yet.", "err"); return; }
  try {
    const r = await api("/api/share", { method: "POST", body: { model: PG.slug, messages: clean } });
    $("#pgShareBox").innerHTML = `<div class="share-box" style="margin:0 0 14px"><code>${esc(r.url)}</code>
      <button class="btn sm blue" id="pgCopyShare">Copy</button></div>`;
    $("#pgCopyShare").onclick = ()=>copyText(r.url,"Share link copied");
    toast("Share link created");
  } catch(e){ toast(e.message, "err"); }
}

function pgSnippet(){
  const def = CATALOG.find(m=>m.slug===PG.slug) || {label:PG.slug};
  const lastUser = [...pgHist(PG.slug)].reverse().find(m=>m.role==="user");
  const msg = (lastUser ? lastUser.text : "Hello!").replace(/"/g, '\\"').slice(0,200);
  const curl = `curl -X POST https://dash-mnaii.vercel.app/api/mnaiapi/${PG.slug} \\\n  -H "Authorization: Bearer YOUR_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"messages":[{"role":"user","content":"${msg}"}]}'`;
  const py = `from openai import OpenAI\n\nclient = OpenAI(base_url="https://dash-mnaii.vercel.app/api/v1", api_key="YOUR_KEY")\nr = client.chat.completions.create(model="${PG.slug}", messages=[{"role": "user", "content": "${msg}"}])\nprint(r.choices[0].message.content)`;
  const js = `const r = await fetch("https://dash-mnaii.vercel.app/api/mnaiapi/${PG.slug}", {\n  method: "POST",\n  headers: { "Content-Type": "application/json", Authorization: "Bearer YOUR_KEY" },\n  body: JSON.stringify({ messages: [{ role: "user", content: "${msg}" }] }),\n});\nconst j = await r.json();\nconsole.log(j.choices[0].message.content);`;
  const blk = (label, code)=>`<div class="field"><label>${label}</label><pre class="api-hint"><code>${esc(code)}</code><button class="copy-btn" data-copy="${esc(code)}">${SVG.copy}</button></pre></div>`;
  openModal(`<div class="modal-head"><div><h2>Call ${esc(def.label)} from code</h2><p>Pick a language and paste.</p></div><button class="modal-x" onclick="closeModal()">×</button></div>
  <div class="modal-body">${blk("cURL",curl)}${blk("Python",py)}${blk("JavaScript",js)}</div>
  <div class="modal-foot"><button class="btn primary" onclick="closeModal()">Done</button></div>`);
  bindCopy($("#modal"));
}

async function pgEstimate(){
  const el = $("#pgEst"); if (!el) return;
  const text = $("#pgInput") ? $("#pgInput").value.trim() : "";
  if (!text) { el.textContent = ""; return; }
  try {
    const r = await fetch("/api/estimate", { method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ model: PG.slug, messages: [{role:"user",content:text}], max_tokens: PG.maxTok }) }).then(r=>r.json());
    el.innerHTML = `${SVG.bolt}<span>` + (r.free ? `~${fmtInt(r.estimated_tokens)} tokens · free`
      : `~${fmtInt(r.estimated_tokens)} tokens · ~${r.estimated_credits} credit${r.estimated_credits===1?"":"s"} will be spent`) + `</span>`;
  } catch(e){}
}

/* ---------- buy credits ---------- */
async function openBuyCredits(){
  openModal(`<div class="modal-head"><div><h2>Buy credits</h2><p>Credits pay for pro models. Free models always cost 0.</p></div><button class="modal-x" onclick="closeModal()">×</button></div>
    <div class="modal-body"><div style="text-align:center;margin-bottom:4px">Balance: <b style="font-size:18px">${fmtInt(PROFILE.credits||0)}</b> credits</div>
    <div class="pack-grid" id="packGrid" style="grid-template-columns:1fr"><div class="empty"><span class="spin"></span></div></div></div>`);
  try {
    const c = await api("/api/credits");
    $("#packGrid").style.gridTemplateColumns = "";
    $("#packGrid").innerHTML = c.packs.map((p,i)=>`
      <div class="pack ${i===1?"pop":""}" data-pack="${p.id}">
        <b>${fmtInt(p.credits)}</b><span>credits</span><div class="price">₹${(p.amount/100).toFixed(0)}</div>
      </div>`).join("") +
      (c.paymentsConfigured ? "" : '<p style="font-size:12px;color:var(--amber);text-align:center;margin-top:6px">Payments not configured yet — ask the owner to add Razorpay keys in Vercel.</p>');
    window._packs = c.packs; window._rzpKey = c.razorpayKeyId; window._payCfg = c.paymentsConfigured;
    $$("#packGrid .pack").forEach(el=>el.onclick=()=>buyPack(el.dataset.pack));
  } catch(e){ $("#packGrid").innerHTML = `<div class="empty"><h3>Couldn't load packs</h3><p>${esc(e.message)}</p></div>`; }
}
async function buyPack(packId){
  if (!window._payCfg) { toast("Payments aren't configured yet.", "err"); return; }
  if (typeof Razorpay === "undefined") { toast("Payment script failed to load. Check connection.", "err"); return; }
  try {
    const o = await api("/api/credits", { method: "POST", body: { packId } });
    const rzp = new Razorpay({
      key: o.keyId, amount: o.amount, currency: o.currency, order_id: o.orderId,
      name: "MNAI Console", description: o.credits + " credits",
      theme: { color: "#0070f3" },
      handler: async (resp) => {
        try {
          const v = await api("/api/verify-payment", { method: "POST",
            body: { orderId: resp.razorpay_order_id, paymentId: resp.razorpay_payment_id,
                    signature: resp.razorpay_signature, packId } });
          toast(v.credited ? `+${fmtInt(o.credits)} credits added!` : "Payment already credited.");
          closeModal(); await refreshAll();
        } catch(e){ toast("Payment done but crediting failed: " + e.message, "err"); }
      },
    });
    rzp.on("payment.failed", () => toast("Payment failed.", "err"));
    rzp.open();
  } catch(e){ toast(e.message, "err"); }
}

/* ---------- login ---------- */
function loginError(msg){ $("#loginErr").textContent = msg || ""; }
function friendlyAuthErr(e){
  const c = (e.code||"").replace("auth/","");
  const map = { "invalid-email":"Enter a valid email.", "user-not-found":"No account with that email — create one first.",
    "wrong-password":"Wrong password.", "invalid-credential":"Wrong email or password.",
    "email-already-in-use":"That email already has an account — sign in instead.",
    "weak-password":"Password should be at least 6 characters.", "popup-closed-by-user":"Popup closed.",
    "network-request-failed":"Network error — check your connection." };
  return map[c] || ("Sign-in failed ("+c+").");
}
function bindLogin(){
  $("#googleBtn").onclick = async () => {
    loginError("");
    try { await AUTH.signInWithPopup(new firebase.auth.GoogleAuthProvider()); }
    catch(e){ loginError(friendlyAuthErr(e)); }
  };
  const emailPass = async (mode) => {
    loginError(""); if (mode === "up") { const tc = document.getElementById("termsCheck"); if (tc && !tc.checked) { loginError("Please accept the Terms and Privacy Policy first."); return; } }
    const email = $("#loginEmail").value.trim(), pass = $("#loginPass").value;
    if (!email || !pass) { loginError("Enter your email and password."); return; }
    try {
      if (mode === "in") await AUTH.signInWithEmailAndPassword(email, pass);
      else await AUTH.createUserWithEmailAndPassword(email, pass);
    } catch(e){ loginError(friendlyAuthErr(e)); }
  };
  $("#emailSignIn").onclick = () => emailPass("in");
  $("#emailSignUp").onclick = () => emailPass("up");
  $("#loginPass").addEventListener("keydown", e=>{ if(e.key==="Enter") emailPass("in"); });
}

/* ---------- router ---------- */
const ROUTES = {
  overview: { page: pageOverview, mount: mountOverview, title: "Overview" },
  models:   { page: pageModels,   mount: mountModels,   title: "Models" },
  playground: { page: pagePlayground, mount: mountPlayground, title: "Playground" },
  webhooks: { page: pageWebhooks, mount: mountWebhooks, title: "Webhooks" },
  integrations: { page: pageIntegrations, mount: mountIntegrations, title: "Integrations" },
  docs: { page: pageDocs, mount: mountDocs, title: "Docs" },
  keys:     { page: pageKeys,     mount: mountKeys,     title: "API Keys" },
  usage:    { page: pageUsage,    mount: mountUsage,    title: "Usage" },
  logs:     { page: pageLogs,     mount: mountLogs,     title: "Logs" },
  settings: { page: pageSettings, mount: mountSettings, title: "Settings" },
};
function currentRoute(){
  const h = (location.hash || "#/overview").replace("#/","");
  if (h.startsWith("share/")) return "share";
  const r = h.split("?")[0];
  return ROUTES[r] ? r : "overview";
}
function shareId(){
  const h = (location.hash || "").replace("#/","");
  return h.startsWith("share/") ? h.slice(6).split("?")[0] : null;
}
function render(){
  if (currentRoute() === "share") { renderShare(); return; }
  if (!USER) return;
  const r = currentRoute(), route = ROUTES[r];
  $$("#nav a").forEach(a=>a.classList.toggle("active", a.dataset.route===r));
  document.title = route.title + " · MNAI Console";
  if (!PROFILE) {
    $("#page").innerHTML = skelPage(route.title);
  } else {
    $("#page").innerHTML = route.page();
    if (route.mount) route.mount();
  }
  document.body.classList.remove("nav-open");
  window.scrollTo(0,0);
}

/* ---------- skeleton screens ---------- */
function skelPage(title){
  const card = `<div class="card"><div class="skel" style="height:15px;width:42%;margin-bottom:12px"></div><div class="skel" style="height:30px;width:68%"></div></div>`;
  const row = `<div class="skel" style="height:46px;margin-bottom:8px"></div>`;
  return `<div class="page-head"><div><h1>${esc(title)}</h1><p>Loading…</p></div></div>
  <div class="grid stats">${card.repeat(4)}</div>
  <div class="card" style="margin-top:16px"><div class="skel" style="height:16px;width:28%;margin-bottom:14px"></div>${row.repeat(5)}</div>`;
}

/* ---------- theme ---------- */
function applyTheme(){
  let t = THEME;
  if (t === "system") t = matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  document.documentElement.dataset.theme = t;
}

/* ---------- events ---------- */
window.addEventListener("hashchange", render);
window.addEventListener("hashchange", ()=>setTimeout(pollLive, 400));
window.addEventListener("resize", ()=>{ const r=ROUTES[currentRoute()]; if (r && r.mount && USER) r.mount(); });
document.addEventListener("keydown", e=>{
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase()==="k"){ e.preventDefault();
    $("#paletteOverlay").classList.contains("hidden") ? openPalette() : closePalette(); return; }
  if (!$("#paletteOverlay").classList.contains("hidden")){
    if (e.key==="Escape") closePalette();
    if (e.key==="ArrowDown"){ e.preventDefault(); palSel=Math.min(palSel+1,$$(".pal-item").length-1); markPalSel(); }
    if (e.key==="ArrowUp"){ e.preventDefault(); palSel=Math.max(palSel-1,0); markPalSel(); }
    if (e.key==="Enter"){ const items=$$(".pal-item"); if(items[palSel]) items[palSel].click(); }
    return;
  }
  if (e.key==="Escape"){ closeModal(); }
  const digits = ["1","2","3","4","5","6","7","8","9","0"];
  if (mod && digits.includes(e.key)){
    e.preventDefault();
    const pages = ["overview","models","playground","webhooks","integrations","docs","keys","usage","logs","settings"];
    location.hash = "#/"+pages[digits.indexOf(e.key)];
  }
  if (e.key === "?" && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) openShortcuts();
});

/* ---------- boot ---------- */
applyTheme();
initFirebase();
bindLogin();
startLive();
$("#paletteBtn").onclick = openPalette;
$("#paletteInput").addEventListener("input", e=>renderPalette(e.target.value));
$("#paletteOverlay").addEventListener("click", e=>{ if(e.target.id==="paletteOverlay") closePalette(); });
$("#modalOverlay").addEventListener("click", e=>{ if(e.target.id==="modalOverlay") closeModal(); });

$("#newKeyBtn").onclick = ()=>{ location.hash="#/keys"; setTimeout(openCreateKey,80); };
$("#themeBtn").onclick = cycleTheme;
$("#menuBtn").onclick = ()=>document.body.classList.toggle("nav-open");
$("#creditsPill").onclick = openBuyCredits;
$("#bellBtn").onclick = (e)=>{ e.stopPropagation();
  const d = $("#bellDrop"), open = d.classList.contains("hidden");
  if (open) renderBellDrop();
  d.classList.toggle("hidden", !open); };
document.addEventListener("click", (e)=>{ if (!e.target.closest("#bellWrap")) $("#bellDrop").classList.add("hidden"); });
setInterval(()=>{ if (USER) updateBell(); }, 60000);
$("#userChip").onclick = ()=>{ location.hash="#/settings"; };

/* ---------- shared chat view (public link) ---------- */
async function renderShare(){
  const id = shareId();
  document.title = "Shared chat · MNAI Console";
  $$("#nav a").forEach(a=>a.classList.remove("active"));
  $("#page").innerHTML = `<div class="page-head"><div><h1>Shared chat</h1><p>Shared via MNAI Console.</p></div>
    <div class="page-actions"><a class="btn primary" href="#/playground"><span>Try the playground</span></a></div></div>
    <div class="card"><div id="shareBody"><div class="empty"><span class="spin"></span></div></div></div>`;
  try {
    const s = await fetch("/api/share?id=" + encodeURIComponent(id)).then(r=>r.json());
    if (s.error) throw new Error(s.error);
    $("#shareBody").innerHTML = `<p style="margin-bottom:14px"><span class="badge blue">${esc(s.label||s.model)}</span>
      <span style="color:var(--text-3);font-size:12px;margin-left:8px">${new Date(s.createdAt).toLocaleString()}</span></p>` +
      (s.messages||[]).map(m=>`<div class="pg-msg ${m.role==="user"?"user":"ai"}" style="margin-bottom:10px;max-width:100%">${esc(m.content)}</div>`).join("");
  } catch(e){ $("#shareBody").innerHTML = `<div class="empty"><h3>Share not found</h3><p>${esc(e.message)}</p></div>`; }
}

/* ---------- webhooks ---------- */
let HOOKS = [];
function pageWebhooks(){
  return `
  <div class="page-head"><div><h1>Webhooks</h1><p>Get notified when things happen — signed, inspectable deliveries.</p></div>
    <div class="page-actions"><button class="btn primary" id="newHookBtn"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg><span>New webhook</span></button></div></div>
  <div id="hookList"><div class="card"><div class="empty"><span class="spin"></span></div></div></div>
  <div class="card" style="margin-top:16px"><div class="card-head"><h2>How it works</h2></div>
    <p style="font-size:13px;color:var(--text-2);line-height:1.7">We <span class="mono">POST</span> JSON to your URL on every subscribed event. Each delivery carries
    <span class="mono">X-MNAI-Signature</span> (<span class="mono">sha256=…</span> HMAC of the raw body with your hook secret) and
    <span class="mono">X-MNAI-Event</span> so you can verify it's really us. Failed deliveries are logged below each hook.</p></div>`;
}
async function mountWebhooks(){
  $("#newHookBtn").onclick = openNewHook;
  try {
    const r = await api("/api/webhooks");
    HOOKS = r.hooks || [];
    PROFILE.hookCount = HOOKS.length;
  } catch(e){ $("#hookList").innerHTML = `<div class="empty"><h3>Couldn't load webhooks</h3><p>${esc(e.message)}</p></div>`; return; }
  renderHooks();
}
function renderHooks(){
  const el = $("#hookList"); if (!el) return;
  el.innerHTML = HOOKS.map(h=>`
    <div class="hook-card">
      <div class="hook-top">
        <div><span class="hook-url">${esc(h.url)}</span>
          <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">${(h.events||[]).map(e=>`<span class="scope-tag">${esc(e)}</span>`).join("")}</div></div>
        <div style="display:flex;gap:8px;align-items:center">
          <span class="badge ${h.active?"green":"red"}">${h.active?"Active":"Paused"}</span>
          <button class="btn sm" data-test="${h.id}">Send test</button>
          <button class="btn sm danger" data-delhook="${h.id}">Delete</button>
        </div>
      </div>
      <div style="font-size:12px;color:var(--text-3);margin:8px 0 4px">Recent deliveries</div>
      ${(h.deliveries||[]).map(d=>`<div class="del-row"><span class="act-dot" style="background:${d.ok?"var(--green)":"var(--red)"}"></span>
        <span class="mono">${esc(d.event)}</span><span style="color:var(--text-3)">${d.test?"test · ":""}${new Date(d.ts).toLocaleString()}</span>
        <span class="${d.ok?"status-2xx":"status-4xx"}">${d.status||"err"}</span>
        ${d.error?`<span style="color:var(--red)">${esc(d.error)}</span>`:""}</div>`).join("")
        || '<div style="font-size:12.5px;color:var(--text-3)">No deliveries yet.</div>'}
    </div>`).join("") || `<div class="card"><div class="empty"><h3>No webhooks yet</h3><p>Create one to get event notifications.</p></div></div>`;
  $$("[data-test]").forEach(b=>b.onclick=async()=>{
    b.disabled = true;
    try { const r = await api("/api/webhooks",{method:"POST",body:{test:b.dataset.test}});
      toast(r.delivered ? `Test delivered (${r.status})` : `Test failed (${r.status||"error"})`, r.delivered?undefined:"err"); }
    catch(e){ toast(e.message,"err"); }
    b.disabled = false; mountWebhooks();
  });
  $$("[data-delhook]").forEach(b=>b.onclick=async()=>{
    if (!confirm("Delete this webhook?")) return;
    await api("/api/webhooks?id="+b.dataset.delhoook,{method:"DELETE"}).catch(e=>toast(e.message,"err"));
    mountWebhooks();
  });
}
function openNewHook(){
  const evs = ["request.completed","credit.low","credit.depleted","key.created","key.revoked","voucher.redeemed"];
  openModal(`
  <div class="modal-head"><div><h2>New webhook</h2><p>We'll POST signed JSON to your URL.</p></div><button class="modal-x" onclick="closeModal()">×</button></div>
  <div class="modal-body">
    <div class="field"><label>Endpoint URL</label><input type="text" id="whUrl" placeholder="https://your-app.com/hooks/mnai"></div>
    <div class="field"><label>Events</label><div class="ev-checks">
      ${evs.map(e=>`<label class="check"><input type="checkbox" value="${e}"${e==="request.completed"?" checked":""}> ${e}</label>`).join("")}
    </div></div>
  </div>
  <div class="modal-foot"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn blue" id="whGo">Create webhook</button></div>`);
  $("#whGo").onclick = async ()=>{
    const url = $("#whUrl").value.trim();
    const events = $$("#modal .ev-checks input:checked").map(i=>i.value);
    $("#whGo").disabled = true;
    try {
      const h = await api("/api/webhooks",{method:"POST",body:{url, events}});
      openModal(`
      <div class="modal-head"><div><h2>Webhook created</h2><p>Save this secret — it signs every delivery.</p></div><button class="modal-x" onclick="closeModal()">×</button></div>
      <div class="modal-body"><div class="secret-box">${esc(h.secret)}</div></div>
      <div class="modal-foot"><button class="btn primary" id="whDone">Done</button></div>`);
      $("#whDone").onclick = ()=>{ closeModal(); mountWebhooks(); };
    } catch(e){ toast(e.message,"err"); $("#whGo").disabled = false; }
  };
}

/* ---------- integrations ---------- */
function pageIntegrations(){
  const mcpCfg = { mcpServers: { "mnai-api": { url: "https://dash-mnaii.vercel.app/api/mcp",
    headers: { Authorization: "Bearer YOUR_API_KEY" } } } };
  return `
  <div class="page-head"><div><h1>Integrations</h1><p>Connect MNAI to the apps you already use.</p></div></div>
  <div class="int-grid">
    <div class="int-card"><div class="int-head"><span class="int-ico">💬</span><h3>Slack / Discord alerts</h3></div>
      <p>Get a message when credits run low. Paste an incoming-webhook URL.</p>
      <div class="row"><input type="text" id="alertUrl" placeholder="https://hooks.slack.com/…" value="${esc(PROFILE.alertWebhook||"")}"></div>
      <div class="row"><button class="btn sm blue" id="alertSave">Save</button><button class="btn sm" id="alertTest">Send test</button></div>
    </div>
    <div class="int-card"><div class="int-head"><span class="int-ico">🤖</span><h3>Claude Desktop (MCP)</h3></div>
      <p>Use every MNAI model inside Claude Desktop as tools. Add this to <span class="mono">claude_desktop_config.json</span>:</p>
      <pre class="api-hint"><code>${esc(JSON.stringify(mcpCfg, null, 2))}</code><button class="copy-btn" data-copy='${esc(JSON.stringify(mcpCfg))}'><svg viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 012-2h10"/></svg></button></pre>
      <div class="row"><a class="btn sm" href="#/docs"><span>MCP docs →</span></a></div>
    </div>
    <div class="int-card"><div class="int-head"><span class="int-ico">⚡</span><h3>Zapier / Make</h3></div>
      <p>Trigger Zaps and scenarios from MNAI events. Point a "Webhooks by Zapier" trigger at a webhook below.</p>
      <div class="row"><a class="btn sm" href="#/webhooks"><span>Set up webhooks →</span></a></div>
    </div>
    <div class="int-card"><div class="int-head"><span class="int-ico">🐍</span><h3>OpenAI SDKs</h3></div>
      <p>Point any OpenAI client at MNAI — zero code changes besides the base URL and key.</p>
      <pre class="api-hint"><code>base_url="https://dash-mnaii.vercel.app/api/v1"</code><button class="copy-btn" data-copy="https://dash-mnaii.vercel.app/api/v1"><svg viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 012-2h10"/></svg></button></pre>
      <div class="row"><a class="btn sm" href="#/docs"><span>SDK examples →</span></a></div>
    </div>
    <div class="int-card"><div class="int-head"><span class="int-ico">📦</span><h3>Batch API</h3></div>
      <p>Run up to 10 chat requests in a single call — perfect for evals and bulk jobs.</p>
      <div class="row"><a class="btn sm" href="#/docs"><span>Batch docs →</span></a></div>
    </div>
    <div class="int-card"><div class="int-head"><span class="int-ico">🔗</span><h3>Share chats</h3></div>
      <p>Share any playground conversation with a public read-only link.</p>
      <div class="row"><a class="btn sm" href="#/playground"><span>Open playground →</span></a></div>
    </div>
  </div>`;
}
function mountIntegrations(){
  bindCopy($("#page"));
  $("#alertSave").onclick = async ()=>{
    try { await api("/api/credits",{method:"PUT",body:{alertWebhook:$("#alertUrl").value.trim()}});
      toast("Alert webhook saved"); PROFILE.alertWebhook = $("#alertUrl").value.trim(); }
    catch(e){ toast(e.message,"err"); }
  };
  $("#alertTest").onclick = async ()=>{
    const url = $("#alertUrl").value.trim();
    if (!url) { toast("Paste a webhook URL first.","err"); return; }
    try {
      await api("/api/credits",{method:"PUT",body:{alertWebhook:url, testAlert:true}});
      toast("Test alert sent — check the channel.");
    } catch(e){ toast(e.message,"err"); }
  };
}

/* ---------- docs ---------- */
function pageDocs(){
  const S = (id, title, body) => `<h2 id="${id}">${title}</h2>${body}`;
  const code = (c) => `<pre class="code"><button class="copy-btn" data-copy="${esc(c)}"><svg viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 012-2h10"/></svg></button><code>${esc(c)}</code></pre>`;
  const curlEx = `curl -X POST https://dash-mnaii.vercel.app/api/mnaiapi/mnai6 \\
  -H "Authorization: Bearer YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"messages":[{"role":"user","content":"Hello!"}]}'`;
  const pyEx = `from openai import OpenAI

client = OpenAI(
    base_url="https://dash-mnaii.vercel.app/api/v1",
    api_key="YOUR_KEY",  # mnai-free-sk-… or mnai_sk_…
)
r = client.chat.completions.create(
    model="mnai6",  # or "MNAI 6", "glyph2", …
    messages=[{"role": "user", "content": "Hello!"}],
)
print(r.choices[0].message.content)`;
  const jsEx = `const r = await fetch("https://dash-mnaii.vercel.app/api/mnaiapi/mnai6", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: "Bearer YOUR_KEY" },
  body: JSON.stringify({ messages: [{ role: "user", content: "Hello!" }], stream: true }),
});
// read the SSE stream…`;
  const mcpCfg = `{
  "mcpServers": {
    "mnai-api": {
      "url": "https://dash-mnaii.vercel.app/api/mcp",
      "headers": { "Authorization": "Bearer YOUR_API_KEY" }
    }
  }
}`;
  const modelRows = CATALOG.map(m=>`<tr><td><span class="mono">/api/mnaiapi/${m.slug}</span></td><td>${esc(m.label)}</td><td>${m.free?'<span class="badge green">FREE</span>':`<span class="badge amber">${m.rate} cr/1K</span>`}</td></tr>`).join("");
  return `
  <div class="page-head"><div><h1>Docs</h1><p>Everything you need to build on the MNAI API.</p></div></div>
  <div class="docs-layout">
    <nav class="docs-nav">
      <a href="#/docs" data-doc="quickstart">Quickstart</a><a href="#/docs" data-doc="auth">Authentication</a>
      <a href="#/docs" data-doc="chat">Chat</a><a href="#/docs" data-doc="models">Models</a>
      <a href="#/docs" data-doc="streaming">Streaming</a><a href="#/docs" data-doc="sdks">SDKs</a>
      <a href="#/docs" data-doc="webhooks">Webhooks</a><a href="#/docs" data-doc="mcp">MCP</a>
      <a href="#/docs" data-doc="batch">Batch</a><a href="#/docs" data-doc="errors">Errors</a>
    </nav>
    <div class="docs-body">
      ${S("quickstart","Quickstart",`<p>1. Create a key in <a href="#/keys" style="color:var(--blue)">API Keys</a> — <span class="mono">mnai-free-sk-…</span> for free models, <span class="mono">mnai_sk_…</span> for everything.<br>2. Call the API:<br></p>${code(curlEx)}<p>3. That's it. Every model answers as MNAI, made by MeowSamOP DZN.</p>`)}
      ${S("auth","Authentication",`<p>Send your key (or Firebase ID token) as a Bearer token — or via the <span class="mono">X-API-Key</span> header. Free keys work on free models only; pro keys spend credits from your wallet on credit models.</p>`)}
      ${S("chat","Chat",`<p><span class="mono">POST /api/mnaiapi/:model</span> — body <span class="mono">{messages:[{role,content}], max_tokens?, temperature?, top_p?, stream?}</span>. The OpenAI-compatible alias is <span class="mono">POST /api/v1/chat/completions</span> with <span class="mono">{model:"&lt;slug&gt;"}</span>.</p>`)}
      ${S("models","Models",`<div class="table-wrap"><table><thead><tr><th>Endpoint</th><th>Model</th><th>Price</th></tr></thead><tbody>${modelRows}</tbody></table></div>`)}
      ${S("streaming","Streaming",`<p>Pass <span class="mono">"stream": true</span> to <span class="mono">/api/mnaiapi/:model</span> for Server-Sent Events, OpenAI-style, ending with <span class="mono">data: [DONE]</span>.</p>${code(jsEx)}`)}
      ${S("sdks","SDKs",`<p>Python (OpenAI SDK, drop-in):</p>${code(pyEx)}`)}
      ${S("webhooks","Webhooks",`<p>Create hooks in <a href="#/webhooks" style="color:var(--blue)">Webhooks</a>. We POST signed JSON (<span class="mono">X-MNAI-Signature: sha256=…</span> HMAC with your hook secret). Events: <span class="mono">request.completed</span>, <span class="mono">credit.low</span>, <span class="mono">credit.depleted</span>, <span class="mono">key.created</span>, <span class="mono">key.revoked</span>, <span class="mono">voucher.redeemed</span>.</p>`)}
      ${S("mcp","MCP",`<p>Point any MCP client at <span class="mono">https://dash-mnaii.vercel.app/api/mcp</span> (JSON-RPC 2.0, Bearer auth). Each model becomes a <span class="mono">chat_with_&lt;slug&gt;</span> tool. Claude Desktop config:</p>${code(mcpCfg)}`)}
      ${S("batch","Batch",`<p><span class="mono">POST /api/batch</span> with <span class="mono">{requests:[{model, messages}, …]}</span> (max 10). Quotas and credits apply per request.</p>`)}
      ${S("errors","Errors",`<div class="table-wrap"><table><thead><tr><th>Code</th><th>Meaning</th></tr></thead><tbody>
        <tr><td class="mono">400</td><td>Bad request (e.g. missing messages, bad voucher).</td></tr>
        <tr><td class="mono">401</td><td>Missing/invalid key or login.</td></tr>
        <tr><td class="mono">402</td><td>Insufficient credits or spend cap reached.</td></tr>
        <tr><td class="mono">403</td><td>Free key on a credit model, or IP not allowlisted.</td></tr>
        <tr><td class="mono">429</td><td>Quota or rate limit exceeded.</td></tr>
        <tr><td class="mono">502/503</td><td>Upstream provider issue, or provider key not configured.</td></tr>
      </tbody></table></div>`)}
    </div>
  </div>`;
}
function mountDocs(){
  bindCopy($("#page"));
  $$("[data-doc]").forEach(a=>a.onclick=(e)=>{ e.preventDefault();
    const t = document.getElementById(a.dataset.doc); if (t) t.scrollIntoView({behavior:"smooth"}); });
}

/* ---------- notifications bell ---------- */
async function updateBell(){
  try {
    const n = await api("/api/notifications");
    PROFILE.notifications = n.notifications; PROFILE.unread = n.unread;
    $("#bellDot").classList.toggle("hidden", !n.unread);
  } catch(e){}
}
function renderBellDrop(){
  const list = PROFILE.notifications || [];
  $("#bellDrop").innerHTML = `<div class="bell-head">Notifications<button id="markRead">Mark all read</button></div>` +
    (list.length ? list.map(n=>`<div class="bell-item ${n.read?"read":"unread"}"><span class="dot2"></span>
      <div>${esc(n.text)}<small>${timeAgo(n.ts)}</small></div></div>`).join("")
      : `<div class="empty"><h3>All caught up</h3></div>`);
  const mr = $("#markRead");
  if (mr) mr.onclick = async (e)=>{ e.stopPropagation();
    await api("/api/notifications",{method:"POST",body:{action:"read"}}).catch(()=>{});
    PROFILE.notifications = (PROFILE.notifications||[]).map(x=>({...x, read:true}));
    PROFILE.unread = 0; $("#bellDot").classList.add("hidden"); renderBellDrop(); };
}

/* ---------- onboarding checklist ---------- */
function onboardingCard(){
  if (localStorage.getItem("dashmnai.onboard") === "1") return "";
  const steps = [
    { label: "Create an API key", done: (PROFILE.keys||[]).length > 0, go: "#/keys" },
    { label: "Try a model", done: (PROFILE.recentLogs||[]).length > 0, go: "#/playground" },
    { label: "Add a webhook", done: (PROFILE.hookCount||0) > 0, go: "#/webhooks" },
    { label: "Get credits", done: (PROFILE.credits||0) > 0, go: "#/settings" },
  ];
  if (steps.every(s=>s.done)) { localStorage.setItem("dashmnai.onboard","1"); return ""; }
  return `<div class="onboard"><div style="display:flex;justify-content:space-between;align-items:start">
    <div><h3>Get the most out of MNAI</h3><p>A few quick steps to go live.</p></div>
    <button class="modal-x" id="obHide">×</button></div>
    <div class="ob-steps">${steps.map((s,i)=>`<div class="ob-step ${s.done?"done":""}" data-ob="${i}">
      <span class="ob-num">${s.done?"✓":i+1}</span>${esc(s.label)}</div>`).join("")}</div></div>`;
}
function mountOnboarding(){
  const h = $("#obHide"); if (h) h.onclick = ()=>{ localStorage.setItem("dashmnai.onboard","1"); render(); };
  $$("[data-ob]").forEach(el=>el.onclick=()=>{
    const go = ["#/keys","#/playground","#/webhooks","#/settings"][+el.dataset.ob];
    if (!el.classList.contains("done")) location.hash = go;
  });
}

/* ---------- shortcuts ---------- */
function openShortcuts(){
  openModal(`<div class="modal-head"><div><h2>Keyboard shortcuts</h2></div><button class="modal-x" onclick="closeModal()">×</button></div>
  <div class="modal-body">
    ${[["⌘/Ctrl + K","Command palette"],["⌘/Ctrl + 1…0","Jump to pages"],["?","This help"],["Esc","Close dialogs"],["Enter","Send (in playground)"]]
      .map(([k,d])=>`<div class="sc-row"><span>${d}</span><kbd>${k}</kbd></div>`).join("")}
  </div>`);
}

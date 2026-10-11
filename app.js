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
      await refreshAll();
    } else {
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
let THEME = localStorage.getItem("dashmnai.theme") || "dark";

async function refreshAll(){
  try {
    const [me, models] = await Promise.all([ api("/api/me"), api("/api/models", {auth:false}) ]);
    PROFILE = me; CATALOG = models.models || [];
  } catch (e) {
    // backend may not be configured yet
    PROFILE = PROFILE || { credits: 0, keys: [], usage30d: [], recentLogs: [], ledger: [] };
    try { const m = await api("/api/models", {auth:false}); CATALOG = m.models || []; } catch {}
    if (e && e.code === 503) toast("Backend not configured yet — add env vars in Vercel.", "err");
  }
  $("#creditsVal").textContent = fmtInt(PROFILE.credits || 0);
  render();
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
    {group:"Go to", label:"API Keys", hint:"⌘4", run:()=>location.hash="#/keys"},
    {group:"Go to", label:"Usage", hint:"⌘5", run:()=>location.hash="#/usage"},
    {group:"Go to", label:"Logs", hint:"⌘6", run:()=>location.hash="#/logs"},
    {group:"Go to", label:"Settings", hint:"⌘7", run:()=>location.hash="#/settings"},
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
  return m.free ? '<span class="badge green">FREE</span>'
    : '<span class="badge amber">'+m.rate+' credits / 1K tokens</span>';
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
  const s30 = PROFILE.usage30d || [];
  const sum = f => s30.reduce((a,d)=>a+(d[f]||0),0);
  const req=sum("requests"), tok=sum("tokens"), cred=sum("credits"), err=sum("errors");
  const half = Math.floor(s30.length/2);
  const prev = s30.slice(0,half), cur = s30.slice(half);
  const ps = f => prev.reduce((a,d)=>a+(d[f]||0),0), cs = f => cur.reduce((a,d)=>a+(d[f]||0),0);
  const act = (PROFILE.keys||[]).filter(k=>!k.revoked).length;
  const logs = (PROFILE.recentLogs||[]).slice(0,6);
  return `
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
  <div class="card" style="margin-top:16px"><div class="card-head"><h2>Recent activity</h2><a href="#/logs" class="btn sm">View all logs</a></div>
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
      <td><span class="mono">${maskOf(k)}</span></td>
      <td class="mono">${fmt(k.requests||0)}</td>
      <td class="mono" style="color:var(--amber)">${fmtInt(k.creditsUsed||0)}</td>
      <td style="color:var(--text-3);font-size:12.5px">${k.lastUsedAt?timeAgo(k.lastUsedAt):"never"}</td>
      <td>${statusBadge(k)}</td>
      <td style="text-align:right">${k.revoked?"":'<button class="btn sm danger" data-revoke="'+k.id+'">Revoke</button>'}</td>
    </tr>`).join("");
  return `
  <div class="page-head"><div><h1>API Keys</h1><p>Free keys (<span class="mono">mnai-free-sk-…</span>) unlock free models only. Pro keys (<span class="mono">mnai_sk_…</span>) unlock everything with credits.</p></div>
    <div class="page-actions"><button class="btn primary" onclick="openCreateKey()"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg><span>New key</span></button></div></div>
  <div class="table-wrap"><table><thead><tr><th>Name</th><th>Key</th><th>Requests</th><th>Credits used</th><th>Last used</th><th>Status</th><th></th></tr></thead>
  <tbody>${rows}</tbody></table>
  ${keys.length?"":'<div class="empty"><svg viewBox="0 0 24 24"><circle cx="8" cy="15" r="4"/><path d="M11 12l9-9m-4 4l3 3"/></svg><h3>No API keys yet</h3><p>Create your first key to start calling the API.</p></div>'}</div>`;
}
function mountKeys(){
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
      const k=await api("/api/keys",{method:"POST",body:{name,kind:newKeyKind}});
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

/* ---------- usage ---------- */
let usageRange="30D", usageMetric="requests";
function pageUsage(){
  return `
  <div class="page-head"><div><h1>Usage</h1><p>Requests, tokens and credits across your account.</p></div>
    <div class="page-actions">
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
  <div class="page-head"><div><h1>Logs</h1><p>Your recent API requests, newest first.</p></div></div>
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
function pageSettings(){
  const t=THEME;
  const ledger=(PROFILE.ledger||[]).slice(0,10);
  return `
  <div class="page-head"><div><h1>Settings</h1><p>Console preferences, wallet and account.</p></div></div>
  <div class="settings-grid">
    <div class="card"><div class="card-head"><h2>Wallet</h2><button class="btn sm blue" onclick="openBuyCredits()"><span>Buy credits</span></button></div>
      <div class="row-between"><div><div class="t">Balance</div><div class="d">Credits pay for pro models.</div></div><b style="font-size:20px;font-variant-numeric:tabular-nums">${fmtInt(PROFILE.credits||0)}</b></div>
      <div class="row-between"><div><div class="t">Redeem voucher</div><div class="d">Have a code? Get free credits.</div></div>
        <div style="display:flex;gap:8px"><input type="text" id="voucherInput" placeholder="Enter code" style="width:130px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-size:13px;padding:8px 12px;outline:none;font-family:var(--mono)"><button class="btn sm" id="voucherBtn">Redeem</button></div></div>
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
  $("#voucherInput").addEventListener("keydown", e=>{ if(e.key==="Enter") doRedeem(); });
}
function setTheme(t){ THEME=t; localStorage.setItem("dashmnai.theme",t); applyTheme(); }
function cycleTheme(){ setTheme(THEME==="dark"?"light":THEME==="light"?"system":"dark"); render(); }
function applyTheme(){
  let t=THEME; if(t==="system") t=matchMedia("(prefers-color-scheme: light)").matches?"light":"dark";
  document.documentElement.dataset.theme=t;
}

/* ---------- playground (full page) ---------- */
const PG_HIST = {};   // slug -> [{role, content}]
let PG_SLUG = "mnai6";

function openPlayground(m){
  // "Try" entry point: credit check, then go to the playground page
  if (!m.free && (PROFILE.credits || 0) < 1) {
    toast("This model needs credits — grab some first.", "err");
    openBuyCredits();
    return;
  }
  location.hash = "#/playground?model=" + m.slug;
}
function pgModel(){ return modelBySlug(PG_SLUG); }

function pagePlayground(){
  const free = CATALOG.filter(m => m.free), pro = CATALOG.filter(m => !m.free);
  const opt = m => `<option value="${m.slug}" ${m.slug===PG_SLUG?"selected":""}>${esc(m.label)}${m.free?" — free":" — "+m.rate+" cr/1K"}</option>`;
  return `
  <div class="page-head"><div><h1>Playground</h1><p>Chat with any model directly. Free models cost nothing.</p></div>
    <div class="page-actions"><button class="btn" onclick="openBuyCredits()"><span>Buy credits</span></button></div></div>
  <div class="card pg-page">
    <div class="pg-modelbar">
      <select id="pgModelSel">
        <optgroup label="Free">${free.map(opt).join("")}</optgroup>
        <optgroup label="Credit-based">${pro.map(opt).join("")}</optgroup>
      </select>
      <span id="pgCost"></span>
    </div>
    <div id="pgChat"></div>
    <div class="pg-composer">
      <input type="text" id="pgInput" placeholder="Ask anything…" autocomplete="off">
      <button class="btn primary" id="pgGo"><svg viewBox="0 0 24 24"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4z"/></svg></button>
    </div>
  </div>`;
}
function pgCostHTML(){
  const m = pgModel();
  return m.free ? '<span class="badge green">FREE</span>'
    : `<span class="badge amber">${m.rate} credits / 1K tokens</span> <span style="color:var(--text-3);font-size:12.5px">balance ${fmtInt(PROFILE.credits||0)}</span>`;
}
function pgRenderHist(){
  const chat = $("#pgChat"); if (!chat) return;
  const hist = PG_HIST[PG_SLUG] || [];
  chat.innerHTML = "";
  if (!hist.length) pgAddMsg("ai", `Hey, I'm ${pgModel().label} — ask me anything.`);
  hist.forEach(m => pgAddMsg(m.role === "user" ? "user" : "ai", m.content, m.meta));
}
function pgAddMsg(role, text, meta){
  const d = document.createElement("div");
  d.className = "pg-msg " + role;
  d.innerHTML = esc(text) + (meta ? `<div class="meta">${esc(meta)}</div>` : "");
  const chat = $("#pgChat");
  chat.appendChild(d);
  chat.scrollTop = chat.scrollHeight;
  return d;
}
function mountPlayground(){
  const q = new URLSearchParams((location.hash.split("?")[1] || ""));
  const want = q.get("model");
  if (want && CATALOG.some(m => m.slug === want)) PG_SLUG = want;
  if (!CATALOG.some(m => m.slug === PG_SLUG)) PG_SLUG = (CATALOG[0] || {}).slug || "mnai6";
  const sel = $("#pgModelSel");
  sel.value = PG_SLUG;
  $("#pgCost").innerHTML = pgCostHTML();
  pgRenderHist();
  sel.onchange = () => {
    const m = modelBySlug(sel.value);
    if (!m.free && (PROFILE.credits || 0) < 1) {
      toast("This model needs credits — grab some first.", "err");
      sel.value = PG_SLUG;
      openBuyCredits();
      return;
    }
    PG_SLUG = m.slug;
    $("#pgCost").innerHTML = pgCostHTML();
    pgRenderHist();
  };
  $("#pgGo").onclick = pgSendPage;
  $("#pgInput").addEventListener("keydown", e => { if (e.key === "Enter") pgSendPage(); });
  setTimeout(() => { const i = $("#pgInput"); if (i) i.focus(); }, 80);
}
async function pgSendPage(){
  const inp = $("#pgInput"), text = inp.value.trim();
  if (!text) return;
  const m = pgModel();
  if (!m.free && (PROFILE.credits || 0) < 1) { toast("Not enough credits.", "err"); openBuyCredits(); return; }
  inp.value = "";
  const hist = PG_HIST[m.slug] = PG_HIST[m.slug] || [];
  hist.push({ role: "user", content: text });
  pgAddMsg("user", text);
  const typing = pgAddMsg("ai", "");
  typing.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
  $("#pgGo").disabled = true;
  try {
    const t = await idToken();
    const r = await fetch("/api/mnaiapi/" + m.slug, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + t },
      body: JSON.stringify({ messages: hist.slice(-12), stream: true, max_tokens: 1024 }),
    });
    let full = "", meta = "";
    const ct = r.headers.get("content-type") || "";
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error || ("Request failed (" + r.status + ")"));
    }
    if (ct.includes("text/event-stream")) {
      // streaming SSE
      const reader = r.body.getReader(), decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split("\n\n"); buf = parts.pop();
        for (const p of parts) {
          if (p.includes("[DONE]")) continue;
          const mm = p.match(/"delta"\s*:\s*\{\s*"content"\s*:\s*"((?:[^"\\]|\\.)*)"/);
          if (mm) { try { full += JSON.parse('"' + mm[1] + '"'); } catch {} }
        }
        typing.textContent = full;
        $("#pgChat").scrollTop = $("#pgChat").scrollHeight;
      }
    } else {
      // plain JSON (e.g. instant local answers)
      const j = await r.json();
      full = (j.choices && j.choices[0] && j.choices[0].message.content) || "";
      if (j.usage) meta = `${fmtInt(j.usage.total_tokens)} tokens`;
      if (j.credits_charged) meta += (meta ? " · " : "") + `-${j.credits_charged} credits`;
    }
    if (!full) throw new Error("Empty response from model.");
    hist.push({ role: "assistant", content: full, meta });
    typing.innerHTML = esc(full) + (meta ? `<div class="meta">${esc(meta)}</div>` : "");
    api("/api/me").then(me => { PROFILE = me; $("#creditsVal").textContent = fmtInt(me.credits || 0); $("#pgCost").innerHTML = pgCostHTML(); }).catch(() => {});
  } catch (e) {
    typing.innerHTML = esc("Error: " + e.message);
    if (/credit/i.test(e.message)) setTimeout(openBuyCredits, 700);
  }
  $("#pgGo").disabled = false;
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
    loginError("");
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
  keys:     { page: pageKeys,     mount: mountKeys,     title: "API Keys" },
  usage:    { page: pageUsage,    mount: mountUsage,    title: "Usage" },
  logs:     { page: pageLogs,     mount: mountLogs,     title: "Logs" },
  settings: { page: pageSettings, mount: mountSettings, title: "Settings" },
};
function currentRoute(){
  const r = (location.hash || "#/overview").replace("#/","").split("?")[0];
  return ROUTES[r] ? r : "overview";
}
function render(){
  if (!USER) return;
  const r = currentRoute(), route = ROUTES[r];
  $$("#nav a").forEach(a=>a.classList.toggle("active", a.dataset.route===r));
  document.title = route.title + " · MNAI Console";
  $("#page").innerHTML = route.page();
  if (route.mount) route.mount();
  document.body.classList.remove("nav-open");
  window.scrollTo(0,0);
}

/* ---------- theme ---------- */
function applyTheme(){
  let t = THEME;
  if (t === "system") t = matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  document.documentElement.dataset.theme = t;
}

/* ---------- events ---------- */
window.addEventListener("hashchange", render);
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
  if (mod && ["1","2","3","4","5","6","7"].includes(e.key)){
    e.preventDefault();
    location.hash = "#/"+["overview","models","playground","keys","usage","logs","settings"][+e.key-1];
  }
});

/* ---------- boot ---------- */
applyTheme();
initFirebase();
bindLogin();
$("#paletteBtn").onclick = openPalette;
$("#paletteInput").addEventListener("input", e=>renderPalette(e.target.value));
$("#paletteOverlay").addEventListener("click", e=>{ if(e.target.id==="paletteOverlay") closePalette(); });
$("#modalOverlay").addEventListener("click", e=>{ if(e.target.id==="modalOverlay") closeModal(); });

$("#newKeyBtn").onclick = ()=>{ location.hash="#/keys"; setTimeout(openCreateKey,80); };
$("#themeBtn").onclick = cycleTheme;
$("#menuBtn").onclick = ()=>document.body.classList.toggle("nav-open");
$("#creditsPill").onclick = openBuyCredits;
$("#userChip").onclick = ()=>{ location.hash="#/settings"; };

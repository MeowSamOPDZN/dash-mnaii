/* MNAI Console — demo mode. All data lives in this browser (localStorage). */
"use strict";

/* ---------- utils ---------- */
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}

function fmt(n){ // 1.2M / 34.5K
  if (n >= 1e9) return (n/1e9).toFixed(2)+"B";
  if (n >= 1e6) return (n/1e6).toFixed(2)+"M";
  if (n >= 1e3) return (n/1e3).toFixed(1)+"K";
  return String(Math.round(n));
}
const fmtInt = n => Math.round(n).toLocaleString("en-US");
function timeAgo(ts){
  const s = Math.floor((Date.now()-ts)/1000);
  if (s < 10) return "just now";
  if (s < 60) return s+"s ago";
  const m = Math.floor(s/60); if (m < 60) return m+"m ago";
  const h = Math.floor(m/60); if (h < 24) return h+"h ago";
  const d = Math.floor(h/24); if (d < 30) return d+"d ago";
  return new Date(ts).toLocaleDateString();
}
function fmtDate(ts){ return new Date(ts).toLocaleDateString("en-US",{month:"short",day:"numeric"}); }
function copyText(t, msg){
  (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject())
    .then(()=>toast(msg || "Copied to clipboard"))
    .catch(()=>{ const ta=document.createElement("textarea"); ta.value=t; document.body.appendChild(ta); ta.select(); try{document.execCommand("copy"); toast(msg||"Copied to clipboard");}catch(e){toast("Copy failed","err");} ta.remove(); });
}
function toast(msg, kind){
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = (kind === "err"
    ? '<svg viewBox="0 0 24 24" style="stroke:var(--red)"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5v.1"/></svg>'
    : '<svg viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg>')
    + "<span>"+esc(msg)+"</span>";
  $("#toasts").appendChild(el);
  setTimeout(()=>{ el.style.opacity="0"; el.style.transition="opacity .3s"; setTimeout(()=>el.remove(), 320); }, 2600);
}
function genSecret(){
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const buf = new Uint8Array(32); crypto.getRandomValues(buf);
  let s = ""; for (const b of buf) s += chars[b % 62];
  return "mnai_sk_" + s;
}

/* ---------- store ---------- */
const LS_KEY = "dashmnai.v1";
let DB = null;
function save(){ try{ localStorage.setItem(LS_KEY, JSON.stringify(DB)); }catch(e){} }
function load(){ try{ const d = JSON.parse(localStorage.getItem(LS_KEY)); if (d && d.keys) return d; }catch(e){} return null; }

const MODELS = ["MNAI 6","MNAI 6.1 Pro","MNAI 7","MNAI 7 Pro","Glyph 1","Glyph 1.5","Glyph 2","Glyph 2.5","Glyph 3"];
const MODEL_SHARE = [0.30,0.10,0.16,0.08,0.09,0.07,0.08,0.06,0.06];
const SCOPES = ["chat","images","voice","video"];

function seed(){
  const rnd = mulberry32(20261011);
  const now = Date.now(), DAY = 864e5;
  const keys = [
    {id:uid(), name:"Website — production", secret:genSecret(), createdAt:now-58*DAY, lastUsed:now-4e5, scopes:["chat","images","voice"], expiresAt:null, revoked:false},
    {id:uid(), name:"iOS shortcut", secret:genSecret(), createdAt:now-21*DAY, lastUsed:now-36e5, scopes:["chat"], expiresAt:null, revoked:false},
    {id:uid(), name:"Old test key", secret:genSecret(), createdAt:now-80*DAY, lastUsed:now-70*DAY, scopes:["chat"], expiresAt:null, revoked:true},
  ];
  const keyShare = [0.62, 0.30, 0.08];
  // 60 days of daily stats (last 30 shown, prior 30 for deltas)
  const daily = [];
  for (let i = 59; i >= 0; i--){
    const growth = 1 + (59-i) * 0.012;                 // gentle growth curve
    const wave = 1 + 0.25 * Math.sin(i / 4.5);          // weekly-ish wave
    const req = Math.round(4200 * growth * wave * (0.85 + rnd()*0.3));
    daily.push({ t: now - i*DAY, requests: req, tokens: Math.round(req * (900 + rnd()*700)), errors: Math.round(req * (0.004 + rnd()*0.008)) });
  }
  // per-key totals
  const total30 = daily.slice(30).reduce((a,d)=>a+d.requests,0);
  const totalTok30 = daily.slice(30).reduce((a,d)=>a+d.tokens,0);
  keys.forEach((k,i)=>{ k.requests = Math.round(total30*keyShare[i]*(0.9+rnd()*0.2)); k.tokens = Math.round(totalTok30*keyShare[i]*(0.9+rnd()*0.2)); });
  // 48h hourly for the 24H view
  const hourly = [];
  for (let i = 47; i >= 0; i--){
    const h = new Date(now - i*36e5).getHours();
    const dayCurve = 0.45 + 0.55 * Math.max(0, Math.sin((h-6)/24*Math.PI*2)); // busy midday
    const req = Math.round(230 * dayCurve * (0.8+rnd()*0.4));
    hourly.push({ t: now - i*36e5, requests: req, tokens: Math.round(req*(900+rnd()*700)) });
  }
  // recent logs
  const logs = [];
  const paths = ["/v1/chat/completions","/v1/images/generations","/v1/audio/speech"];
  for (let i = 0; i < 80; i++){
    const k = keys[rnd() < 0.7 ? 0 : 1];
    const err = rnd() < 0.03;
    logs.push({
      id: uid(), ts: now - Math.floor(rnd()*36e5*10),
      model: MODELS[weightedPick(rnd, MODEL_SHARE)],
      path: paths[rnd() < 0.82 ? 0 : (rnd() < 0.6 ? 1 : 2)],
      keyId: k.id, tokens: Math.round(300+rnd()*3800),
      ms: Math.round(180+rnd()*2400), status: err ? (rnd()<0.5?429:500) : 200
    });
  }
  logs.sort((a,b)=>b.ts-a.ts);
  return { keys, daily, hourly, logs: logs.slice(0,80),
    settings: { theme: "dark" }, seededAt: now };
}
function weightedPick(rnd, shares){
  let r = rnd(), i = 0;
  while (i < shares.length-1 && (r -= shares[i]) > 0) i++;
  return i;
}
function activeKeys(){ return DB.keys.filter(k=>!k.revoked); }

/* ---------- charts ---------- */
function setupCanvas(cv, h){
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth;
  cv.width = w*dpr; cv.height = h*dpr;
  const ctx = cv.getContext("2d"); ctx.scale(dpr,dpr);
  return {ctx, w, h};
}
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

function areaChart(cv, points, opts){
  // points: [{t, v}], opts: {color, label}
  opts = opts || {};
  const H = parseInt(getComputedStyle(cv).height) || 260;
  const {ctx, w, h} = setupCanvas(cv, H);
  const padL = 44, padR = 12, padT = 14, padB = 26;
  const iw = w-padL-padR, ih = h-padT-padB;
  const vals = points.map(p=>p.v);
  let max = Math.max(...vals, 1); max *= 1.12;
  const X = i => padL + iw * i/(points.length-1);
  const Y = v => padT + ih * (1 - v/max);
  const line = css("--chart-line") || "#fff";
  const gridC = css("--border-soft") || "rgba(128,128,128,.15)";
  const txtC = css("--text-3") || "#666";

  ctx.clearRect(0,0,w,h);
  ctx.font = "10.5px Geist, sans-serif";
  // gridlines
  for (let g = 0; g <= 4; g++){
    const v = max*g/4, y = Y(v);
    ctx.strokeStyle = gridC; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL,y); ctx.lineTo(w-padR,y); ctx.stroke();
    ctx.fillStyle = txtC; ctx.textAlign = "right";
    ctx.fillText(fmt(v), padL-8, y+3.5);
  }
  // x labels (sparse)
  ctx.textAlign = "center";
  const step = Math.max(1, Math.floor(points.length/6));
  ctx.fillStyle = txtC;
  for (let i = 0; i < points.length; i += step) ctx.fillText(fmtDate(points[i].t), X(i), h-8);

  // area
  const grad = ctx.createLinearGradient(0,padT,0,h-padB);
  const accent = opts.color || line;
  grad.addColorStop(0, hexA(accent,.22)); grad.addColorStop(1, hexA(accent,0));
  ctx.beginPath();
  points.forEach((p,i)=> i ? ctx.lineTo(X(i),Y(p.v)) : ctx.moveTo(X(0),Y(p.v)));
  ctx.lineTo(X(points.length-1), h-padB); ctx.lineTo(X(0), h-padB); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();
  // line
  ctx.beginPath();
  points.forEach((p,i)=> i ? ctx.lineTo(X(i),Y(p.v)) : ctx.moveTo(X(0),Y(p.v)));
  ctx.strokeStyle = accent; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.stroke();

  // hover
  const tip = document.createElement("div");
  tip.className = "chart-tip"; cv.parentElement.style.position = "relative";
  cv.parentElement.appendChild(tip);
  cv.onmousemove = e => {
    const r = cv.getBoundingClientRect();
    const mx = e.clientX - r.left;
    let i = Math.round((mx-padL)/iw*(points.length-1));
    i = Math.max(0, Math.min(points.length-1, i));
    const p = points[i];
    ctx.clearRect(0,0,w,h); areaChartStatic();
    ctx.strokeStyle = gridC; ctx.setLineDash([4,4]);
    ctx.beginPath(); ctx.moveTo(X(i),padT); ctx.lineTo(X(i),h-padB); ctx.stroke(); ctx.setLineDash([]);
    ctx.beginPath(); ctx.arc(X(i),Y(p.v),4,0,7); ctx.fillStyle = accent; ctx.fill();
    ctx.strokeStyle = css("--bg"); ctx.lineWidth = 2; ctx.stroke();
    tip.style.display = "block";
    tip.innerHTML = "<b>"+fmtInt(p.v)+"</b> "+esc(opts.label||"")+"<span>"+new Date(p.t).toLocaleString("en-US",{month:"short",day:"numeric",hour:"numeric"})+"</span>";
    const tx = Math.min(Math.max(X(i)-60, 4), w-150);
    tip.style.left = tx+"px"; tip.style.top = Math.max(Y(p.v)-64, 0)+"px";
  };
  cv.onmouseleave = () => { tip.style.display = "none"; ctx.clearRect(0,0,w,h); areaChartStatic(); };
  function areaChartStatic(){
    for (let g = 0; g <= 4; g++){ const v=max*g/4,y=Y(v); ctx.strokeStyle=gridC; ctx.lineWidth=1; ctx.beginPath(); ctx.moveTo(padL,y); ctx.lineTo(w-padR,y); ctx.stroke(); ctx.fillStyle=txtC; ctx.textAlign="right"; ctx.fillText(fmt(v),padL-8,y+3.5); }
    ctx.textAlign="center"; ctx.fillStyle=txtC;
    for (let i=0;i<points.length;i+=step) ctx.fillText(fmtDate(points[i].t),X(i),h-8);
    const gr=ctx.createLinearGradient(0,padT,0,h-padB); gr.addColorStop(0,hexA(accent,.22)); gr.addColorStop(1,hexA(accent,0));
    ctx.beginPath(); points.forEach((p,i)=> i?ctx.lineTo(X(i),Y(p.v)):ctx.moveTo(X(0),Y(p.v))); ctx.lineTo(X(points.length-1),h-padB); ctx.lineTo(X(0),h-padB); ctx.closePath(); ctx.fillStyle=gr; ctx.fill();
    ctx.beginPath(); points.forEach((p,i)=> i?ctx.lineTo(X(i),Y(p.v)):ctx.moveTo(X(0),Y(p.v))); ctx.strokeStyle=accent; ctx.lineWidth=2; ctx.lineJoin="round"; ctx.stroke();
  }
}
function hexA(hex, a){
  hex = hex.replace("#","");
  if (hex.length === 3) hex = hex.split("").map(c=>c+c).join("");
  const r = parseInt(hex.slice(0,2),16), g = parseInt(hex.slice(2,4),16), b = parseInt(hex.slice(4,6),16);
  return "rgba("+r+","+g+","+b+","+a+")";
}
function donutChart(cv, segments){
  // segments: [{label, v, color}]
  const H = 200, {ctx, w} = setupCanvas(cv, H);
  const cx = w/2, cy = H/2, R = 78, r0 = 54;
  const total = segments.reduce((a,s)=>a+s.v,0) || 1;
  let a0 = -Math.PI/2;
  ctx.clearRect(0,0,w,H);
  segments.forEach(s=>{
    const a1 = a0 + (s.v/total)*Math.PI*2;
    ctx.beginPath(); ctx.arc(cx,cy,R,a0,a1); ctx.arc(cx,cy,r0,a1,a0,true); ctx.closePath();
    ctx.fillStyle = s.color; ctx.fill();
    a0 = a1;
  });
  ctx.fillStyle = css("--text"); ctx.textAlign = "center";
  ctx.font = "700 22px Geist, sans-serif";
  ctx.fillText(fmt(total), cx, cy+2);
  ctx.font = "11px Geist, sans-serif"; ctx.fillStyle = css("--text-3");
  ctx.fillText("requests", cx, cy+20);
}

/* ---------- modal ---------- */
function openModal(html){
  $("#modal").innerHTML = html;
  $("#modalOverlay").classList.remove("hidden");
}
function closeModal(){ $("#modalOverlay").classList.add("hidden"); }

/* ---------- command palette ---------- */
const COMMANDS = [
  {group:"Go to", label:"Overview", hint:"⌘1", run:()=>location.hash="#/overview", icon:'<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/>'},
  {group:"Go to", label:"API Keys", hint:"⌘2", run:()=>location.hash="#/keys", icon:'<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9m-4 4l3 3"/>'},
  {group:"Go to", label:"Usage", hint:"⌘3", run:()=>location.hash="#/usage", icon:'<path d="M3 3v18h18"/><path d="M7 15l4-5 3 3 5-7"/>'},
  {group:"Go to", label:"Logs", hint:"⌘4", run:()=>location.hash="#/logs", icon:'<path d="M8 6h13M8 12h13M8 18h13"/>'},
  {group:"Go to", label:"Settings", hint:"⌘5", run:()=>location.hash="#/settings", icon:'<circle cx="12" cy="12" r="3"/>'},
  {group:"Actions", label:"Create API key", hint:"N", run:()=>openCreateKey(), icon:'<path d="M12 5v14M5 12h14"/>'},
  {group:"Actions", label:"Toggle theme", hint:"T", run:()=>cycleTheme(), icon:'<path d="M21 12.8A9 9 0 1111.2 3 7 7 0 0021 12.8z"/>'},
  {group:"Actions", label:"Export demo data (JSON)", hint:"", run:()=>exportData(), icon:'<path d="M12 3v12m0 0l-4-4m4 4l4-4M4 21h16"/>'},
  {group:"Actions", label:"Regenerate demo data", hint:"", run:()=>{ if(confirm("Regenerate all demo data? Your keys will be replaced.")){ DB = seed(); save(); render(); toast("Demo data regenerated"); } }, icon:'<path d="M21 12a9 9 0 11-2.6-6.4M21 4v5h-5"/>'},
];
let palSel = 0;
function openPalette(){
  $("#paletteOverlay").classList.remove("hidden");
  $("#paletteInput").value = "";
  renderPalette("");
  setTimeout(()=>$("#paletteInput").focus(), 30);
}
function closePalette(){ $("#paletteOverlay").classList.add("hidden"); }
function renderPalette(q){
  q = q.toLowerCase();
  const list = COMMANDS.filter(c=>c.label.toLowerCase().includes(q));
  palSel = 0;
  let html = "", lastGroup = "";
  list.forEach((c)=>{
    if (c.group !== lastGroup){ html += '<div class="pal-group">'+c.group+"</div>"; lastGroup = c.group; }
    html += '<div class="pal-item" data-i="'+COMMANDS.indexOf(c)+'"><svg viewBox="0 0 24 24">'+c.icon+"</svg>"+esc(c.label)+(c.hint?'<span class="hint">'+c.hint+"</span>":"")+"</div>";
  });
  $("#paletteList").innerHTML = html || '<div class="empty">No matches</div>';
  $$(".pal-item").forEach(el=>{
    el.onclick = ()=>{ closePalette(); COMMANDS[+el.dataset.i].run(); };
  });
  markPalSel();
}
function markPalSel(){
  const items = $$(".pal-item");
  items.forEach((el,i)=>el.classList.toggle("sel", i===palSel));
  if (items[palSel] && items[palSel].scrollIntoView) items[palSel].scrollIntoView({block:"nearest"});
}

/* ---------- shared bits ---------- */
function masked(secret){ return esc(secret.slice(0,11)) + "••••" + esc(secret.slice(-4)); }
function keyCell(k){
  return '<div class="key-cell"><span class="mono">'+masked(k.secret)+'</span>'
    + '<button class="copy-btn" data-copy="'+esc(k.secret)+'" title="Copy full key"><svg viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 012-2h10"/></svg></button></div>';
}
function scopeTags(scopes){ return scopes.map(s=>'<span class="scope-tag">'+esc(s)+"</span>").join(""); }
function statusBadge(k){
  if (k.revoked) return '<span class="badge red">Revoked</span>';
  if (k.expiresAt && k.expiresAt < Date.now()) return '<span class="badge amber">Expired</span>';
  return '<span class="badge green">Active</span>';
}
function bindCopy(root){
  $$("[data-copy]", root).forEach(b=>{ b.onclick = e=>{ e.stopPropagation(); copyText(b.dataset.copy); }; });
}
function deltaHTML(cur, prev, invert){
  if (!prev) return '<span class="delta-flat">—</span>';
  const pct = ((cur-prev)/prev*100);
  const up = pct >= 0;
  const good = invert ? !up : up;
  const cls = Math.abs(pct) < 0.5 ? "delta-flat" : (good ? "delta-up" : "delta-down");
  const arrow = Math.abs(pct) < 0.5 ? "→" : (up ? "↑" : "↓");
  return '<span class="'+cls+'">'+arrow+" "+Math.abs(pct).toFixed(1)+'% <span style="color:var(--text-3)">vs prev 30d</span></span>';
}

/* ---------- overview ---------- */
function pageOverview(){
  const last30 = DB.daily.slice(-30), prev30 = DB.daily.slice(0,30);
  const sum = (arr,f)=>arr.reduce((a,d)=>a+f(d),0);
  const req = sum(last30,d=>d.requests), reqP = sum(prev30,d=>d.requests);
  const tok = sum(last30,d=>d.tokens), tokP = sum(prev30,d=>d.tokens);
  const err = sum(last30,d=>d.errors), errP = sum(prev30,d=>d.errors);
  const errRate = (err/req*100), errRateP = (errP/reqP*100);
  const act = activeKeys();
  const recent = DB.logs.slice(0,6);
  const colors = ["#0070f3","#7928ca","#00c853","#f5a623","#ff4545","#00b8d4","#a1a1a1","#ff7ab8","#7c5cff"];

  return `
  <div class="page-head"><div><h1>Overview</h1><p>Your MNAI API at a glance — last 30 days.</p></div>
    <div class="page-actions"><button class="btn" onclick="exportData()"><svg viewBox="0 0 24 24"><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 21h16"/></svg><span>Export</span></button></div></div>
  <div class="grid stats">
    <div class="card stat"><div class="stat-label">Total requests</div><div class="stat-value">${fmt(req)}</div><div class="stat-delta">${deltaHTML(req,reqP)}</div></div>
    <div class="card stat"><div class="stat-label">Tokens processed</div><div class="stat-value">${fmt(tok)}</div><div class="stat-delta">${deltaHTML(tok,tokP)}</div></div>
    <div class="card stat"><div class="stat-label">Active API keys</div><div class="stat-value">${act.length}</div><div class="stat-delta"><span class="delta-flat">${DB.keys.length-act.length} revoked</span></div></div>
    <div class="card stat"><div class="stat-label">Error rate</div><div class="stat-value">${errRate.toFixed(2)}%</div><div class="stat-delta">${deltaHTML(errRate,errRateP,true)}</div></div>
  </div>
  <div class="grid cols-2">
    <div class="card"><div class="card-head"><h2>Requests</h2><span class="sub">per day</span></div><canvas class="chart" id="chReq"></canvas></div>
    <div class="card"><div class="card-head"><h2>Requests by model</h2><span class="sub">last 30 days</span></div>
      <div style="display:flex;gap:20px;align-items:center;flex-wrap:wrap"><canvas class="chart sm" id="chModels" style="max-width:280px"></canvas>
      <div style="flex:1;min-width:180px">${MODELS.map((m,i)=>'<div class="bar-row" style="padding:6px 0"><span class="act-dot" style="background:'+colors[i]+'"></span><span class="bar-label">'+m+'</span><span class="bar-val">'+(MODEL_SHARE[i]*100).toFixed(0)+'%</span></div>').join("")}</div></div>
    </div>
  </div>
  <div class="card" style="margin-top:16px"><div class="card-head"><h2>Recent activity</h2><a href="#/logs" class="btn sm">View all logs</a></div>
    <div class="activity">${recent.map(logRow).join("")}</div></div>`;
}
function logRow(l){
  const k = DB.keys.find(x=>x.id===l.keyId);
  const ok = l.status < 400;
  return '<div class="act-row"><span class="act-dot" style="background:'+(ok?"var(--green)":"var(--red)")+'"></span>'
    + '<div><b class="mono">'+esc(l.model)+'</b> <span style="color:var(--text-3)">·</span> <span class="mono" style="color:var(--text-2)">'+esc(l.path)+'</span><br>'
    + '<span style="color:var(--text-3);font-size:12px">'+esc(k?k.name:"unknown key")+" · "+fmtInt(l.tokens)+" tokens · "+l.ms+"ms · <span class='"+(ok?"status-2xx":"status-4xx")+"'>"+l.status+"</span></span></div>"
    + '<span class="time">'+timeAgo(l.ts)+"</span></div>";
}
function mountOverview(){
  areaChart($("#chReq"), DB.daily.slice(-30).map(d=>({t:d.t, v:d.requests})), {label:"requests"});
  donutChart($("#chModels"), MODELS.map((m,i)=>({label:m, v:MODEL_SHARE[i], color:["#0070f3","#7928ca","#00c853","#f5a623","#ff4545","#00b8d4","#a1a1a1","#ff7ab8","#7c5cff"][i]})));
}

/* ---------- keys ---------- */
function pageKeys(){
  const rows = DB.keys.map(k=>`
    <tr>
      <td><b>${esc(k.name)}</b><div style="color:var(--text-3);font-size:12px;margin-top:2px">Created ${timeAgo(k.createdAt)}${k.expiresAt ? " · expires "+new Date(k.expiresAt).toLocaleDateString() : ""}</div></td>
      <td>${keyCell(k)}</td>
      <td>${scopeTags(k.scopes)}</td>
      <td class="mono">${fmt(k.requests||0)}</td>
      <td style="color:var(--text-3);font-size:12.5px">${k.lastUsed?timeAgo(k.lastUsed):"never"}</td>
      <td>${statusBadge(k)}</td>
      <td style="text-align:right;white-space:nowrap">${k.revoked
        ? '<button class="btn sm danger" data-del="'+k.id+'">Delete</button>'
        : '<button class="btn sm danger" data-revoke="'+k.id+'">Revoke</button>'}</td>
    </tr>`).join("");
  return `
  <div class="page-head"><div><h1>API Keys</h1><p>Create and manage keys for the MNAI API. Demo mode — keys live in this browser only.</p></div>
    <div class="page-actions"><button class="btn primary" onclick="openCreateKey()"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg><span>New key</span></button></div></div>
  <div class="table-wrap"><table><thead><tr><th>Name</th><th>Key</th><th>Scopes</th><th>Requests</th><th>Last used</th><th>Status</th><th></th></tr></thead>
  <tbody>${rows || ""}</tbody></table>
  ${DB.keys.length ? "" : '<div class="empty"><svg viewBox="0 0 24 24"><circle cx="8" cy="15" r="4"/><path d="M11 12l9-9m-4 4l3 3"/></svg><h3>No API keys yet</h3><p>Create your first key to get started.</p></div>'}</div>`;
}
function mountKeys(){
  bindCopy($("#page"));
  $$("[data-revoke]").forEach(b=>b.onclick=()=>{
    const k = DB.keys.find(x=>x.id===b.dataset.revoke);
    openModal(`<div class="modal-head"><div><h2>Revoke key?</h2><p>“${esc(k.name)}” will stop working immediately. This can't be undone.</p></div><button class="modal-x" onclick="closeModal()">×</button></div>
      <div class="modal-foot"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn danger" id="cfRevoke">Revoke key</button></div>`);
    $("#cfRevoke").onclick = ()=>{ k.revoked = true; save(); closeModal(); render(); toast("Key revoked"); };
  });
  $$("[data-del]").forEach(b=>b.onclick=()=>{
    if (!confirm("Permanently delete this revoked key?")) return;
    DB.keys = DB.keys.filter(x=>x.id!==b.dataset.del); save(); render(); toast("Key deleted");
  });
}
function openCreateKey(){
  openModal(`
  <div class="modal-head"><div><h2>Create API key</h2><p>Keys start with <span class="mono">mnai_sk_</span> and are shown once.</p></div><button class="modal-x" onclick="closeModal()">×</button></div>
  <div class="modal-body">
    <div class="field"><label>Key name</label><input type="text" id="nkName" placeholder="e.g. Website — production" maxlength="60"></div>
    <div class="field"><label>Scopes</label><div class="checks">
      ${SCOPES.map(s=>'<label class="check"><input type="checkbox" value="'+s+'"'+(s==="chat"?" checked":"")+"> "+s+"</label>").join("")}
    </div></div>
    <div class="field"><label>Expires</label><select id="nkExp">
      <option value="0">Never</option><option value="30">30 days</option><option value="90">90 days</option><option value="365">1 year</option>
    </select></div>
  </div>
  <div class="modal-foot"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn blue" id="nkGo">Create key</button></div>`);
  setTimeout(()=>{ const inp = $("#nkName"); if (inp && document.contains(inp)) inp.focus(); }, 50);
  $("#nkGo").onclick = ()=>{
    const name = $("#nkName").value.trim() || "Untitled key";
    const scopes = $$("#modal .check input:checked").map(i=>i.value);
    if (!scopes.length){ toast("Pick at least one scope","err"); return; }
    const days = +$("#nkExp").value;
    const secret = genSecret();
    const k = { id:uid(), name, secret, createdAt:Date.now(), lastUsed:0, scopes,
      expiresAt: days ? Date.now()+days*864e5 : null, revoked:false, requests:0, tokens:0 };
    DB.keys.unshift(k); save();
    openModal(`
    <div class="modal-head"><div><h2>Key created</h2><p>Copy it now — you won't see it again.</p></div><button class="modal-x" onclick="closeModal();render()">×</button></div>
    <div class="modal-body">
      <div class="key-reveal"><code>${esc(secret)}</code><button class="copy-btn" id="rkCopy" title="Copy"><svg viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 012-2h10"/></svg></button></div>
      <div class="warn"><svg viewBox="0 0 24 24"><path d="M12 9v4m0 4v.1M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/></svg><span>Treat this like a password. Anyone with it can use your quota.</span></div>
    </div>
    <div class="modal-foot"><button class="btn primary" onclick="closeModal();render()">Done</button></div>`);
    $("#rkCopy").onclick = ()=>copyText(secret, "API key copied");
  };
}

/* ---------- usage ---------- */
let usageRange = "30D", usageMetric = "requests";
function pageUsage(){
  return `
  <div class="page-head"><div><h1>Usage</h1><p>Requests and tokens across your keys.</p></div>
    <div class="page-actions">
      <div class="seg" id="uRange">${["24H","7D","30D"].map(r=>'<button data-r="'+r+'" class="'+(r===usageRange?"on":"")+'">'+r+"</button>").join("")}</div>
      <div class="seg" id="uMetric">${["requests","tokens"].map(m=>'<button data-m="'+m+'" class="'+(m===usageMetric?"on":"")+'">'+m[0].toUpperCase()+m.slice(1)+"</button>").join("")}</div>
    </div></div>
  <div class="card"><div class="card-head"><h2 id="uTitle"></h2><span class="sub" id="uTotal"></span></div><canvas class="chart" id="chUsage"></canvas></div>
  <div class="card" style="margin-top:16px"><div class="card-head"><h2>Usage by key</h2><span class="sub">last 30 days</span></div><div id="keyBars"></div></div>`;
}
function usagePoints(){
  if (usageRange === "24H") return DB.hourly.slice(-24).map(h=>({t:h.t, v:usageMetric==="requests"?h.requests:h.tokens}));
  const days = usageRange === "7D" ? 7 : 30;
  return DB.daily.slice(-days).map(d=>({t:d.t, v:usageMetric==="requests"?d.requests:d.tokens}));
}
function mountUsage(){
  const draw = ()=>{
    const pts = usagePoints();
    const total = pts.reduce((a,p)=>a+p.v,0);
    $("#uTitle").textContent = usageMetric[0].toUpperCase()+usageMetric.slice(1)+" — "+(usageRange==="24H"?"last 24 hours":"last "+usageRange.slice(0,-1)+" days");
    $("#uTotal").textContent = fmtInt(total)+" total";
    areaChart($("#chUsage"), pts, {label:usageMetric, color:"#0070f3"});
  };
  draw();
  $$("#uRange button").forEach(b=>b.onclick=()=>{ usageRange=b.dataset.r; $$("#uRange button").forEach(x=>x.classList.toggle("on",x===b)); draw(); });
  $$("#uMetric button").forEach(b=>b.onclick=()=>{ usageMetric=b.dataset.m; $$("#uMetric button").forEach(x=>x.classList.toggle("on",x===b)); draw(); });
  const ks = DB.keys.filter(k=>!k.revoked || (k.requests||0) > 0).sort((a,b)=>(b.requests||0)-(a.requests||0));
  const max = Math.max(...ks.map(k=>k.requests||0), 1);
  $("#keyBars").innerHTML = ks.map(k=>`
    <div class="bar-row"><div class="bar-label">${esc(k.name)}<span class="mono">${masked(k.secret)}</span></div>
    <div class="bar-track"><div class="bar-fill" style="width:${((k.requests||0)/max*100).toFixed(1)}%"></div></div>
    <span class="bar-val">${fmt(k.requests||0)} req</span></div>`).join("")
    || '<div class="empty"><h3>No usage yet</h3></div>';
}

/* ---------- logs ---------- */
let liveLogs = true, logFilter = "all";
function pageLogs(){
  return `
  <div class="page-head"><div><h1>Logs</h1><p>Every API request, newest first.</p></div>
    <div class="page-actions log-filters">
      <select id="logF">
        <option value="all">All statuses</option><option value="ok">2xx only</option><option value="err">Errors only</option>
      </select>
      <label class="live-toggle ${liveLogs?"on":""}" id="liveT"><span class="switch"></span>Live</label>
    </div></div>
  <div class="table-wrap"><table><thead><tr><th>Time</th><th>Model</th><th>Endpoint</th><th>Key</th><th>Tokens</th><th>Latency</th><th>Status</th></tr></thead>
  <tbody id="logBody"></tbody></table></div>`;
}
function renderLogRows(){
  const body = $("#logBody"); if (!body) return;
  const rows = DB.logs.filter(l=> logFilter==="all" || (logFilter==="ok" ? l.status<400 : l.status>=400)).slice(0,60);
  body.innerHTML = rows.map(l=>{
    const k = DB.keys.find(x=>x.id===l.keyId);
    const ok = l.status < 400;
    return "<tr><td style='color:var(--text-3);font-size:12.5px;white-space:nowrap'>"+new Date(l.ts).toLocaleTimeString()+'</td>'
      + '<td><span class="mono">'+esc(l.model)+'</span></td><td><span class="mono" style="color:var(--text-2)">'+esc(l.path)+'</span></td>'
      + "<td style='font-size:12.5px'>"+esc(k?k.name:"—")+"</td><td class='mono'>"+fmtInt(l.tokens)+"</td><td class='mono'>"+l.ms+"ms</td>"
      + '<td><span class="'+(ok?"status-2xx":"status-4xx")+'">'+l.status+"</span></td></tr>";
  }).join("") || '<tr><td colspan="7"><div class="empty"><h3>No logs match</h3></div></td></tr>';
}
function mountLogs(){
  $("#logF").value = logFilter;
  $("#logF").onchange = e=>{ logFilter = e.target.value; renderLogRows(); };
  $("#liveT").onclick = ()=>{ liveLogs = !liveLogs; $("#liveT").classList.toggle("on", liveLogs); };
  renderLogRows();
}

/* ---------- settings ---------- */
function pageSettings(){
  const t = DB.settings.theme;
  return `
  <div class="page-head"><div><h1>Settings</h1><p>Console preferences and demo data.</p></div></div>
  <div class="settings-grid">
    <div class="card"><div class="card-head"><h2>Appearance</h2></div>
      <div class="theme-pick">
        ${["dark","light","system"].map(x=>`
          <div class="theme-opt ${t===x?"on":""}" data-theme-pick="${x}">
            <div class="theme-swatch" style="background:${x==="dark"?"#000":x==="light"?"#fff":"linear-gradient(135deg,#000 50%,#fff 50%)"}"></div>
            ${x[0].toUpperCase()+x.slice(1)}</div>`).join("")}
      </div></div>
    <div class="card"><div class="card-head"><h2>Demo data</h2><span class="sub">stored in this browser</span></div>
      <div class="row-between"><div><div class="t">Export data</div><div class="d">Download everything as JSON.</div></div><button class="btn sm" onclick="exportData()">Export</button></div>
      <div class="row-between"><div><div class="t">Regenerate data</div><div class="d">Fresh keys, stats and logs.</div></div><button class="btn sm" id="regenBtn">Regenerate</button></div>
    </div>
    <div class="card danger-zone"><div class="card-head"><h2 style="color:var(--red)">Danger zone</h2></div>
      <div class="row-between"><div><div class="t">Reset console</div><div class="d">Wipe all keys, stats and logs from this browser.</div></div><button class="btn sm danger" id="resetBtn">Reset everything</button></div>
    </div>
    <div class="card"><div class="card-head"><h2>About</h2></div>
      <div style="font-size:13px;color:var(--text-2);display:flex;flex-direction:column;gap:8px">
        <div><b style="color:var(--text)">MNAI Console</b> · demo mode v1.0</div>
        <div>Keys, usage and logs are simulated and stored only in this browser's localStorage. Connect a backend later for real keys.</div>
        <div class="mono" style="font-size:12px">dash-mnaii · MeowSamOP DZN</div>
      </div></div>
  </div>`;
}
function mountSettings(){
  $$("[data-theme-pick]").forEach(el=>el.onclick=()=>{ setTheme(el.dataset.themePick); render(); });
  $("#regenBtn").onclick = ()=>{ if(confirm("Regenerate all demo data?")){ DB = seed(); applyTheme(); save(); render(); toast("Demo data regenerated"); } };
  $("#resetBtn").onclick = ()=>{ if(confirm("Wipe ALL console data from this browser?")){ localStorage.removeItem(LS_KEY); DB = seed(); applyTheme(); save(); render(); toast("Console reset"); } };
}
function exportData(){
  const blob = new Blob([JSON.stringify(DB,null,2)],{type:"application/json"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = "mnai-console-demo.json"; a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href), 4000);
  toast("Exported demo data");
}

/* ---------- theme ---------- */
function setTheme(t){ DB.settings.theme = t; applyTheme(); save(); }
function cycleTheme(){
  const order = ["dark","light","system"];
  setTheme(order[(order.indexOf(DB.settings.theme)+1)%3]);
  render(); toast("Theme: "+DB.settings.theme);
}
function applyTheme(){
  let t = DB.settings.theme;
  if (t === "system") t = matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  document.documentElement.dataset.theme = t;
}

/* ---------- router ---------- */
const ROUTES = {
  overview: {page:pageOverview, mount:mountOverview, title:"Overview"},
  keys: {page:pageKeys, mount:mountKeys, title:"API Keys"},
  usage: {page:pageUsage, mount:mountUsage, title:"Usage"},
  logs: {page:pageLogs, mount:mountLogs, title:"Logs"},
  settings: {page:pageSettings, mount:mountSettings, title:"Settings"},
};
function render(){
  const r = (location.hash || "#/overview").replace("#/","").split("?")[0];
  const route = ROUTES[r] || ROUTES.overview;
  $$("#nav a").forEach(a=>a.classList.toggle("active", a.dataset.route===(ROUTES[r]?r:"overview")));
  document.title = route.title+" · MNAI Console";
  $("#page").innerHTML = route.page();
  route.mount && route.mount();
  document.body.classList.remove("nav-open");
  window.scrollTo(0,0);
}

/* ---------- live ticker (demo) ---------- */
function tick(){
  if (!liveLogs) return;
  if (!$("#modalOverlay").classList.contains("hidden")) return;
  const rnd = Math.random;
  const act = activeKeys(); if (!act.length) return;
  const k = act[Math.floor(rnd()*act.length)];
  const err = rnd() < 0.03;
  const tokens = Math.round(300+rnd()*3800);
  const l = { id:uid(), ts:Date.now(), model:MODELS[Math.floor(rnd()*MODELS.length)],
    path: rnd()<0.82?"/v1/chat/completions":(rnd()<0.6?"/v1/images/generations":"/v1/audio/speech"),
    keyId:k.id, tokens, ms:Math.round(180+rnd()*2400), status: err?(rnd()<0.5?429:500):200 };
  DB.logs.unshift(l); DB.logs = DB.logs.slice(0,80);
  k.lastUsed = Date.now(); k.requests = (k.requests||0)+1; k.tokens = (k.tokens||0)+tokens;
  const today = DB.daily[DB.daily.length-1], h = DB.hourly[DB.hourly.length-1];
  today.requests++; today.tokens += tokens; if (err) today.errors++;
  h.requests++; h.tokens += tokens;
  save();
  const r = (location.hash||"#/overview").replace("#/","");
  if (r === "logs") renderLogRows();
}

/* ---------- events ---------- */
window.addEventListener("hashchange", render);
window.addEventListener("resize", ()=>{ const r=(location.hash||"#/overview").replace("#/",""); if(ROUTES[r]&&ROUTES[r].mount) ROUTES[r].mount(); });
document.addEventListener("keydown", e=>{
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === "k"){ e.preventDefault(); $("#paletteOverlay").classList.contains("hidden") ? openPalette() : closePalette(); return; }
  if (!$("#paletteOverlay").classList.contains("hidden")){
    if (e.key === "Escape") closePalette();
    if (e.key === "ArrowDown"){ e.preventDefault(); palSel = Math.min(palSel+1, $$(".pal-item").length-1); markPalSel(); }
    if (e.key === "ArrowUp"){ e.preventDefault(); palSel = Math.max(palSel-1, 0); markPalSel(); }
    if (e.key === "Enter"){ const items = $$(".pal-item"); if (items[palSel]) items[palSel].click(); }
    return;
  }
  if (e.key === "Escape") closeModal();
  if (mod && ["1","2","3","4","5"].includes(e.key)){
    e.preventDefault();
    location.hash = "#/"+["overview","keys","usage","logs","settings"][+e.key-1];
  }
});

/* ---------- boot ---------- */
DB = load() || seed();
applyTheme(); save();
$("#paletteBtn").onclick = openPalette;
$("#paletteInput").addEventListener("input", e=>renderPalette(e.target.value));
$("#paletteOverlay").addEventListener("click", e=>{ if (e.target.id === "paletteOverlay") closePalette(); });
$("#modalOverlay").addEventListener("click", e=>{ if (e.target.id === "modalOverlay") closeModal(); });
$("#newKeyBtn").onclick = openCreateKey;
$("#themeBtn").onclick = cycleTheme;
$("#menuBtn").onclick = ()=>document.body.classList.toggle("nav-open");
render();
setInterval(tick, 5000);

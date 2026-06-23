// ══════════════════════════════════════════════════════════
// 📷 OCR IMPORT — snap a team's album page, confirm, mark owned
// ══════════════════════════════════════════════════════════
// Loaded as a sibling <script src="ocr.js"> — shares the global
// scope of index.html, so it uses state/TEAMS/getName/saveLocal/
// saveToFirestore/flash/render directly.
//
// IMPORTANT design note: OCR only PROPOSES. A filled album slot is a
// glossy sticker that usually hides its printed number, so OCR mostly
// reads EMPTY slots. We therefore (a) drive the scan off the team you're
// already viewing, (b) pre-select detected numbers, and (c) require a
// confirm step. Confirm is purely additive — it never removes stickers.

const TESS_CDN = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
let _ov = null; // overlay state: {team, sel:Set<number>, status, msg}

function _ocrLoadTesseract() {
  if (window.Tesseract) return Promise.resolve();
  return new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = TESS_CDN;
    s.onload = res;
    s.onerror = () => rej(new Error("Couldn't load the OCR engine — check your connection."));
    document.head.appendChild(s);
  });
}

// Entry point — wired to the hidden file input's onchange in the team view.
async function paniniOcrFromFile(input) {
  const file = input.files && input.files[0];
  input.value = ""; // allow re-picking the same file
  if (!file) return;
  const tc = state.selTeam;
  if (!tc) { flash("Open a team first, then import"); return; }
  _ov = { team: tc, sel: new Set(), status: "loading" };
  _ocrRender();
  try {
    await _ocrLoadTesseract();
    _ov.status = "scanning"; _ocrRender();
    const worker = await Tesseract.createWorker("eng");
    await worker.setParameters({ tessedit_char_whitelist: "0123456789" });
    const { data } = await worker.recognize(file);
    await worker.terminate();
    (String(data && data.text || "").match(/\d+/g) || []).forEach(t => {
      const n = parseInt(t, 10);
      if (n >= 1 && n <= 20) _ov.sel.add(n);
    });
    _ov.status = "review";
    _ocrRender();
  } catch (e) {
    _ov.status = "error"; _ov.msg = e.message || "Scan failed";
    _ocrRender();
  }
}

// Test/manual hook: open the review grid with a preset number set (no photo).
function paniniOcrReview(tc, numbers) {
  _ov = { team: tc, sel: new Set(numbers || []), status: "review" };
  _ocrRender();
}

function paniniOcrToggle(n) {
  if (!_ov) return;
  const code = _ov.team + n;
  if ((state.stickers[code] || 0) > 0) return; // already owned slots are locked
  _ov.sel.has(n) ? _ov.sel.delete(n) : _ov.sel.add(n);
  _ocrRender();
}

function paniniOcrConfirm() {
  if (!_ov) return;
  const tc = _ov.team;
  let added = 0;
  _ov.sel.forEach(n => {
    const code = tc + n;
    if (!(state.stickers[code] > 0)) { state.stickers[code] = 1; added++; }
  });
  _ocrClose();
  if (added) { saveLocal(); saveToFirestore(); flash(`📷 Imported ${added} sticker${added !== 1 ? "s" : ""}`); }
  else flash("Nothing new selected");
  render();
}

function _ocrClose() { _ov = null; const e = document.getElementById("ocr-ov"); if (e) e.remove(); }

function _ocrRender() {
  if (!_ov) { _ocrClose(); return; }
  let e = document.getElementById("ocr-ov");
  if (!e) { e = document.createElement("div"); e.id = "ocr-ov"; document.body.appendChild(e); }
  const tc = _ov.team, t = (typeof TEAMS !== "undefined" && TEAMS[tc]) || { name: tc, flag: "", color: "#D4AF37" };
  let body;

  if (_ov.status === "loading" || _ov.status === "scanning") {
    body = `<div style="text-align:center;padding:48px 20px">
      <div style="font-size:44px;animation:pulse 1.2s ease infinite">📷</div>
      <p style="color:#fff;margin-top:14px;font-weight:700">${_ov.status === "loading" ? "Loading scanner…" : "Reading photo…"}</p>
      <p style="color:#888;font-size:12px;margin-top:6px">First scan downloads the OCR engine (a few MB). It runs entirely on your phone.</p>
    </div>`;
  } else if (_ov.status === "error") {
    body = `<div style="text-align:center;padding:48px 20px">
      <div style="font-size:40px">⚠️</div>
      <p style="color:#fff;margin-top:12px">${esc(_ov.msg || "Something went wrong")}</p>
      <button class="big-btn" style="margin-top:18px" onclick="_ocrClose()">Close</button>
    </div>`;
  } else { // review
    const sel = _ov.sel;
    const detected = [...sel].filter(n => !(state.stickers[tc + n] > 0)).length;
    const slots = Array.from({ length: 20 }, (_, i) => i + 1).map(n => {
      const code = tc + n;
      const owned = (state.stickers[code] || 0) > 0;
      const on = sel.has(n);
      const bg = owned ? "#22c55e22" : on ? t.color + "33" : "#0e0e1a";
      const bd = owned ? "#22c55e" : on ? t.color : "#1e1e30";
      const tag = owned ? "✓ have" : on ? "＋ add" : "tap";
      const tagc = owned ? "#22c55e" : on ? "#fff" : "#555";
      return `<button onclick="paniniOcrToggle(${n})" style="border-radius:8px;padding:7px 2px;text-align:center;border:1.5px solid ${bd};background:${bg};color:#fff;cursor:${owned ? "default" : "pointer"}">
        <div style="font-family:'Oswald',sans-serif;font-size:12px;font-weight:700">${code}</div>
        <div style="font-size:7px;color:#aaa;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(getName(code))}</div>
        <div style="font-size:10px;margin-top:3px;color:${tagc}">${tag}</div>
      </button>`;
    }).join("");
    const note = detected
      ? `${detected} slot${detected !== 1 ? "s" : ""} detected and pre-selected. Tap to fix mistakes, then confirm.`
      : `No numbers detected — the sticker glare may have hidden them. Tap the ones you have, or retake the photo straighter.`;
    body = `<div style="padding:16px 16px 0">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px"><span style="font-size:24px">${t.flag}</span><b style="font-size:17px">${esc(t.name)} — Import</b></div>
        <p style="color:#888;font-size:12px;line-height:1.5;margin-bottom:14px">${note}<br><span style="color:#666">We only add stickers — nothing is ever removed.</span></p>
      </div>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;padding:0 16px">${slots}</div>
      <div style="position:sticky;bottom:0;background:var(--card);padding:14px 16px;margin-top:16px;display:flex;gap:8px;border-top:1px solid var(--border)">
        <button class="big-btn" style="margin:0;flex:1;background:var(--card);color:#fff;border:1px solid var(--border)" onclick="_ocrClose()">Cancel</button>
        <button class="big-btn" style="margin:0;flex:2" onclick="paniniOcrConfirm()">Add ${detected} sticker${detected !== 1 ? "s" : ""}</button>
      </div>`;
  }

  e.innerHTML = `<div style="position:fixed;inset:0;background:#000000cc;z-index:1000;display:flex;align-items:flex-end;justify-content:center" onclick="if(event.target===this)_ocrClose()">
    <div style="background:var(--bg);width:100%;max-width:480px;max-height:90vh;overflow-y:auto;border-radius:16px 16px 0 0;border:1px solid var(--border)">${body}</div>
  </div>`;
}

// ══════════════════════════════════════════════════════════
// 🔍 SMART SCAN — Gemini vision via the Supabase proxy (cross-team)
// ══════════════════════════════════════════════════════════
// Reads ANY photo of stickers (loose or album page), maps recognized players
// to album codes by NAME (disambiguated by team), shows a confirm list.
// Set this to your deployed function URL after `supabase functions deploy scan`:
const PANINI_SCAN_URL = "https://xtqlagghvkowhdaxveiv.supabase.co/functions/v1/scan";

let _smart = null, _nameIndex = null, _teamByName = null;

function _norm(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}
function _buildIndex() {
  if (_nameIndex) return;
  _nameIndex = {};
  ALL_CODES.forEach(c => {
    const n = getName(c);
    if (!n || n === c || /^team (logo|photo)$/i.test(n)) return; // skip generic repeated names
    const k = _norm(n);
    (_nameIndex[k] || (_nameIndex[k] = [])).push(c);
  });
  _teamByName = {};
  Object.entries(TEAMS).forEach(([code, t]) => { _teamByName[_norm(t.name)] = code; });
}
function _teamCode(name) {
  if (!name) return null;
  const k = _norm(name);
  if (_teamByName[k]) return _teamByName[k];
  for (const [n, code] of Object.entries(_teamByName)) if (k && (n.includes(k) || k.includes(n))) return code;
  return null;
}
// Map Gemini's [{name, team?, number?}] onto album codes. Exported for testing.
function paniniMatchItems(items) {
  _buildIndex();
  const out = [], seen = new Set();
  (items || []).forEach(it => {
    const q = _norm(it.name);
    if (!q) return;
    let cands = _nameIndex[q];
    if (!cands) { // fuzzy fallback: every query token (len>2) appears in a stored name
      const toks = q.split(" ").filter(w => w.length > 2);
      if (toks.length) cands = Object.keys(_nameIndex).filter(k => toks.every(t => k.includes(t))).flatMap(k => _nameIndex[k]);
    }
    if (!cands || !cands.length) return;
    const tc = _teamCode(it.team);
    let pick = cands;
    if (tc) { const byTeam = cands.filter(c => teamForCode(c) === tc); if (byTeam.length) pick = byTeam; }
    if (tc && it.number && pick.includes(tc + it.number)) pick = [tc + it.number];
    const code = pick[0];
    if (seen.has(code)) return;
    seen.add(code);
    out.push({ code, name: getName(code), team: teamForCode(code), ambiguous: pick.length > 1 });
  });
  return out;
}

// Downscale to ~1024px long edge before upload — keeps Gemini image cost to
// ~4 tiles (~1k tokens) instead of ~7k for a full-res phone photo, and uploads faster.
function _scaledB64(file, maxEdge = 1024) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      c.getContext("2d").drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(img.src);
      res(c.toDataURL("image/jpeg", 0.85).split(",")[1]);
    };
    img.onerror = rej;
    img.src = URL.createObjectURL(file);
  });
}

async function paniniSmartScan(input) {
  const file = input.files && input.files[0];
  input.value = "";
  if (!file) return;
  if (!PANINI_SCAN_URL) { flash("Smart scan isn't set up yet"); return; }
  _smart = { status: "scanning" }; _smartRender();
  try {
    const b64 = await _scaledB64(file); // re-encoded as JPEG
    const r = await fetch(PANINI_SCAN_URL, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ image: b64, mimeType: "image/jpeg" }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || ("HTTP " + r.status));
    const matched = paniniMatchItems(data.items || []);
    _smart = { status: "review", items: matched.map(m => ({ ...m, on: true })) };
    _smartRender();
  } catch (e) {
    _smart = { status: "error", msg: e.message }; _smartRender();
  }
}

function paniniSmartToggle(i) { if (_smart && _smart.items && _smart.items[i]) { _smart.items[i].on = !_smart.items[i].on; _smartRender(); } }
function paniniSmartConfirm() {
  if (!_smart || !_smart.items) return;
  let added = 0;
  _smart.items.forEach(m => { if (m.on && !(state.stickers[m.code] > 0)) { state.stickers[m.code] = 1; added++; } });
  _smartClose();
  if (added) { saveLocal(); saveToFirestore(); flash(`📷 Imported ${added} sticker${added !== 1 ? "s" : ""}`); }
  else flash("Nothing new selected");
  render();
}
function _smartClose() { _smart = null; const e = document.getElementById("smart-ov"); if (e) e.remove(); }

function _smartRender() {
  if (!_smart) { _smartClose(); return; }
  let e = document.getElementById("smart-ov");
  if (!e) { e = document.createElement("div"); e.id = "smart-ov"; document.body.appendChild(e); }
  let body;
  if (_smart.status === "scanning") {
    body = `<div style="text-align:center;padding:48px 20px">
      <div style="font-size:44px;animation:pulse 1.2s ease infinite">🔍</div>
      <p style="color:#fff;margin-top:14px;font-weight:700">Reading your photo…</p>
      <p style="color:#888;font-size:12px;margin-top:6px">AI is identifying the stickers</p></div>`;
  } else if (_smart.status === "error") {
    body = `<div style="text-align:center;padding:48px 20px"><div style="font-size:40px">⚠️</div>
      <p style="color:#fff;margin-top:12px">${esc(_smart.msg || "Scan failed")}</p>
      <button class="big-btn" style="margin-top:18px" onclick="_smartClose()">Close</button></div>`;
  } else {
    const items = _smart.items;
    const newCount = items.filter(m => !(state.stickers[m.code] > 0)).length;
    const haveCount = items.length - newCount;
    const n = items.filter(m => m.on && !(state.stickers[m.code] > 0)).length;
    const rows = items.length ? items.map((m, i) => {
      const t = m.team ? TEAMS[m.team] : null;
      const owned = (state.stickers[m.code] || 0) > 0; // already in album — greyed, not re-added
      const icon = owned ? "✅" : (m.on ? "☑" : "☐");
      const bg = owned ? "#0c0c14" : (m.on ? (t ? t.color + "22" : "#D4AF3722") : "#0e0e1a");
      const sub = owned ? "already in your album — won't be added"
        : `${m.code}${t ? " · " + t.name : ""}${m.ambiguous ? " · ⚠ check team" : ""}`;
      return `<button ${owned ? "" : `onclick="paniniSmartToggle(${i})"`} style="width:100%;display:flex;align-items:center;gap:10px;padding:10px 12px;background:${bg};border:none;border-bottom:1px solid var(--border);text-align:left;color:#fff;cursor:${owned ? "default" : "pointer"};${owned ? "opacity:.55" : ""}">
        <span style="font-size:18px">${icon}</span><span style="font-size:18px">${t ? t.flag : "🏆"}</span>
        <div style="flex:1"><div style="font-size:14px;color:${owned ? "#888" : "#fff"}">${esc(m.name)}</div>
        <div style="font-size:11px;color:#888">${sub}</div></div>
      </button>`;
    }).join("") : `<p style="color:#888;font-size:13px;padding:24px;text-align:center">No stickers recognized. Try a clearer, straighter photo with less glare.</p>`;
    body = `<div style="padding:16px 16px 8px"><b style="font-size:17px">📷 Found ${items.length} — ${newCount} new to add</b>
      <p style="color:#888;font-size:12px;margin-top:4px">${haveCount ? `${haveCount} already in your album (greyed out, skipped). ` : ""}Tap to deselect any wrong ones, then confirm. We only add — nothing is removed.</p></div>
      <div>${rows}</div>
      <div style="position:sticky;bottom:0;background:var(--card);padding:14px 16px;display:flex;gap:8px;border-top:1px solid var(--border)">
        <button class="big-btn" style="margin:0;flex:1;background:var(--card);color:#fff;border:1px solid var(--border)" onclick="_smartClose()">Cancel</button>
        <button class="big-btn" style="margin:0;flex:2" onclick="paniniSmartConfirm()">Add ${n} sticker${n !== 1 ? "s" : ""}</button>
      </div>`;
  }
  e.innerHTML = `<div style="position:fixed;inset:0;background:#000000cc;z-index:1000;display:flex;align-items:flex-end;justify-content:center" onclick="if(event.target===this)_smartClose()">
    <div style="background:var(--bg);width:100%;max-width:480px;max-height:90vh;overflow-y:auto;border-radius:16px 16px 0 0;border:1px solid var(--border)">${body}</div>
  </div>`;
}

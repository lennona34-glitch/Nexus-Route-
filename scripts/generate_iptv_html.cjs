const fs = require('fs');
const path = require('path');

const srcPath = path.resolve(__dirname, 'extracted_iptv_amp_3.9.html');
const destPath = path.resolve(__dirname, '..', 'src', 'web', 'public', 'iptv.html');

let html = fs.readFileSync(srcPath, 'utf8');

// 1. Update Title and metadata
html = html.replace('<title>IPTV AMP v3.9</title>', '<title>Nexus Route · IPTV AMP Broadcast Deck (TV & Radio)</title>');

// 2. Add styles for Nexus Radio Screen and Archive Panel
const customStyles = `
/* ---------- Nexus Radio Phosphor Screen ---------- */
#nexusRadioScreen{
  position:absolute; inset:0; z-index:5; display:none; flex-direction:column;
  align-items:center; justify-content:center; padding:18px; text-align:center;
  background:radial-gradient(ellipse at center, rgba(var(--phos), 0.16) 0%, rgba(5,10,5, 0.94) 80%);
  pointer-events:none;
}
#nexusRadioScreen.active{display:flex}
.nrs-glow-badge{
  width:88px; height:88px; margin-bottom:12px;
  filter:drop-shadow(0 0 16px rgba(var(--phos), 0.85));
  animation:nrsPulse 2.8s ease-in-out infinite;
}
@keyframes nrsPulse{
  0%,100%{transform:scale(1); opacity:.9}
  50%{transform:scale(1.05); opacity:1}
}
.nrs-deck-title{
  font-size:12px; font-weight:700; letter-spacing:.22em; color:var(--lcd);
  text-shadow:0 0 10px rgba(var(--phos), 0.85); margin-bottom:5px;
}
.nrs-prompt-text{
  font-size:16.5px; font-weight:700; letter-spacing:.14em; color:#ffffff;
  text-shadow:0 0 14px rgba(var(--phos), 0.9); margin-bottom:14px;
}
.nrs-station-box{
  background:rgba(0,0,0,0.72); border:1px solid var(--lcd-dim);
  border-radius:4px; padding:7px 16px; margin-bottom:12px; max-width:88%;
  box-shadow:inset 0 0 12px rgba(0,0,0,0.85);
}
.nrs-tuned-label{
  font-size:9.5px; color:var(--lcd-dim); letter-spacing:.16em; margin-bottom:3px;
}
.nrs-station-name{
  font-size:14px; font-weight:700; color:var(--lcd-hi); letter-spacing:.06em;
  text-shadow:0 0 8px rgba(var(--phos), 0.7); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
}
.nrs-canvas{
  width:min(480px, 92%); height:68px; margin-bottom:10px;
  border-bottom:1px solid rgba(var(--phos), 0.4);
}
.nrs-meta-line{
  font-size:10px; color:var(--lcd-dim); letter-spacing:.12em;
}

/* ---------- Internet Archive Modal ---------- */
#archivepanel{
  display:none; position:fixed; inset:24px; z-index:99999; background:var(--skin);
  border:2px solid var(--skin-hi); box-shadow:0 20px 60px rgba(0,0,0,.95); flex-direction:column; padding:0;
  border-radius:6px; overflow:hidden;
}
#archivepanel.show{display:flex}
.arc-header{
  background:var(--skin-hi); padding:8px 14px; display:flex; align-items:center;
  justify-content:space-between; border-bottom:1px solid rgba(0,0,0,0.6);
}
.arc-card{
  background:var(--skin-face); border:1px solid var(--skin-hi); border-radius:4px;
  padding:10px; display:flex; flex-direction:column; gap:6px; cursor:pointer;
  transition:all .15s ease;
}
.arc-card:hover{
  border-color:var(--acc); background:var(--fold-hover); transform:translateY(-2px);
  box-shadow:0 4px 14px rgba(0,0,0,0.5);
}
.arc-thumb{
  width:100%; height:130px; object-fit:cover; border-radius:3px;
  background:#000; border:1px solid rgba(255,255,255,0.1);
}
.arc-title{
  font-size:12px; font-weight:700; color:var(--title-txt); line-height:1.3;
  overflow:hidden; text-overflow:ellipsis; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical;
}
.arc-meta{
  font-size:10px; color:var(--txt-dim); display:flex; justify-content:space-between;
}
.arc-actions{
  display:flex; gap:6px; margin-top:auto;
}
.arc-btn{
  flex:1; padding:5px; font-size:10.5px; font-weight:700; border-radius:3px;
  background:var(--skin); border:1px solid var(--skin-hi); color:var(--ui-ink);
  cursor:pointer; text-align:center;
}
.arc-btn.primary{
  background:rgba(var(--acc-rgb), 0.2); border-color:var(--acc); color:var(--acc-hi);
}
.arc-btn:hover{filter:brightness(1.2)}
.btn-arc-pill{
  padding:4px 8px; font-size:10px; font-weight:600; border-radius:3px;
  background:var(--skin); border:1px solid var(--skin-hi); color:var(--ui-ink); cursor:pointer;
}
.btn-arc-pill:hover{border-color:var(--acc); color:var(--acc-hi)}
`;

html = html.replace('</style>', customStyles + '\n</style>');

// 3. Inject Nexus Radio Screen inside #screenwrap
const radioScreenHtml = `
        <!-- Nexus Route Phosphor Radio Screen -->
        <div id="nexusRadioScreen" class="nexus-radio-screen">
          <div class="nrs-glow-badge">
            <svg class="nrs-logo-icon" viewBox="0 0 100 100" fill="none">
              <polygon points="50,5 90,27.5 90,72.5 50,95 10,72.5 10,27.5" stroke="var(--lcd)" stroke-width="4" fill="rgba(var(--phos), 0.12)"/>
              <polygon points="50,18 78,34 78,66 50,82 22,66 22,34" stroke="var(--lcd-dim)" stroke-width="2" fill="none"/>
              <circle cx="50" cy="50" r="14" fill="var(--lcd)" opacity="0.85"/>
              <circle cx="50" cy="50" r="7" fill="#ffffff"/>
              <path d="M50 24 L50 40 M50 60 L50 76 M28 50 L40 50 M60 50 L72 50" stroke="var(--lcd-hi)" stroke-width="2"/>
            </svg>
          </div>
          <div class="nrs-deck-title">▲ NEXUS ROUTE BROADCAST DECK ▲</div>
          <div class="nrs-prompt-text">"WHAT WOULD YOU LIKE TO BUILD?"</div>
          <div class="nrs-station-box">
            <div class="nrs-tuned-label">TUNED AUDIO / RADIO CARRIER:</div>
            <div class="nrs-station-name" id="nrsStationName">STANDBY · WAITING FOR AUDIO CARRIER</div>
          </div>
          <canvas id="nrsVisualizer" width="460" height="70" class="nrs-canvas"></canvas>
          <div class="nrs-meta-line">
            <span>PHOSPHOR AUDIO MONITOR ACTIVE</span> &bull; <span>44.1kHz / 16-BIT STEREO</span> &bull; <span>CRT MATRIX</span>
          </div>
        </div>
`;

html = html.replace('<div id="recdot">', radioScreenHtml + '\n        <div id="recdot">');

// 4. Add [ 📻 RADIO ] and [ 🏛️ ARCHIVE ] buttons in #plfoot
const buttonsHtml = `
        <button class="btn" id="bRadio" title="Load 3,000 Wavelength Global Radio Stations into Playlist" style="color:var(--acc);font-weight:bold">&#128251; RADIO (3K)</button>
        <button class="btn" id="bArchive" title="Search & Browse Internet Archive Cinema, Vintage TV & OTR" style="color:#ffd23a;font-weight:bold">&#127963; ARCHIVE</button>
`;

html = html.replace('<button class="btn" id="bOpen">OPEN FILE</button>', buttonsHtml + '\n        <button class="btn" id="bOpen">OPEN FILE</button>');

// 5. Add Archive Panel markup BEFORE #skinpanel so it exists in DOM before scripts
const archivePanelHtml = `
      <!-- ============ INTERNET ARCHIVE MODAL ============ -->
      <div id="archivepanel">
        <div class="arc-header">
          <div style="font-weight:bold; font-size:12px; letter-spacing:0.08em; color:var(--title-txt); display:flex; align-items:center; gap:8px;">
            <span>🏛️</span> INTERNET ARCHIVE CINEMA &amp; BROADCAST VAULT
          </div>
          <button class="btn" id="archiveClose" style="padding:3px 10px; font-weight:bold; font-size:11px;">✕ CLOSE</button>
        </div>
        <div class="body" style="flex:1; display:flex; flex-direction:column; padding:12px; gap:10px; overflow:hidden; background:var(--app-bg);">
          <div style="display:flex; gap:8px; align-items:center;">
            <input type="text" id="archiveSearchInput" placeholder="Search Internet Archive (e.g. Sci-Fi, Night of the Living Dead, Twilight Zone, Orson Welles)..." style="flex:1; font:inherit; font-size:12px; background:var(--lcd-well); color:var(--lcd); border:1px solid var(--lcd-dim); padding:8px 12px; border-radius:4px; outline:none;">
            <button class="btn" id="btnArchiveSearch" style="padding:8px 16px; font-weight:bold; color:var(--acc); font-size:12px;">&#128269; SEARCH</button>
          </div>
          <div style="display:flex; gap:6px; flex-wrap:wrap; font-size:10.5px;">
            <span style="color:var(--txt-dim); align-self:center; font-weight:bold;">PRESET VAULTS:</span>
            <button class="btn btn-arc-pill" data-q="sci-fi classic movies">🚀 CULT SCI-FI</button>
            <button class="btn btn-arc-pill" data-q="film noir classic movies">🕵️ FILM NOIR</button>
            <button class="btn btn-arc-pill" data-q="vintage tv commercials 1950s 1960s">📺 VINTAGE TV</button>
            <button class="btn btn-arc-pill" data-q="golden age cartoons animation fleischer">🐰 CLASSIC CARTOONS</button>
            <button class="btn btn-arc-pill" data-q="old time radio drama orson welles shadow" data-type="audio">🎙️ OLD TIME RADIO</button>
            <button class="btn btn-arc-pill" data-q="grateful dead live concert soundboard" data-type="audio">🎸 LIVE CONCERTS</button>
          </div>
          <div id="archiveResults" style="flex:1; overflow-y:auto; display:grid; grid-template-columns:repeat(auto-fill, minmax(280px, 1fr)); gap:12px; padding:8px 4px;">
          </div>
        </div>
      </div>
`;

html = html.replace('<div id="skinpanel">', archivePanelHtml + '\n      <div id="skinpanel">');

// 6. Inject window.AMP_NATIVE right before `const NATIVE = window.AMP_NATIVE || null;`
const nativeDef = `
window.AMP_NATIVE = {
  version: '3.9 NATIVE (Nexus Broadcast Deck)',
  t: 'nexus',
  proxy: '/v1/iptv/proxy?t=nexus&u=',
  engine: '/v1/iptv/engine?t=nexus&u=',
  probe: '/v1/iptv/probe?t=nexus&u=',
  info: '/v1/iptv/info?t=nexus&u=',
  xtLogin: '/v1/iptv/xtream/login?t=nexus',
  xtStatus: '/v1/iptv/xtream/status?t=nexus',
  xtRefresh: '/v1/iptv/xtream/refresh?t=nexus',
  epgIds: '/v1/iptv/epg/ids?t=nexus',
  epgStatus: '/v1/iptv/epg/status?t=nexus',
  epgLoad: '/v1/iptv/epg/load?t=nexus&u=',
  epgGet: '/v1/iptv/epg/get?t=nexus&ids=',
  pl: '/v1/iptv/playlist?path=',
  pick: '/v1/iptv/pick',
  last: '/v1/iptv/last',
  hasEngine: true
};
`;

html = html.replace('const NATIVE = window.AMP_NATIVE || null;', nativeDef + '\nconst NATIVE = window.AMP_NATIVE || null;');

// 7. Inject JS hooks for Radio Screen Visualizer, Radio Presets, and Internet Archive into player IIFE
const jsHooks = `
/* ============================================================
   Nexus Route Phosphor Radio Screen & Audio Visualizer
   ============================================================ */
const nrsScreen = el('nexusRadioScreen');
const nrsName = el('nrsStationName');
const nrsCanvas = el('nrsVisualizer');
let nrsAnimId = 0;
const nrsFreqBuf = new Uint8Array(64);

function updateNrsVisibility() {
  if (!nrsScreen) return;
  const isPlaying = !video.paused && !video.ended && video.readyState >= 1;
  const isAudioUrl = S.curCh && S.curCh.url && /\\.(mp3|aac|ogg|flac|m4a|wav)(\\?|$)/i.test(S.curCh.url);
  const isRadioGroup = S.curCh && (S.curCh.group || '').toLowerCase().includes('radio');
  const isAudioOnly = isPlaying && (video.videoWidth === 0 || isAudioUrl || isRadioGroup);

  if (isAudioOnly) {
    nrsScreen.classList.add('active');
    if (nrsName) nrsName.textContent = S.curCh ? (S.curCh.name || 'LIVE AUDIO CARRIER') : 'AUDIO CARRIER';
    startNrsVisualizer();
  } else {
    nrsScreen.classList.remove('active');
    stopNrsVisualizer();
  }

  // Notify parent Nexus Route frame
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({
        type: 'nexus_radio_state',
        playing: isPlaying,
        stationName: S.curCh ? S.curCh.name : (isPlaying ? 'IPTV Playing' : null),
        country: S.curCh ? S.curCh.group : null,
        trackText: isAudioOnly ? 'Audio Monitor Active' : 'Live Stream',
        isAudio: isAudioOnly
      }, '*');
    }
  } catch(_) {}
}

function startNrsVisualizer() {
  if (nrsAnimId) return;
  try { ensureAudio(); } catch(_) {}
  const ctx = nrsCanvas ? nrsCanvas.getContext('2d') : null;
  if (!ctx) return;

  function renderNrs() {
    nrsAnimId = requestAnimationFrame(renderNrs);
    const w = nrsCanvas.width;
    const h = nrsCanvas.height;
    ctx.clearRect(0, 0, w, h);

    let hasRealData = false;
    if (S.analyser) {
      try {
        S.analyser.getByteFrequencyData(nrsFreqBuf);
        for (let i = 0; i < 32; i++) {
          if (nrsFreqBuf[i] > 10) { hasRealData = true; break; }
        }
      } catch(_) {}
    }

    const bins = 32;
    const barW = (w / bins) - 2;
    const t = performance.now() * 0.0035;

    for (let i = 0; i < bins; i++) {
      let val = hasRealData ? (nrsFreqBuf[i * 2] || nrsFreqBuf[i]) / 255 : 0;
      if (!hasRealData) {
        val = 0.22 + 0.38 * Math.sin(t + i * 0.28) * Math.cos(t * 0.6 + i * 0.12);
        val += 0.15 * Math.sin(t * 1.5 + i * 0.45);
        val = Math.max(0.06, Math.min(0.96, val));
      }
      const barH = Math.max(3, val * (h - 6));
      const x = i * (barW + 2);
      const y = h - barH;

      ctx.fillStyle = 'rgba(var(--phos), ' + (0.45 + val * 0.55) + ')';
      ctx.fillRect(x, y, barW, barH);

      // Phosphor peak dot / cap
      ctx.fillStyle = 'var(--lcd-hi)';
      ctx.fillRect(x, Math.max(0, y - 3), barW, 2);
    }
  }
  renderNrs();
}

function stopNrsVisualizer() {
  if (nrsAnimId) {
    cancelAnimationFrame(nrsAnimId);
    nrsAnimId = 0;
  }
  if (nrsCanvas) {
    const ctx = nrsCanvas.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, nrsCanvas.width, nrsCanvas.height);
  }
}

video.addEventListener('playing', updateNrsVisibility);
video.addEventListener('pause', updateNrsVisibility);
video.addEventListener('ended', updateNrsVisibility);
video.addEventListener('loadedmetadata', updateNrsVisibility);
video.addEventListener('resize', updateNrsVisibility);
video.addEventListener('timeupdate', () => {
  if (!nrsAnimId && !video.paused && video.videoWidth === 0) updateNrsVisibility();
});

// Receive control commands from Nexus frame
window.addEventListener('message', (e) => {
  if (!e.data || typeof e.data !== 'object') return;
  if (e.data.type === 'nexus_radio_cmd') {
    if (e.data.action === 'toggle') {
      if (video.paused) video.play().catch(()=>{});
      else video.pause();
    } else if (e.data.action === 'next') {
      if (S.channels && S.channels.length > 0) {
        const curIdx = S.channels.indexOf(S.curCh);
        const nextIdx = (curIdx + 1) % S.channels.length;
        play(S.channels[nextIdx]);
      }
    } else if (e.data.action === 'tuneGenre' && e.data.genre) {
      const g = e.data.genre.toLowerCase();
      const match = S.channels.find(c => (c.name || '').toLowerCase().includes(g) || (c.group || '').toLowerCase().includes(g));
      if (match) play(match);
    }
  }
});

/* ============================================================
   Wavelength Global Radio Station Integration
   ============================================================ */
if (el('bRadio')) {
  el('bRadio').onclick = async function() {
    status('busy', 'LOADING WAVELENGTH RADIO STATIONS...');
    setMarquee('*** LOADING 3,000 GLOBAL RADIO STATIONS ***');
    try {
      const resp = await fetch('/v1/iptv/radio/stations.m3u');
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const m3uText = await resp.text();
      loadText(m3uText, 'Wavelength Global Radio (3K Stations)');
      status('ok', 'LOADED GLOBAL RADIO STATIONS');
      logLine('radio  loaded live stations — tune to any station for phosphor CRT monitor', 'ok');
    } catch(e) {
      status('err', 'RADIO LOAD FAILED — ' + e.message);
    }
  };
}

/* ============================================================
   Internet Archive Cinema & Media Vault Integration
   ============================================================ */
function getArcPanel() { return el('archivepanel'); }
function getArcResults() { return el('archiveResults'); }
function getArcSearch() { return el('archiveSearchInput'); }

function toggleArchivePanel(show) {
  const p = getArcPanel();
  if (!p) return;
  const isShow = show === undefined ? !p.classList.contains('show') : !!show;
  if (isShow) {
    ['epgpanel','privpanel','loginpanel','skinpanel'].forEach(i => el(i) && el(i).classList.remove('show'));
  }
  p.classList.toggle('show', isShow);
  const r = getArcResults();
  if (isShow && (!r.children || r.children.length === 0)) {
    loadCuratedArchiveVault();
  }
}

if (el('bArchive')) el('bArchive').onclick = () => toggleArchivePanel(true);
if (el('archiveClose')) el('archiveClose').onclick = () => toggleArchivePanel(false);

async function loadCuratedArchiveVault() {
  const r = getArcResults();
  if (!r) return;
  r.innerHTML = '<div style="color:var(--lcd);grid-column:1/-1;text-align:center;padding:30px;">Loading Curated Cinema Vaults...</div>';
  try {
    const resp = await fetch('/v1/iptv/archive/curated');
    const data = await resp.json();
    renderArchiveCards(data.channels || []);
  } catch(e) {
    r.innerHTML = '<div style="color:var(--warn);grid-column:1/-1;text-align:center;padding:30px;">Failed to load curated vault: ' + e.message + '</div>';
  }
}

async function doArchiveSearch(query, mediaType) {
  const r = getArcResults();
  if (!query || !query.trim() || !r) return;
  r.innerHTML = '<div style="color:var(--lcd);grid-column:1/-1;text-align:center;padding:30px;">Searching Internet Archive for "' + query + '"...</div>';
  try {
    const resp = await fetch('/v1/iptv/archive/search?q=' + encodeURIComponent(query) + '&type=' + (mediaType || 'movies'));
    const data = await resp.json();
    renderArchiveCards(data.items || []);
  } catch(e) {
    r.innerHTML = '<div style="color:var(--warn);grid-column:1/-1;text-align:center;padding:30px;">Search failed: ' + e.message + '</div>';
  }
}

if (el('btnArchiveSearch')) {
  el('btnArchiveSearch').onclick = () => {
    const inp = getArcSearch();
    if (inp) doArchiveSearch(inp.value);
  };
}

if (el('archiveSearchInput')) {
  el('archiveSearchInput').onkeydown = (e) => {
    if (e.key === 'Enter') doArchiveSearch(e.target.value);
  };
}

document.querySelectorAll('.btn-arc-pill').forEach(btn => {
  btn.onclick = () => {
    const q = btn.getAttribute('data-q');
    const type = btn.getAttribute('data-type') || 'movies';
    const inp = getArcSearch();
    if (inp) inp.value = q;
    doArchiveSearch(q, type);
  };
});

function renderArchiveCards(items) {
  const r = getArcResults();
  if (!r) return;
  r.innerHTML = '';
  if (!items.length) {
    r.innerHTML = '<div style="color:var(--txt-dim);grid-column:1/-1;text-align:center;padding:30px;">No Archive media items found. Try another search!</div>';
    return;
  }
  for (const item of items) {
    const card = document.createElement('div');
    card.className = 'arc-card';
    const thumbUrl = item.logo || item.thumbnail || 'https://archive.org/images/ia-logo.svg';
    card.innerHTML = \`
      <img src="\${thumbUrl}" class="arc-thumb" alt="" onerror="this.style.display='none'">
      <div class="arc-title" title="\${item.title || ''}">\${item.title || 'Untitled'}</div>
      <div class="arc-meta">
        <span>\${item.group || 'Internet Archive'}</span>
        <span>\${item.year ? '· ' + item.year : ''}</span>
      </div>
      <div class="arc-actions">
        <button class="arc-btn primary btn-play-now">▶ Play on CRT</button>
        <button class="arc-btn btn-add-pl">+ Add to List</button>
      </div>
    \`;

    const channelObj = {
      name: item.title,
      url: item.url || item.streamUrl,
      group: item.group || 'Internet Archive Cinema',
      logo: thumbUrl,
      opts: []
    };

    card.querySelector('.btn-play-now').onclick = (e) => {
      e.stopPropagation();
      toggleArchivePanel(false);
      // Append channel to playlist if not already present
      if (!S.channels.some(c => c.url === channelObj.url)) {
        S.channels.unshift(channelObj);
        refresh();
      }
      play(channelObj);
      status('ok', 'PLAYING FROM INTERNET ARCHIVE — ' + channelObj.name);
    };

    card.querySelector('.btn-add-pl').onclick = (e) => {
      e.stopPropagation();
      if (!S.channels.some(c => c.url === channelObj.url)) {
        S.channels.push(channelObj);
        refresh();
        status('ok', 'ADDED TO PLAYLIST — ' + channelObj.name);
      } else {
        status('idle', 'Already in playlist');
      }
    };

    r.appendChild(card);
  }
}
`;

html = html.replace('window.__ampGpu = function(){', jsHooks + '\nwindow.__ampGpu = function(){');

fs.writeFileSync(destPath, html, 'utf8');
console.log('Successfully generated iptv.html at:', destPath);
console.log('File size:', html.length, 'bytes');

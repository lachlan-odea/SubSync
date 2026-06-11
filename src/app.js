/* SubSync — renderer process */
'use strict';

// ── State ──────────────────────────────────────────────────────────────────
let cues        = [];
let selectedIdx = null;
let videoPath   = null;
let srtPath     = null;
let docxPath    = null;
let inputMode   = 'docx';
let fmt         = 'srt';
let selectedModel = 'small';
let totalOffset = 0;
let suppressAutoFollowUntil = 0;   // ignore timeupdate auto-follow right after an explicit selection
let backendPort = 57832;
let activeJobId = null;
let pollTimer   = null;
let searchQuery = '';
let isDirty     = false;

// ── Update check (GitHub Releases) ───────────────────────────────────────────
// Set to 'owner/repo' of the public GitHub repo whose Releases hold the latest
// installer. Leave empty to disable the check entirely.
const UPDATE_REPO = 'lachlan-odea/SubSync';
let updateInfo = null;   // { version, url, notes } when a newer release exists

// ── Boot ───────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  backendPort = await window.electronAPI.getBackendPort();
  bindEvents();
  bindEditPanelEvents();
  bindVideoControls();
  bindVideoResize();
  updateStats();
  checkForUpdate();   // non-blocking; failures are silent
});

// ── Video panel resize ─────────────────────────────────────────────────────
function bindVideoResize() {
  const handle = document.getElementById('videoResizeHandle');
  const panel  = document.getElementById('videoPanel');
  if (!handle || !panel) return;
  let dragging = false, startY = 0, startH = 0;

  handle.addEventListener('mousedown', e => {
    dragging = true;
    startY = e.clientY;
    startH = panel.getBoundingClientRect().height;
    handle.classList.add('dragging');
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    // Clamp between a sensible minimum and "leave at least 200px for the timeline area"
    const maxH = Math.max(140, window.innerHeight - 260);
    const newH = Math.max(120, Math.min(maxH, startH + (e.clientY - startY)));
    panel.style.height = newH + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
}

// ── Main event bindings ────────────────────────────────────────────────────
function bindEvents() {
  setupDropZone('videoDropZone', ['mp4','mov','mkv','avi','webm','m4v'], loadVideo);
  setupDropZone('srtDropZone',   ['srt','vtt'], loadSRT);
  setupDropZone('docxDropZone',  ['docx'], loadDocx);

  document.querySelectorAll('.model-card').forEach(card => {
    card.addEventListener('click', () => {
      document.querySelectorAll('.model-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      selectedModel = card.dataset.model;
    });
  });

  document.getElementById('runBtn').addEventListener('click', runAutoSync);
  document.getElementById('aboutBtn').addEventListener('click', showAboutModal);
  document.getElementById('nudge-5').addEventListener('click', () => adjustOffset(-5));
  document.getElementById('nudge-1').addEventListener('click', () => adjustOffset(-1));
  document.getElementById('nudge+1').addEventListener('click', () => adjustOffset(1));
  document.getElementById('nudge+5').addEventListener('click', () => adjustOffset(5));
  document.getElementById('applyOffsetBtn').addEventListener('click', applyManualOffset);
  document.getElementById('addCueBtn').addEventListener('click', addCue);
  document.getElementById('sortBtn').addEventListener('click', () => {
    cues.sort((a, b) => a.start - b.start);
    renderTimeline();
    showToast('Sorted by timecode');
  });
  document.getElementById('searchInput').addEventListener('input', e => {
    searchQuery = e.target.value.toLowerCase();
    renderTimeline();
  });
  document.getElementById('exportBtn').addEventListener('click', exportSRT);
  document.getElementById('manageModelsBtn').addEventListener('click', showModelManager);

  document.addEventListener('keydown', onKeyDown);
}

// ── Edit panel events (bound once to static HTML elements) ─────────────────
function bindEditPanelEvents() {
  // Mark dirty on any field change
  ['editText','editStart','editEnd'].forEach(id => {
    document.getElementById(id).addEventListener('input', () => { isDirty = true; });
  });

  // Ctrl+Enter in textarea saves
  document.getElementById('editText').addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveCue(true); }
  });
  // Enter in time fields saves
  ['editStart','editEnd'].forEach(id => {
    document.getElementById(id).addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); saveCue(true); }
    });
  });

  document.getElementById('saveCueBtn').addEventListener('click', () => saveCue(true));
  document.getElementById('prevCueBtn').addEventListener('click', () => {
    if (selectedIdx !== null && selectedIdx > 0) selectCue(selectedIdx - 1);
  });
  document.getElementById('nextCueBtn').addEventListener('click', () => {
    if (selectedIdx !== null && selectedIdx < cues.length - 1) selectCue(selectedIdx + 1);
  });

  // Nudge buttons
  document.getElementById('cn-1s').addEventListener('click',  () => nudgeCue(-1));
  document.getElementById('cn+1s').addEventListener('click',  () => nudgeCue(1));
  document.getElementById('cn-.1').addEventListener('click',  () => nudgeCue(-0.1));
  document.getElementById('cn+.1').addEventListener('click',  () => nudgeCue(0.1));
  document.getElementById('cn-ext').addEventListener('click', () => {
    if (selectedIdx === null) return;
    cues[selectedIdx].end += 0.5;
    refreshEditFields(); updateTimelineRow(selectedIdx);
  });
  document.getElementById('cn-shr').addEventListener('click', () => {
    if (selectedIdx === null) return;
    cues[selectedIdx].end = Math.max(cues[selectedIdx].start + 0.1, cues[selectedIdx].end - 0.2);
    refreshEditFields(); updateTimelineRow(selectedIdx);
  });
  document.getElementById('splitCueBtn').addEventListener('click', splitCue);
  document.getElementById('mergeNextBtn').addEventListener('click', mergeWithNext);

  // Delete button in edit panel
  document.getElementById('deleteCueBtn').addEventListener('click', () => {
    if (selectedIdx !== null) deleteCue(selectedIdx);
  });
}

// ── Video controls ─────────────────────────────────────────────────────────
function bindVideoControls() {
  const vid         = document.getElementById('videoEl');
  const playBtn     = document.getElementById('playBtn');
  const playIcon    = document.getElementById('playIcon');
  const pauseIcon   = document.getElementById('pauseIcon');
  const skipBackBtn = document.getElementById('skipBackBtn');
  const skipFwdBtn  = document.getElementById('skipFwdBtn');
  const muteBtn     = document.getElementById('muteBtn');
  const volIcon     = document.getElementById('volIcon');
  const muteIcon    = document.getElementById('muteIcon');
  const volSlider   = document.getElementById('volSlider');
  const scrubWrap   = document.getElementById('scrubberWrap');
  const scrubFill   = document.getElementById('scrubberFill');
  const scrubBuf    = document.getElementById('scrubberBuf');
  const scrubThumb  = document.getElementById('scrubberThumb');
  const timeDisplay = document.getElementById('timeDisplay');
  const fullscBtn   = document.getElementById('fullscreenBtn');

  // Play / pause
  function togglePlay() {
    if (!vid.src) return;
    if (vid.paused) vid.play(); else vid.pause();
  }
  playBtn.addEventListener('click', togglePlay);

  vid.addEventListener('play',  () => { playIcon.style.display='none'; pauseIcon.style.display=''; });
  vid.addEventListener('pause', () => { playIcon.style.display=''; pauseIcon.style.display='none'; });
  vid.addEventListener('ended', () => { playIcon.style.display=''; pauseIcon.style.display='none'; });

  // Skip
  skipBackBtn.addEventListener('click', () => { if (vid.src) vid.currentTime = Math.max(0, vid.currentTime - 5); });
  skipFwdBtn.addEventListener('click',  () => { if (vid.src) vid.currentTime = Math.min(vid.duration || 0, vid.currentTime + 5); });

  // Volume
  volSlider.addEventListener('input', () => { vid.volume = parseFloat(volSlider.value); updateVolIcon(); });
  muteBtn.addEventListener('click', () => {
    vid.muted = !vid.muted;
    updateVolIcon();
  });
  function updateVolIcon() {
    const muted = vid.muted || vid.volume === 0;
    volIcon.style.display  = muted ? 'none' : '';
    muteIcon.style.display = muted ? '' : 'none';
  }

  // Speed
  document.querySelectorAll('.speed-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      vid.playbackRate = parseFloat(btn.dataset.speed);
    });
  });

  // Scrubber
  let scrubbing = false;

  function getScrubPos(e) {
    const rect = scrubWrap.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  }
  scrubWrap.addEventListener('mousedown', e => {
    if (!vid.src || !vid.duration) return;
    scrubbing = true;
    vid.currentTime = getScrubPos(e) * vid.duration;
  });
  document.addEventListener('mousemove', e => {
    if (!scrubbing) return;
    vid.currentTime = getScrubPos(e) * vid.duration;
  });
  document.addEventListener('mouseup', () => { scrubbing = false; });

  vid.addEventListener('timeupdate', () => {
    if (!vid.duration) return;
    const pct = (vid.currentTime / vid.duration) * 100;
    scrubFill.style.width  = pct + '%';
    scrubThumb.style.left  = pct + '%';
    timeDisplay.textContent = `${fmtDur(vid.currentTime)} / ${fmtDur(vid.duration)}`;

    // Also update the info bar
    document.getElementById('timeCode').textContent = formatTime(vid.currentTime, false);

    // Update sub overlay and active cue
    onVideoTimeUpdate(vid.currentTime);
  });

  vid.addEventListener('progress', () => {
    if (!vid.duration || !vid.buffered.length) return;
    const end = vid.buffered.end(vid.buffered.length - 1);
    scrubBuf.style.width = (end / vid.duration * 100) + '%';
  });

  // Fullscreen
  fullscBtn.addEventListener('click', () => {
    const panel = document.getElementById('videoPanel');
    if (document.fullscreenElement) document.exitFullscreen();
    else panel.requestFullscreen();
  });

  // Space bar = play/pause (when not in input)
  document.addEventListener('keydown', e => {
    if (e.code === 'Space' && !['INPUT','TEXTAREA'].includes(document.activeElement.tagName)) {
      e.preventDefault();
      togglePlay();
    }
    if (e.code === 'ArrowLeft'  && !['INPUT','TEXTAREA'].includes(document.activeElement.tagName)) {
      e.preventDefault();
      if (vid.src) vid.currentTime = Math.max(0, vid.currentTime - 2);
    }
    if (e.code === 'ArrowRight' && !['INPUT','TEXTAREA'].includes(document.activeElement.tagName)) {
      e.preventDefault();
      if (vid.src) vid.currentTime = Math.min(vid.duration || 0, vid.currentTime + 2);
    }
  });
}

function fmtDur(sec) {
  if (!sec || isNaN(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2,'0')}`;
}

function onVideoTimeUpdate(ct) {
  const active  = cues.find(c => ct >= c.start && ct <= c.end);
  const overlay = document.getElementById('subOverlay');
  const badge   = document.getElementById('activeCueBadge');

  if (active) {
    overlay.textContent   = active.text;
    overlay.style.display = 'block';
    const ai = cues.indexOf(active);
    badge.textContent   = `cue #${ai + 1}`;
    badge.style.display = 'inline-block';

    // Auto-follow in timeline (only when not actively editing, and not right
    // after an explicit selection whose pre-roll seek may land in an earlier cue)
    if (selectedIdx !== ai && !isDirty && Date.now() >= suppressAutoFollowUntil
        && document.activeElement.tagName !== 'TEXTAREA') {
      selectedIdx = ai;
      document.querySelectorAll('.cue-row').forEach(r =>
        r.classList.toggle('active', parseInt(r.dataset.idx) === ai));
      document.querySelector(`.cue-row[data-idx="${ai}"]`)?.scrollIntoView({ block: 'nearest' });
      refreshEditFields();
      updateEditPanelVisibility();
    }
  } else {
    overlay.style.display = 'none';
    badge.style.display   = 'none';
  }
}

// ── Keyboard shortcuts (cue navigation) ───────────────────────────────────
function onKeyDown(e) {
  if (['INPUT','TEXTAREA'].includes(document.activeElement.tagName)) return;
  if (!cues.length || selectedIdx === null) return;
  if (e.key === 'j' || (e.key === 'ArrowDown' && e.shiftKey)) {
    e.preventDefault(); selectCue(Math.min(selectedIdx + 1, cues.length - 1));
  } else if (e.key === 'k' || (e.key === 'ArrowUp' && e.shiftKey)) {
    e.preventDefault(); selectCue(Math.max(selectedIdx - 1, 0));
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    deleteCue(selectedIdx);
  }
}

// ── Drop zones ─────────────────────────────────────────────────────────────
function setupDropZone(zoneId, exts, callback) {
  const zone = document.getElementById(zoneId);
  if (!zone) return;
  zone.addEventListener('click', async () => {
    const fp = await window.electronAPI.openFileDialog({ filters: [{ name: 'Files', extensions: exts }] });
    if (fp) callback(fp);
  });
  zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault(); zone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const ext = file.name.split('.').pop().toLowerCase();
    if (exts.includes(ext)) callback(file.path);
    else showToast(`Unsupported: .${ext}`, 'error');
  });
}

// ── File loading ───────────────────────────────────────────────────────────
function loadVideo(fp) {
  videoPath = fp;
  const vid  = document.getElementById('videoEl');
  const panel = document.getElementById('videoPanel');
  vid.src = `file://${fp}`;
  vid.style.display = 'block';
  panel.classList.remove('no-video');
  document.getElementById('noVideoMsg').style.display = 'none';
  const name = fp.split(/[\\/]/).pop();
  document.getElementById('videoFileName').textContent = name;
  const zone = document.getElementById('videoDropZone');
  zone.classList.add('has-file');
  zone.querySelector('.dz-title').textContent = name;
  updateRunBtn();
}

async function loadSRT(fp) {
  srtPath = fp;
  fmt = fp.endsWith('.vtt') ? 'vtt' : 'srt';
  const content = await window.electronAPI.readFile(fp);
  cues = fmt === 'vtt' ? parseVTT(content) : parseSRT(content);
  selectedIdx = null;
  renderTimeline();
  updateEditPanelVisibility();
  updateStats();
  const name = fp.split(/[\\/]/).pop();
  document.getElementById('srtFileName').textContent = name;
  const zone = document.getElementById('srtDropZone');
  zone.classList.add('has-file');
  zone.querySelector('.dz-title').textContent = name;
  document.getElementById('exportBtn').disabled = false;
  updateRunBtn();
  showToast(`Loaded ${cues.length} cues`);
}

function loadDocx(fp) {
  docxPath = fp;
  const name = fp.split(/[\\/]/).pop();
  document.getElementById('docxFileName').textContent = name;
  const zone = document.getElementById('docxDropZone');
  zone.classList.add('has-file');
  zone.querySelector('.dz-title').textContent = name;
  document.getElementById('exportBtn').disabled = false;
  updateRunBtn();
  showToast('Word document: ' + name);
}

function setInputMode(mode) {
  inputMode = mode;
  document.getElementById('tabSrt').classList.toggle('active',  mode === 'srt');
  document.getElementById('tabDocx').classList.toggle('active', mode === 'docx');
  document.getElementById('srtZoneWrap').style.display  = mode === 'srt'  ? 'block' : 'none';
  document.getElementById('docxZoneWrap').style.display = mode === 'docx' ? 'block' : 'none';
  const btn = document.getElementById('runBtn');
  btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><path d="M3 2l9 5-9 5V2z"/></svg> AI Auto-Sync';
  updateRunBtn();
}

function updateRunBtn() {
  document.getElementById('runBtn').disabled = !(videoPath && (inputMode === 'srt' ? srtPath : docxPath));
}

// ── Subtitle parsing ───────────────────────────────────────────────────────
function parseTime(s) {
  s = s.trim().replace(',', '.');
  const p = s.split(':');
  if (p.length === 3) return parseFloat(p[0]) * 3600 + parseFloat(p[1]) * 60 + parseFloat(p[2]);
  if (p.length === 2) return parseFloat(p[0]) * 60 + parseFloat(p[1]);
  return 0;
}

function formatTime(sec, srt = false) {
  if (isNaN(sec) || sec < 0) sec = 0;
  const h  = Math.floor(sec / 3600);
  const m  = Math.floor((sec % 3600) / 60);
  const s  = Math.floor(sec % 60);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  return `${pad(h,2)}:${pad(m,2)}:${pad(s,2)}${srt?',':'.'}${pad(ms,3)}`;
}

function pad(n, len) { return String(n).padStart(len, '0'); }

function parseSRT(text) {
  const result = [];
  for (const b of text.trim().split(/\n\s*\n/)) {
    const lines = b.trim().split('\n');
    let i = /^\d+$/.test(lines[0]?.trim()) ? 1 : 0;
    if (i >= lines.length) continue;
    const m = lines[i].match(/(\d{2}:\d{2}:\d{2}[,\.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,\.]\d{3})/);
    if (!m) continue;
    result.push({ start: parseTime(m[1]), end: parseTime(m[2]), text: lines.slice(i+1).join('\n').trim() });
  }
  return result;
}

function parseVTT(text) {
  const result = [];
  for (const b of text.trim().split(/\n\s*\n/)) {
    const lines = b.trim().split('\n').filter(l => l && !l.startsWith('NOTE') && l !== 'WEBVTT');
    const tl = lines.find(l => l.includes('-->'));
    if (!tl) continue;
    const m  = tl.match(/([\d:\.]+)\s*-->\s*([\d:\.]+)/);
    if (!m) continue;
    result.push({ start: parseTime(m[1]), end: parseTime(m[2]), text: lines.slice(lines.indexOf(tl)+1).join('\n').trim() });
  }
  return result;
}

function toSRT() {
  return [...cues].sort((a,b) => a.start - b.start)
    .map((c,i) => `${i+1}\n${formatTime(c.start,true)} --> ${formatTime(c.end,true)}\n${c.text}`)
    .join('\n\n');
}

function toVTT() {
  const body = [...cues].sort((a,b) => a.start - b.start)
    .map((c,i) => `${i+1}\n${formatTime(c.start,false)} --> ${formatTime(c.end,false)}\n${c.text}`)
    .join('\n\n');
  return `WEBVTT\n\n${body}`;
}

// ── Timeline ───────────────────────────────────────────────────────────────
function renderTimeline() {
  const tl    = document.getElementById('timeline');
  const empty = document.getElementById('tlEmpty');

  if (cues.length === 0) {
    tl.innerHTML = '';
    if (empty) tl.appendChild(empty);
    else tl.innerHTML = `<div class="timeline-empty" id="tlEmpty">
      <svg width="32" height="32" viewBox="0 0 32 32" fill="none" opacity="0.3">
        <rect x="4" y="8"  width="24" height="4" rx="2" fill="white"/>
        <rect x="4" y="16" width="18" height="4" rx="2" fill="white"/>
        <rect x="4" y="24" width="21" height="4" rx="2" fill="white"/>
      </svg>
      Load an SRT, VTT, or Word file to begin
    </div>`;
    document.getElementById('cueCountLabel').textContent = '0 cues';
    updateStats();
    return;
  }
  if (empty) empty.remove();
  tl.innerHTML = '';

  const filtered = cues.filter(c => !searchQuery || c.text.toLowerCase().includes(searchQuery));
  filtered.forEach(c => {
    const realIdx = cues.indexOf(c);
    const row     = document.createElement('div');
    row.className   = 'cue-row' + (realIdx === selectedIdx ? ' active' : '');
    row.dataset.idx = realIdx;

    const textHtml = searchQuery
      ? c.text.replace(/</g,'&lt;').replace(new RegExp(`(${searchQuery})`, 'gi'), '<mark style="background:rgba(234,252,136,0.25);color:var(--accent)">$1</mark>')
      : c.text.replace(/</g,'&lt;').replace(/\n/g,'<br>');

    row.innerHTML = `
      <div class="cue-num">${realIdx+1}</div>
      <div class="cue-time">
        <div class="start">${formatTime(c.start,true)}</div>
        <div>${formatTime(c.end,true)}</div>
      </div>
      <div class="cue-text">${textHtml}</div>
      <div class="cue-del"><button class="del-btn" title="Delete">✕</button></div>`;

    row.addEventListener('click', e => {
      if (e.target.classList.contains('del-btn')) return;
      selectCue(realIdx);
    });

    // Delete button — use realIdx captured in closure, not data attribute
    row.querySelector('.del-btn').addEventListener('click', e => {
      e.stopPropagation();
      deleteCue(realIdx);
    });

    tl.appendChild(row);
  });

  document.getElementById('cueCountLabel').textContent = `${cues.length} cue${cues.length !== 1 ? 's' : ''}`;
  updateStats();
}

function selectCue(i) {
  flushEditPanel();          // auto-save pending edits
  selectedIdx = i;
  isDirty     = false;

  document.querySelectorAll('.cue-row').forEach(r =>
    r.classList.toggle('active', parseInt(r.dataset.idx) === i));
  document.querySelector(`.cue-row[data-idx="${i}"]`)?.scrollIntoView({ block: 'nearest' });

  // Seek video to just before the cue — but never far enough to land inside
  // the previous cue (otherwise timeupdate auto-follow snaps the selection back).
  const vid = document.getElementById('videoEl');
  if (vid.src && cues[i]) {
    let seekTo = Math.max(0, cues[i].start - 0.2);
    const prev = cues[i - 1];
    if (prev && seekTo <= prev.end) seekTo = cues[i].start;
    suppressAutoFollowUntil = Date.now() + 400;
    vid.currentTime = seekTo;
  }

  updateEditPanelVisibility();
}

function deleteCue(idx) {
  if (idx < 0 || idx >= cues.length) return;
  cues.splice(idx, 1);

  if (selectedIdx !== null) {
    if (cues.length === 0)        selectedIdx = null;
    else if (selectedIdx >= idx)  selectedIdx = Math.max(0, selectedIdx - 1);
  }

  isDirty = false;
  renderTimeline();
  updateEditPanelVisibility();
  showToast('Cue deleted');
}

// ── Edit panel (static HTML, values-only updates) ─────────────────────────
function updateEditPanelVisibility() {
  const c = selectedIdx !== null ? cues[selectedIdx] : null;
  document.getElementById('epEmpty').style.display       = c ? 'none'  : 'block';
  document.getElementById('epFields').style.display      = c ? 'block' : 'none';
  document.getElementById('epNudgeSection').style.display = c ? 'block' : 'none';

  if (c) {
    document.getElementById('epCueLabel').textContent = `Cue #${selectedIdx+1} of ${cues.length}`;
    document.getElementById('prevCueBtn').disabled = selectedIdx <= 0;
    document.getElementById('nextCueBtn').disabled = selectedIdx >= cues.length - 1;
    refreshEditFields();
  } else {
    document.getElementById('epCueLabel').textContent = 'Cue editor';
  }
  updateStats();
}

function refreshEditFields() {
  const c = selectedIdx !== null ? cues[selectedIdx] : null;
  if (!c) return;
  document.getElementById('editStart').value = formatTime(c.start, true);
  document.getElementById('editEnd').value   = formatTime(c.end,   true);
  document.getElementById('editText').value  = c.text;
  isDirty = false;
}

function flushEditPanel() {
  if (selectedIdx === null || !isDirty) return;
  const newStart = parseTime(document.getElementById('editStart').value);
  const newEnd   = parseTime(document.getElementById('editEnd').value);
  const newText  = document.getElementById('editText').value;
  if (!isNaN(newStart) && !isNaN(newEnd) && newEnd > newStart) {
    cues[selectedIdx].start = newStart;
    cues[selectedIdx].end   = newEnd;
  }
  cues[selectedIdx].text = newText;
  isDirty = false;
}

function saveCue(showMsg = false) {
  if (selectedIdx === null) return;
  const newStart = parseTime(document.getElementById('editStart').value);
  const newEnd   = parseTime(document.getElementById('editEnd').value);
  const newText  = document.getElementById('editText').value;
  if (isNaN(newStart) || isNaN(newEnd)) { showToast('Invalid time format', 'error'); return; }
  if (newEnd <= newStart) { showToast('End must be after start', 'error'); return; }
  cues[selectedIdx].start = newStart;
  cues[selectedIdx].end   = newEnd;
  cues[selectedIdx].text  = newText;
  isDirty = false;
  updateTimelineRow(selectedIdx);
  if (showMsg) showToast('Saved');
}

function nudgeCue(delta) {
  if (selectedIdx === null) return;
  flushEditPanel();
  cues[selectedIdx].start = Math.max(0, cues[selectedIdx].start + delta);
  cues[selectedIdx].end   = Math.max(0, cues[selectedIdx].end   + delta);
  refreshEditFields();
  updateTimelineRow(selectedIdx);
}

function splitCue() {
  if (selectedIdx === null) return;
  flushEditPanel();
  const c = cues[selectedIdx];
  const mid = (c.start + c.end) / 2;
  const second = { start: mid, end: c.end, text: '' };
  c.end = mid;
  cues.splice(selectedIdx + 1, 0, second);
  renderTimeline();
  selectCue(selectedIdx + 1);
  showToast('Split — add text to new cue');
  setTimeout(() => document.getElementById('editText')?.focus(), 60);
}

function mergeWithNext() {
  if (selectedIdx === null || selectedIdx >= cues.length - 1) return;
  flushEditPanel();
  const a = cues[selectedIdx], b = cues[selectedIdx + 1];
  a.end  = b.end;
  a.text = (a.text + ' ' + b.text).trim();
  cues.splice(selectedIdx + 1, 1);
  renderTimeline();
  updateEditPanelVisibility();
  showToast('Cues merged');
}

function updateTimelineRow(idx) {
  const row = document.querySelector(`.cue-row[data-idx="${idx}"]`);
  if (!row) { renderTimeline(); return; }
  const c = cues[idx];
  row.querySelector('.cue-time .start').textContent = formatTime(c.start, true);
  row.querySelector('.cue-time div:last-child').textContent = formatTime(c.end, true);
  row.querySelector('.cue-text').innerHTML = c.text.replace(/</g,'&lt;').replace(/\n/g,'<br>');
  updateStats();
}

function addCue() {
  const vid = document.getElementById('videoEl');
  const insertAt = (vid.src && vid.currentTime) ? vid.currentTime
    : (cues.length ? cues[cues.length-1].end + 0.5 : 0);
  const newCue = { start: insertAt, end: insertAt + 2, text: 'New subtitle' };
  cues.push(newCue);
  cues.sort((a,b) => a.start - b.start);
  const ni = cues.indexOf(newCue);
  renderTimeline();
  selectCue(ni);
  setTimeout(() => document.getElementById('editText')?.select(), 60);
}

// ── Offset tools ───────────────────────────────────────────────────────────
function adjustOffset(delta) {
  const inp = document.getElementById('offsetInput');
  inp.value = (parseFloat(inp.value) + delta).toFixed(1);
}

function applyManualOffset() {
  const offset = parseFloat(document.getElementById('offsetInput').value) || 0;
  if (offset === 0) return;
  cues = cues.map(c => ({ ...c, start: Math.max(0, c.start+offset), end: Math.max(0, c.end+offset) }));
  totalOffset += offset;
  document.getElementById('offsetInput').value = 0;
  renderTimeline();
  updateEditPanelVisibility();
  updateStats();
  showToast(`Offset ${offset>0?'+':''}${offset}s applied to all cues`);
}

// ── Stats (IDs always in DOM in static HTML) ───────────────────────────────
function updateStats() {
  document.getElementById('statCues').textContent   = cues.length || '—';
  const last = cues[cues.length - 1];
  document.getElementById('statDur').textContent    = last ? formatTime(last.end, false) : '—';
  document.getElementById('statFmt').textContent    = fmt.toUpperCase();
  document.getElementById('statOffset').textContent = totalOffset.toFixed(3) + 's';
}

// ── Export ─────────────────────────────────────────────────────────────────
async function exportSRT() {
  flushEditPanel();
  // Default to the loaded subtitle format, falling back to SRT.
  const defaultExt  = fmt === 'vtt' ? 'vtt' : 'srt';
  const baseName    = videoPath
    ? videoPath.split(/[\\/]/).pop().replace(/\.[^.]+$/, '')
    : 'synced_subtitles';
  // Order the "Save as type" filters so the default format appears first.
  const srtFilter = { name: 'SubRip Subtitle', extensions: ['srt'] };
  const vttFilter = { name: 'WebVTT Subtitle', extensions: ['vtt'] };
  const fp = await window.electronAPI.saveFileDialog({
    defaultName: `${baseName}.${defaultExt}`,
    filters: defaultExt === 'vtt' ? [vttFilter, srtFilter] : [srtFilter, vttFilter],
  });
  if (!fp) return;
  // Choose the serializer from the extension the user actually picked/typed.
  const isVtt   = /\.vtt$/i.test(fp);
  const content = isVtt ? toVTT() : toSRT();
  await window.electronAPI.writeFile(fp, content);
  showToast('Exported: ' + fp.split(/[\\/]/).pop(), 'success');
}

// ── AI Auto-Sync ───────────────────────────────────────────────────────────
async function runAutoSync() {
  if (inputMode === 'docx') return runDocxSync();
  if (!videoPath || !srtPath) return;

  let modelsData;
  try { modelsData = await fetch(`http://localhost:${backendPort}/models`).then(r=>r.json()); }
  catch(e) { showToast('Cannot reach backend', 'error'); return; }

  const modelInfo = modelsData[selectedModel];
  if (!modelInfo.cached) {
    if (!await showModelDownloadModal(selectedModel, modelInfo)) return;
  }

  const tempOutput = await window.electronAPI.getTempPath('srt');

  setProgress(0, 'Starting Whisper sync...');
  document.getElementById('runBtn').disabled = true;
  try {
    const res = await fetch(`http://localhost:${backendPort}/sync/auto`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ video_path:videoPath, subtitle_path:srtPath, output_path:tempOutput, model:selectedModel }),
    });
    if (res.status === 428) { showToast('Model not ready', 'error'); document.getElementById('runBtn').disabled=false; return; }
    const { job_id } = await res.json();
    pollTimer = setInterval(() => pollSyncJob(job_id, tempOutput), 800);
  } catch(e) { showToast('Failed: '+e.message,'error'); document.getElementById('runBtn').disabled=false; }
}

async function runDocxSync() {
  if (!videoPath || !docxPath) return;
  let modelsData;
  try { modelsData = await fetch(`http://localhost:${backendPort}/models`).then(r=>r.json()); }
  catch(e) { showToast('Cannot reach backend','error'); return; }

  const modelInfo = modelsData[selectedModel];
  if (!modelInfo.cached) {
    if (!await showModelDownloadModal(selectedModel, modelInfo)) return;
  }

  const tempOutput = await window.electronAPI.getTempPath('srt');

  setProgress(0, 'Reading Word document...');
  document.getElementById('runBtn').disabled = true;
  try {
    const maxWords = parseInt(document.getElementById('maxWordsInput')?.value) || 8;
    const res = await fetch(`http://localhost:${backendPort}/sync/from-docx`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ video_path:videoPath, docx_path:docxPath, output_path:tempOutput, model:selectedModel, max_words:maxWords, min_words:3 }),
    });
    if (res.status === 428) { showToast('Model not ready','error'); document.getElementById('runBtn').disabled=false; return; }
    const { job_id } = await res.json();
    pollTimer = setInterval(() => pollSyncJob(job_id, tempOutput), 800);
  } catch(e) { showToast('Failed: '+e.message,'error'); document.getElementById('runBtn').disabled=false; }
}

async function pollSyncJob(jobId, outputPath) {
  try {
    const job = await fetch(`http://localhost:${backendPort}/job/${jobId}`).then(r=>r.json());
    setProgress(job.progress||0, job.message||'...');
    if (job.status === 'done') {
      clearInterval(pollTimer);
      document.getElementById('runBtn').disabled = false;
      setProgress(100, 'Complete!');
      const content = await window.electronAPI.readFile(outputPath);
      window.electronAPI.deleteFile(outputPath);
      cues = parseSRT(content);
      selectedIdx = null;
      fmt = 'srt';
      renderTimeline(); updateEditPanelVisibility();
      document.getElementById('exportBtn').disabled = false;
      showToast(`Done — ${cues.length} cues ready · click Export to save`, 'success');
      setTimeout(() => setProgress(0,'Ready'), 3000);
    } else if (job.status === 'error') {
      clearInterval(pollTimer);
      document.getElementById('runBtn').disabled = false;
      setProgress(0,'Error'); showToast('Failed: '+(job.message||'unknown'), 'error');
    }
  } catch(e) { clearInterval(pollTimer); document.getElementById('runBtn').disabled=false; }
}

function setProgress(pct, label) {
  document.getElementById('progFill').style.width = pct + '%';
  document.getElementById('progLabel').textContent = label;
}

// ── Update check (GitHub Releases) ───────────────────────────────────────────
// Returns true if `remote` is a strictly higher version than `local`.
function isNewerVersion(remote, local) {
  const parse = v => String(v).trim().replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  const a = parse(remote), b = parse(local);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return false;
}

// Checks GitHub Releases for a newer version. Returns one of:
//   'disabled' | 'update' | 'current' | 'error'
// `notify` shows a toast when an update is found (used by the silent startup check;
// the manual check in the About dialog passes notify:false and shows inline feedback).
async function checkForUpdate({ notify = true } = {}) {
  if (!UPDATE_REPO) return 'disabled';
  try {
    const res = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
      headers: { 'Accept': 'application/vnd.github+json' },
    });
    if (!res.ok) return 'error';
    const rel = await res.json();
    const latest = rel.tag_name || rel.name;
    if (!latest) return 'error';

    const current = await window.electronAPI.getAppVersion();
    if (!isNewerVersion(latest, current)) return 'current';

    // Prefer a Windows installer asset; fall back to the release page.
    const asset = (rel.assets || []).find(a => /\.exe$/i.test(a.name || ''));
    updateInfo = {
      version: String(latest).replace(/^v/i, ''),
      url: asset ? asset.browser_download_url : rel.html_url,
      notes: rel.body || '',
    };

    document.getElementById('aboutBtn')?.classList.add('has-update');
    if (notify) showToast(`Update available: v${updateInfo.version} — see About (ⓘ)`, 'success');
    return 'update';
  } catch (e) {
    // Network/parse failure — never disrupt the app.
    return 'error';
  }
}

// ── About modal ─────────────────────────────────────────────────────────────
async function showAboutModal() {
  let version = '';
  try { version = await window.electronAPI.getAppVersion(); } catch (e) { version = 'unknown'; }

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);display:flex;align-items:center;justify-content:center;z-index:9999;';
  overlay.innerHTML = `
    <div style="background:#16161d;border:1px solid rgba(255,255,255,0.1);border-radius:12px;padding:28px 32px;width:360px;font-family:'Sora',sans-serif;color:#e8e8f0;text-align:center;">
      <div style="font-size:22px;font-weight:700;letter-spacing:-0.02em;margin-bottom:4px">Sub<span style="color:#EAFC88">Sync</span></div>
      <div style="font-size:13px;font-family:'DM Mono',monospace;color:rgba(232,232,240,0.6);margin-bottom:18px">Version ${version}</div>
      <div style="font-size:12px;color:rgba(232,232,240,0.45);line-height:1.6;margin-bottom:22px">
        A Subtitle sync tool powered by anchor-sub-sync and Whisper.<br><br>WiseTech Global<br>© 2026. All rights reserved.
      </div>
      <div id="aboutUpdate" style="margin-bottom:18px"></div>
      <button id="aboutClose" style="padding:9px 24px;background:transparent;border:1px solid rgba(255,255,255,0.15);border-radius:8px;color:rgba(232,232,240,0.7);font-family:'Sora',sans-serif;font-size:13px;font-weight:600;cursor:pointer">Close</button>
    </div>`;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.querySelector('#aboutClose').onclick = close;
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
  });

  // Renders the update section based on current state, and (re)wires its buttons.
  const section = overlay.querySelector('#aboutUpdate');
  const btnBase = "padding:8px 18px;border-radius:8px;font-family:'Sora',sans-serif;font-size:12px;font-weight:700;cursor:pointer;";
  function paintUpdate(statusMsg = '') {
    if (updateInfo) {
      section.innerHTML = `
        <div style="background:var(--accent-dim);border:1px solid rgba(234,252,136,0.3);border-radius:8px;padding:12px 14px">
          <div style="font-size:13px;font-weight:600;color:#EAFC88;margin-bottom:8px">Update available — v${updateInfo.version}</div>
          <button id="aboutDownload" style="${btnBase}background:#EAFC88;border:none;color:#141400">Download v${updateInfo.version}</button>
        </div>`;
      section.querySelector('#aboutDownload').onclick = () => {
        if (updateInfo?.url) window.electronAPI.openExternal(updateInfo.url);
      };
    } else {
      section.innerHTML = `
        <button id="aboutCheck" style="${btnBase}background:transparent;border:1px solid rgba(255,255,255,0.15);color:rgba(232,232,240,0.7);font-weight:600">Check for updates</button>
        <div id="aboutCheckStatus" style="font-size:11px;color:rgba(232,232,240,0.45);margin-top:8px;min-height:14px">${statusMsg}</div>`;
      section.querySelector('#aboutCheck').onclick = async () => {
        const btn = section.querySelector('#aboutCheck');
        const status = section.querySelector('#aboutCheckStatus');
        btn.disabled = true; btn.style.opacity = '0.5'; status.textContent = 'Checking…';
        const result = await checkForUpdate({ notify: false });
        if (result === 'update')        paintUpdate();   // updateInfo now set → shows banner
        else if (result === 'current')  paintUpdate(`You're on the latest version (v${version}).`);
        else if (result === 'disabled') paintUpdate('Update checking is not configured.');
        else                            paintUpdate("Couldn't reach the update server. Try again later.");
      };
    }
  }
  paintUpdate();
}

// ── Model download modal ───────────────────────────────────────────────────
function showModelDownloadModal(modelName, modelInfo) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);display:flex;align-items:center;justify-content:center;z-index:9999;';
    const SIZES = { tiny:'~75 MB', small:'~460 MB', medium:'~1.5 GB', large:'~3 GB' };
    overlay.innerHTML = `
      <div style="background:#16161d;border:1px solid rgba(255,255,255,0.1);border-radius:12px;padding:28px 32px;width:420px;font-family:'Sora',sans-serif;color:#e8e8f0;">
        <div style="font-size:20px;font-weight:700;margin-bottom:8px">Download Whisper model</div>
        <div style="font-size:13px;color:rgba(232,232,240,0.55);margin-bottom:22px;line-height:1.6">
          The <strong style="color:#EAFC88">${modelName}</strong> model (${SIZES[modelName]||modelInfo.size_mb+' MB'})
          needs to be downloaded once and is saved for future use.
        </div>
        <div id="dlStatus" style="display:none;margin-bottom:16px">
          <div style="height:3px;background:rgba(255,255,255,0.08);border-radius:2px;overflow:hidden;margin-bottom:8px">
            <div id="dlBar" style="height:100%;background:#EAFC88;width:0%;transition:width 0.3s ease"></div>
          </div>
          <div id="dlLabel" style="font-size:12px;font-family:'DM Mono',monospace;color:rgba(232,232,240,0.5)">Connecting...</div>
        </div>
        <div id="dlButtons" style="display:flex;gap:10px;justify-content:flex-end">
          <button id="dlCancel" style="padding:9px 18px;background:transparent;border:1px solid rgba(255,255,255,0.1);border-radius:8px;color:rgba(232,232,240,0.6);font-family:'Sora',sans-serif;font-size:13px;cursor:pointer">Cancel</button>
          <button id="dlStart"  style="padding:9px 20px;background:#EAFC88;border:none;border-radius:8px;color:#141400;font-family:'Sora',sans-serif;font-size:13px;font-weight:700;cursor:pointer">Download &amp; continue</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#dlCancel').onclick = () => { overlay.remove(); resolve(false); };
    overlay.querySelector('#dlStart').onclick  = async () => {
      overlay.querySelector('#dlButtons').style.display = 'none';
      overlay.querySelector('#dlStatus').style.display  = 'block';
      try {
        const r = await fetch(`http://localhost:${backendPort}/models/${modelName}/download`, {method:'POST'});
        const d = await r.json();
        if (d.status === 'already_cached') { overlay.remove(); resolve(true); return; }
        const iv = setInterval(async () => {
          const job = await fetch(`http://localhost:${backendPort}/job/${d.job_id}`).then(r=>r.json());
          overlay.querySelector('#dlBar').style.width = (job.progress||0)+'%';
          overlay.querySelector('#dlLabel').textContent = job.message||'...';
          if (job.status==='done')  { clearInterval(iv); setTimeout(()=>{ overlay.remove(); resolve(true); },500); }
          if (job.status==='error') { clearInterval(iv); overlay.querySelector('#dlLabel').style.color='#ff5f5f'; overlay.querySelector('#dlLabel').textContent='Error: '+job.message; }
        }, 700);
      } catch(e) { overlay.querySelector('#dlLabel').textContent='Error: '+e.message; }
    };
  });
}

// ── Model manager ──────────────────────────────────────────────────────────
async function showModelManager() {
  let modelsData;
  try { modelsData = await fetch(`http://localhost:${backendPort}/models`).then(r=>r.json()); }
  catch(e) { showToast('Cannot reach backend','error'); return; }

  const META = { tiny:{label:'Tiny',desc:'Fastest'},small:{label:'Small',desc:'Recommended'},medium:{label:'Medium',desc:'High accuracy'},large:{label:'Large',desc:'Best quality'} };
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.78);display:flex;align-items:center;justify-content:center;z-index:9999;';

  const rows = Object.entries(modelsData).map(([name,info]) => {
    const m = META[name]||{label:name,desc:''};
    return `<div style="display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid rgba(255,255,255,0.07)">
      <div style="flex:1">
        <div style="font-size:13px;font-weight:600;margin-bottom:2px">${m.label}
          ${info.cached?'<span style="font-size:10px;background:rgba(95,255,154,0.12);color:#5fff9a;padding:2px 7px;border-radius:10px;margin-left:6px">cached</span>':''}
        </div>
        <div style="font-size:11px;color:rgba(232,232,240,0.45)">${m.desc} · ${info.size_mb} MB</div>
        <div class="mm-job-${name}" style="font-size:11px;font-family:'DM Mono',monospace;color:rgba(234,252,136,0.7);margin-top:3px;display:none"></div>
        <div class="mm-track-${name}" style="height:2px;background:rgba(255,255,255,0.06);border-radius:1px;margin-top:5px;display:none">
          <div class="mm-bar-${name}" style="height:100%;background:#EAFC88;width:0%;transition:width 0.3s"></div>
        </div>
      </div>
      <div>
        ${!info.cached
          ? `<button class="mm-dl-btn" data-model="${name}" style="padding:6px 12px;background:#EAFC88;border:none;border-radius:6px;color:#141400;font-family:'Sora',sans-serif;font-size:11px;font-weight:700;cursor:pointer">Download</button>`
          : `<button class="mm-del-btn" data-model="${name}" style="padding:6px 12px;background:transparent;border:1px solid rgba(255,95,95,0.25);border-radius:6px;color:rgba(255,95,95,0.7);font-family:'Sora',sans-serif;font-size:11px;cursor:pointer">Delete</button>`}
      </div>
    </div>`;
  }).join('');

  overlay.innerHTML = `<div style="background:#16161d;border:1px solid rgba(255,255,255,0.1);border-radius:12px;padding:24px 28px;width:480px;font-family:'Sora',sans-serif;color:#e8e8f0;">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px">
      <div style="font-size:18px;font-weight:700">Whisper models</div>
      <button id="mmClose" style="background:none;border:none;color:rgba(232,232,240,0.4);font-size:18px;cursor:pointer">✕</button>
    </div>
    ${rows}
    <div style="margin-top:16px;text-align:right">
      <button id="mmDone" style="padding:8px 20px;background:transparent;border:1px solid rgba(255,255,255,0.1);border-radius:8px;color:rgba(232,232,240,0.7);font-family:'Sora',sans-serif;font-size:13px;cursor:pointer">Done</button>
    </div>
  </div>`;

  document.body.appendChild(overlay);
  overlay.querySelector('#mmClose').onclick = () => overlay.remove();
  overlay.querySelector('#mmDone').onclick  = () => overlay.remove();

  overlay.querySelectorAll('.mm-dl-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const name = btn.dataset.model;
      btn.disabled=true; btn.style.opacity='0.5'; btn.textContent='Starting...';
      const jobEl=overlay.querySelector('.mm-job-'+name), track=overlay.querySelector('.mm-track-'+name), bar=overlay.querySelector('.mm-bar-'+name);
      jobEl.style.display=track.style.display='block';
      try {
        const d = await fetch(`http://localhost:${backendPort}/models/${name}/download`,{method:'POST'}).then(r=>r.json());
        if (d.status==='already_cached') { jobEl.textContent='Already cached.'; return; }
        const iv = setInterval(async()=>{
          const job = await fetch(`http://localhost:${backendPort}/job/${d.job_id}`).then(r=>r.json());
          bar.style.width=(job.progress||0)+'%'; jobEl.textContent=job.message||'...';
          if(job.status==='done'){clearInterval(iv);jobEl.style.color='#5fff9a';jobEl.textContent='Done!';}
          if(job.status==='error'){clearInterval(iv);jobEl.style.color='#ff5f5f';jobEl.textContent='Error: '+job.message;}
        },700);
      } catch(e){jobEl.textContent='Error: '+e.message;jobEl.style.color='#ff5f5f';}
    });
  });

  overlay.querySelectorAll('.mm-del-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const name = btn.dataset.model;
      if (!confirm(`Delete the ${name} model?`)) return;
      await fetch(`http://localhost:${backendPort}/models/${name}/delete`,{method:'POST'});
      btn.textContent='Deleted'; btn.disabled=true; btn.style.opacity='0.4';
      showToast(`${name} model deleted`);
    });
  });
}

// ── Toast ──────────────────────────────────────────────────────────────────
let toastTimer = null;
function showToast(msg, type='') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className   = 'toast show' + (type?' '+type:'');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
}

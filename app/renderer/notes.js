'use strict';
/* Note editor: find the notes in a part, then move, re-pitch, stretch, add and delete them.
   Shares globals with app.js (state, player, api, $, $$, toast, color, stemLabel, ...). */

const KEYS_W = 104;
const TRACK_H = 22;
const RULER_H = 22;
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const BLACK = new Set([1, 3, 6, 8, 10]);
const noteName = (m) => `${NOTE_NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;

let ne = null;          // open editor state, or null
let noteJob = null;     // running detection job

// ------------------------------------------------------------------ open / close

async function openNotes(stem) {
  const p = state.current;
  if (!p) return;
  const hear = ne ? ne.hear : null;
  if (ne) closeNotes(true, true);
  state.lastNoteStem = stem;
  if (isSynth(stem)) {
    const sy = p.synths[stem];
    ne = {
      kind: 'synth', stem, base: state.version, detected: [], notes: clone(sy.notes), has: true,
      sel: new Set(), undo: [], pps: +$('#zoomSlider').value, rowH: 14, lo: 36, hi: 84, drag: null,
      saving: false, again: false, timer: null, hear: hear || 'all',
    };
    enterNoteView();
    if (state.noteMode === 'sheet') showSheet(); else await showRoll();
    return;
  }
  let data = null;
  if (stem !== 'drums') {
    try { data = await api(`/projects/${p.id}/notes/${stem}`); } catch (e) { toast(e.message); return; }
  }
  if (data && data.base !== state.version && state.noteMode !== 'sheet') {
    // notes belong to the other version; play that one so what you hear matches
    state.version = data.base;
    await loadVersion();
  }
  ne = {
    kind: stem === 'drums' ? 'drums' : 'part', hear: hear || 'solo', stem, base: data ? data.base : 'stems',
    detected: data ? data.detected : [], notes: data ? clone(data.notes) : [],
    has: !!data, sel: new Set(), undo: [], pps: +$('#zoomSlider').value, rowH: 14,
    lo: 36, hi: 84, drag: null, saving: false, again: false, timer: null,
  };
  enterNoteView();
  if (state.noteMode === 'sheet') { showSheet(); return; }
  if (!ne.has) { showWaiting(); return; }
  await showRoll();
}

// notes are found in the background after splitting; show where that's at
function showWaiting() {
  $('#rollWrap').hidden = true;
  $('#noteHelp').hidden = true;
  $('#sheetView').hidden = true;
  $('#noteDetect').hidden = false;
  $$('.note-bar #undoBtn, .note-bar #resetNotesBtn, .note-bar #redetectBtn, .note-bar .zoom, .note-bar .inline')
    .forEach((el) => { el.hidden = true; });
  $('#noteStatus').textContent = '';
  const btn = $('#detectBtn');
  if (ne.kind === 'drums') {
    $('#detectText').textContent = "Drums don't play notes, so there's nothing to show in the piano roll. Switch to Chords & lyrics, or pick another track above.";
    btn.hidden = true; $('#detectProgress').hidden = true;
    return;
  }
  const task = `notes:${ne.stem}`;
  const ex = state.extras || {};
  const st = ((ex.status || {}).notes || {})[ne.stem] || '';
  const running = ex.now && ex.now.task === task;
  const queuedAt = (ex.queued || []).indexOf(task);
  $('#detectProgress').hidden = !running;
  if (running) {
    $('#detectText').textContent = `Finding the notes in the ${stemLabel(ne.stem).toLowerCase()} part…`;
    $('#detectBar').style.width = `${Math.round((ex.now.progress || 0) * 100)}%`;
    $('#detectStage').textContent = `${Math.round((ex.now.progress || 0) * 100)}%`;
    btn.hidden = true;
  } else if (st.startsWith('error')) {
    $('#detectText').textContent = `Couldn't find the notes in this part. ${st.replace(/^error:\s*/, '')}`;
    btn.hidden = false; btn.textContent = 'Try again';
  } else {
    $('#detectText').textContent = queuedAt > 0
      ? `Stemlab is finding the notes in each part. ${stemLabel(ne.stem)} is next up after ${queuedAt} other ${queuedAt === 1 ? 'task' : 'tasks'}.`
      : `Stemlab is about to find the notes in the ${stemLabel(ne.stem).toLowerCase()} part.`;
    btn.hidden = true;
    if (queuedAt !== 0 && !running) api(`/projects/${state.current.id}/extras`, { method: 'POST', body: { first: task } })
      .then((r) => { state.extras = r; }).catch(() => {});
  }
  extrasPoll();
}

$('#detectBtn').onclick = async () => {
  if (!ne) return;
  const r = await api(`/projects/${state.current.id}/extras`, { method: 'POST', body: { retry: `notes:${ne.stem}` } }).catch((e) => { toast(e.message); });
  if (r) { state.extras = r; showWaiting(); }
};

// keep an eye on background work for the open song
let extrasTimer = null;
function extrasPoll() {
  clearTimeout(extrasTimer);
  const p = state.current;
  if (!p || p.status !== 'ready') return;
  extrasTimer = setTimeout(async () => {
    const cur = state.current;
    if (!cur || cur.id !== p.id) return;
    let r;
    try { r = await api(`/projects/${p.id}/extras`); } catch { return; }
    const before = JSON.stringify((state.extras || {}).status || {});
    state.extras = r;
    const changed = JSON.stringify(r.status || {}) !== before;
    if (changed) {
      const fresh = await api('/projects/' + p.id).catch(() => null);
      if (fresh && state.current && state.current.id === p.id) {
        state.current.note_edits = fresh.note_edits;
        state.current.sheet = fresh.sheet;
        state.current.extras = fresh.extras;
      }
    }
    if (ne && ne.kind === 'part' && !ne.has && state.noteMode !== 'sheet') {
      const done = ((r.status || {}).notes || {})[ne.stem] === 'done';
      if (done) openNotes(ne.stem); else showWaiting();
    }
    if (ne && state.noteMode === 'sheet' && (changed || r.now)) paintSheetStatus(changed);
    if (r.now || (r.queued && r.queued.length)) extrasPoll();
  }, 1200);
}

function enterNoteView() {
  $('#projectView').classList.add('notes-open');
  $('#noteView').hidden = false;
  $('#noteTitle').textContent = stemLabel(ne.stem);
  $$('#viewSeg button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === (state.noteMode || 'roll'))));
  $('#noteView').style.setProperty('--c', color(ne.stem));
  $('#synthTools').hidden = ne.kind !== 'synth';
  if (ne.kind === 'synth') fillSynthTools();
  setHear(ne.hear);
  syncModeSeg();
  layoutTracks();
}

function closeNotes(silent, keepView) {
  if (!ne) return;
  if (ne.timer) { clearTimeout(ne.timer); flushSave(); }
  ne = null;
  state.noteSolo = null;
  syncModeSeg();
  if (keepView) return;
  $('#projectView').classList.remove('notes-open');
  $('#noteView').hidden = true;
  if (silent) return;
  applyMix();
  requestAnimationFrame(drawWaveImages);
}

function setHear(mode) {
  $$('#hearSeg button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.hear === mode)));
  if (ne) ne.hear = mode;
  state.noteSolo = mode === 'solo' && ne ? ne.stem : null;
  applyMix();
}
$$('#hearSeg button').forEach((b) => b.addEventListener('click', () => setHear(b.dataset.hear)));

$('#redetectBtn').onclick = () => {
  if (confirm('Find the notes again? This throws away your note edits for this part.')) detectNotes();
};

async function detectNotes() {
  const p = state.current;
  if (!ne) return;
  ne.has = false;
  $('#rollWrap').hidden = true; $('#noteDetect').hidden = false;
  $('#detectBtn').hidden = true;
  $('#detectProgress').hidden = false;
  $('#detectText').textContent = 'Finding the notes again…';
  const stem = ne.stem;
  try {
    const r = await api(`/projects/${p.id}/notes/${stem}/detect`, { method: 'POST', body: { base: state.version } });
    noteJob = r.job;
    let j;
    do {
      await new Promise((res) => setTimeout(res, 500));
      j = await api('/jobs/' + r.job.id);
      if (ne && ne.stem === stem) {
        $('#detectBar').style.width = `${Math.round(j.progress * 100)}%`;
        $('#detectStage').textContent = j.stage || '';
      }
    } while (j.status === 'running');
    noteJob = null;
    if (j.status === 'error') throw new Error(j.error);
    state.current = await api('/projects/' + p.id);
    // the part plays its un-edited audio again
    await player.replace(stem, stemUrl(state.current, stem)).catch(() => {});
    markNoteLanes();
    if (ne && ne.stem === stem) {
      await openNotes(stem);
      if (!j.result.count) toast('No clear notes found in this part.');
    }
  } catch (e) {
    noteJob = null;
    toast("Couldn't find notes: " + e.message);
    if (ne) showWaiting();
  }
}

async function showRoll() {
  $('#sheetView').hidden = true;
  $('#noteDetect').hidden = true;
  $('#rollWrap').hidden = false;
  $('#noteHelp').hidden = false;
  $$('.note-bar #undoBtn, .note-bar #resetNotesBtn, .note-bar #redetectBtn, .note-bar .zoom, .note-bar .inline')
    .forEach((el) => { el.hidden = false; });
  $('#resetNotesBtn').hidden = $('#redetectBtn').hidden = ne.kind === 'synth';
  $('#synthTools').hidden = ne.kind !== 'synth';
  fitRange();
  status();
  layoutRoll();
  // centre the view on the notes near the playhead
  const sc = $('#rollScroll');
  const mid = ne.notes.length ? ne.notes[Math.floor(ne.notes.length / 2)].midi : 60;
  sc.scrollTop = Math.max(0, (ne.hi - mid) * ne.rowH - sc.clientHeight / 2);
  followPlayhead(true);
  sc.focus({ preventScroll: true });
  if (ne.kind === 'synth') return;
  // the part's original audio, streamed, for hearing notes as you move them
  ne.srcUrl = audioUrl(state.current.id, ne.base, ne.stem);
}

function fitRange() {
  const ms = ne.notes.concat(ne.detected).map((n) => n.midi);
  const lo = ms.length ? Math.min(...ms) : 48;
  const hi = ms.length ? Math.max(...ms) : 72;
  ne.lo = Math.max(0, Math.min(lo - 12, 36));
  ne.hi = Math.min(127, Math.max(hi + 12, ne.lo + 36));
}

function layoutRoll() {
  if (!ne) return;
  const sp = $('#rollSpacer');
  sp.style.width = `${KEYS_W + player.duration * ne.pps + 40}px`;
  sp.style.height = `${RULER_H + (ne.hi - ne.lo + 1) * ne.rowH}px`;
}

function status(text) {
  if (ne.kind === 'synth') {
    $('#noteStatus').textContent = text || (ne.notes.length ? `${ne.notes.length} notes` : 'Double-click to add notes');
    $('#undoBtn').disabled = !ne.undo.length;
    return;
  }
  const edited = ne.notes.some((n) => changed(n)) || ne.notes.filter((n) => !n.src).length !== ne.detected.length;
  $('#noteStatus').textContent = text || `${ne.notes.length} notes${edited ? ', edited' : ''}`;
  $('#undoBtn').disabled = !ne.undo.length;
  $('#resetNotesBtn').disabled = !edited;
}

// ------------------------------------------------------------------ geometry

const clone = (x) => JSON.parse(JSON.stringify(x));
const changed = (n) => (ne && ne.kind === 'synth') ? false : n.src || n.midi !== n.orig_midi || Math.abs(n.start - n.orig_start) > 1e-3 || Math.abs(n.end - n.orig_end) > 1e-3;
function view() {
  const sc = $('#rollScroll');
  return { x: sc.scrollLeft, y: sc.scrollTop, w: sc.clientWidth, h: sc.clientHeight };
}
const tx = (t, v) => KEYS_W + t * ne.pps - v.x;
const my = (m, v) => RULER_H + (ne.hi - m) * ne.rowH - v.y;
function at(e) {
  const r = $('#rollScroll').getBoundingClientRect();
  const v = view();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  return { x, y, t: (x - KEYS_W + v.x) / ne.pps, m: ne.hi - Math.floor((y - RULER_H + v.y) / ne.rowH), v };
}
function hit(pt) {
  for (let i = ne.notes.length - 1; i >= 0; i--) {
    const n = ne.notes[i];
    const x0 = tx(n.start, pt.v), x1 = tx(n.end, pt.v), y0 = my(n.midi, pt.v);
    if (pt.x >= x0 - 1 && pt.x <= x1 + 1 && pt.y >= y0 && pt.y < y0 + ne.rowH) {
      return { n, edge: x1 - pt.x < Math.min(7, (x1 - x0) / 3) };
    }
  }
  return null;
}

function gridTimes() {
  const beats = currentBeats();
  if (beats.length < 2) return null;
  const pts = [];
  for (let i = 0; i < beats.length - 1; i++) {
    for (let j = 0; j < 4; j++) pts.push(beats[i] + (beats[i + 1] - beats[i]) * j / 4);
  }
  pts.push(beats[beats.length - 1]);
  return pts;
}
function snap(t) {
  if (!$('#snapCheck').checked) return t;
  const g = gridTimes();
  if (!g) return t;
  let best = t, d = Infinity;
  let lo = 0, hi = g.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (g[mid] < t) lo = mid; else hi = mid; }
  for (const c of [g[lo], g[hi]]) { if (Math.abs(c - t) < d) { d = Math.abs(c - t); best = c; } }
  return best;
}

// ------------------------------------------------------------------ drawing

function drawRoll(pos) {
  if (!ne) return;
  if ($('#rollWrap').hidden) { drawTracks(pos, { x: 0, y: 0 }); followSheet(pos); return; }
  const cv = $('#roll');
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = cv.clientHeight;
  if (cv.width !== Math.floor(W * dpr) || cv.height !== Math.floor(H * dpr)) {
    cv.width = Math.floor(W * dpr); cv.height = Math.floor(H * dpr);
  }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const v = view();
  g.fillStyle = '#23211e';
  g.fillRect(0, 0, W, H);

  // pitch rows
  for (let m = ne.hi; m >= ne.lo; m--) {
    const y = my(m, v);
    if (y > H || y + ne.rowH < RULER_H) continue;
    g.fillStyle = BLACK.has(m % 12) ? '#1f1d1a' : '#282521';
    g.fillRect(KEYS_W, y, W - KEYS_W, ne.rowH);
    if (m % 12 === 0) { g.fillStyle = '#3e3a34'; g.fillRect(KEYS_W, y + ne.rowH - 1, W - KEYS_W, 1); }
  }
  // beat grid
  const beats = currentBeats();
  if (beats.length > 1) {
    beats.forEach((b, i) => {
      const x = tx(b, v);
      if (x < KEYS_W || x > W) return;
      g.fillStyle = i % 4 === 0 ? 'rgba(237,231,220,0.16)' : 'rgba(237,231,220,0.06)';
      g.fillRect(Math.round(x), RULER_H, 1, H);
    });
  }
  // original positions of changed notes, faintly
  const c = color(ne.stem);
  if (ne.kind !== 'synth') {
  g.setLineDash([3, 3]);
  g.strokeStyle = 'rgba(237,231,220,0.28)';
  for (const n of ne.notes) {
    if (n.src || !changed(n)) continue;
    const x0 = tx(n.orig_start, v), x1 = tx(n.orig_end, v), y = my(n.orig_midi, v);
    if (x1 < KEYS_W || x0 > W) continue;
    g.strokeRect(x0 + 0.5, y + 1.5, Math.max(2, x1 - x0 - 1), ne.rowH - 3);
  }
  }
  g.setLineDash([]);
  // notes
  g.font = '600 10px Archivo';
  g.textBaseline = 'middle';
  for (const n of ne.notes) {
    const x0 = tx(n.start, v), x1 = tx(n.end, v), y = my(n.midi, v);
    if (x1 < KEYS_W || x0 > W || y > H || y + ne.rowH < RULER_H) continue;
    const w = Math.max(3, x1 - x0);
    const playing = pos >= n.start && pos < n.end;
    g.globalAlpha = 0.55 + 0.45 * Math.min(1, (n.level || n.vel || 0.6) * 1.4);
    g.fillStyle = c;
    g.fillRect(x0, y + 1, w, ne.rowH - 2);
    g.globalAlpha = 1;
    if (n.src) { g.fillStyle = 'rgba(35,33,30,0.55)'; g.fillRect(x0, y + 1, 3, ne.rowH - 2); }
    if (ne.sel.has(n.id) || playing) {
      g.strokeStyle = ne.sel.has(n.id) ? '#fffaf0' : 'rgba(255,250,240,0.6)';
      g.lineWidth = ne.sel.has(n.id) ? 2 : 1;
      g.strokeRect(x0 + 0.5, y + 1.5, w - 1, ne.rowH - 3);
      g.lineWidth = 1;
    }
    if (w > 30) { g.fillStyle = '#23211e'; g.fillText(noteName(n.midi), x0 + 5, y + ne.rowH / 2 + 0.5); }
  }
  // rubber band selection
  if (ne.drag && ne.drag.kind === 'box') {
    const d = ne.drag;
    g.fillStyle = 'rgba(241,234,217,0.08)';
    g.strokeStyle = 'rgba(241,234,217,0.6)';
    const x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1);
    g.fillRect(x, y, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
    g.strokeRect(x + 0.5, y + 0.5, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
  }
  // piano keys
  for (let m = ne.hi; m >= ne.lo; m--) {
    const y = my(m, v);
    if (y > H || y + ne.rowH < RULER_H) continue;
    const black = BLACK.has(m % 12);
    const sounding = ne.notes.some((n) => n.midi === m && pos >= n.start && pos < n.end);
    g.fillStyle = sounding ? c : black ? '#35312c' : '#d9d2c4';
    g.fillRect(0, y, black ? KEYS_W * 0.62 : KEYS_W - 1, ne.rowH - (black ? 1 : 0.5));
    if (!black) { g.fillStyle = '#b3ab9d'; g.fillRect(0, y + ne.rowH - 1, KEYS_W - 1, 1); }
    if (m % 12 === 0) { g.fillStyle = '#23211e'; g.font = '600 9.5px Archivo'; g.fillText(noteName(m), KEYS_W - 24, y + ne.rowH / 2); }
  }
  // time ruler
  g.fillStyle = '#23211e';
  g.fillRect(0, 0, W, RULER_H);
  g.fillStyle = '#3e3a34';
  g.fillRect(0, RULER_H - 1, W, 1);
  g.fillStyle = '#a39b8f';
  g.font = '11px Archivo';
  if (beats.length > 1) {
    let last = -1e9;
    for (let i = 0; i < beats.length; i += 4) {
      const x = tx(beats[i], v);
      if (x < KEYS_W || x > W || x - last < 34) continue;
      g.fillRect(Math.round(x), RULER_H - 7, 1, 7);
      g.fillText(String(i / 4 + 1), x + 3, RULER_H / 2);
      last = x;
    }
  } else {
    for (let t = 0; t < player.duration; t += 5) {
      const x = tx(t, v);
      if (x < KEYS_W || x > W) continue;
      g.fillRect(Math.round(x), RULER_H - 7, 1, 7);
      g.fillText(fmtTime(t), x + 3, RULER_H / 2);
    }
  }
  // playhead
  const px = tx(pos, v);
  if (px >= KEYS_W && px <= W) { g.fillStyle = '#f1ead9'; g.fillRect(Math.round(px), 0, 1.5, H); }
  followPlayhead(false);
  drawTracks(pos, v);
}

function followPlayhead(force) {
  if (!ne || $('#rollWrap').hidden) return;
  const sc = $('#rollScroll');
  const pos = player.position();
  const x = KEYS_W + pos * ne.pps - sc.scrollLeft;
  if (force || (player.playing && !ne.drag && (x > sc.clientWidth - 30 || x < KEYS_W))) {
    const target = force && x >= KEYS_W + 40 && x <= sc.clientWidth - 60 ? sc.scrollLeft
      : pos * ne.pps - (force ? sc.clientWidth * 0.3 : 20);
    sc.scrollLeft = Math.max(0, target);
  }
}

// ------------------------------------------------------------------ hearing notes

const previewEl = new Audio();
previewEl.crossOrigin = 'anonymous';
previewEl.preservesPitch = false;
let previewTimer = null;

function preview(n, midi) {
  if (ne && ne.kind === 'synth') { synthPreview((state.current.synths[ne.stem] || {}).preset, midi ?? n.midi, Math.min(0.6, n.end - n.start)); return; }
  if (!ne || !ne.srcUrl) return;
  const src = n.src ? ne.detected.find((d) => d.id === n.src) : n;
  if (!src) return;
  const rate = Math.pow(2, ((midi ?? n.midi) - src.orig_midi) / 12);
  const len = Math.min(1.2, src.orig_end - src.orig_start + 0.05);
  if (previewEl.src !== ne.srcUrl) previewEl.src = ne.srcUrl;
  clearTimeout(previewTimer);
  const go = () => {
    previewEl.playbackRate = Math.max(0.25, Math.min(4, rate));
    previewEl.volume = 0.9;
    previewEl.play().catch(() => {});
    previewTimer = setTimeout(() => previewEl.pause(), (len / previewEl.playbackRate) * 1000);
  };
  previewEl.currentTime = Math.max(0, src.orig_start - 0.005);
  if (previewEl.readyState >= 2) go(); else previewEl.addEventListener('canplay', go, { once: true });
}

// ------------------------------------------------------------------ editing

function commit(before) {
  ne.undo.push(before);
  if (ne.undo.length > 100) ne.undo.shift();
  status();
  scheduleSave();
}

function scheduleSave() {
  clearTimeout(ne.timer);
  ne.timer = setTimeout(flushSave, 350);
}

async function flushSave() {
  const cur = ne;
  if (!cur) return;
  cur.timer = null;
  if (cur.saving) { cur.again = true; return; }
  cur.saving = true;
  const p = state.current;
  const stem = cur.stem;
  $('#noteStatus').textContent = 'Updating the sound…';
  try {
    if (cur.kind === 'synth') {
      const res = await api(`/projects/${p.id}/synths/${stem}`, { method: 'PUT', body: { notes: cur.notes } });
      p.synths[stem] = res;
      await player.replace(stem, stemUrl(p, stem));
      refreshSynthLane(stem);
      if (ne === cur) status();
      return;
    }
    const res = await api(`/projects/${p.id}/notes/${stem}`, { method: 'PUT', body: { notes: cur.notes } });
    if (state.current && state.current.id === p.id) {
      state.current.note_edits = state.current.note_edits || {};
      state.current.note_edits[stem] = res;
      await player.replace(stem, stemUrl(state.current, stem));
      markNoteLanes();
    }
    if (ne === cur) status();
  } catch (e) {
    toast("Couldn't update the sound: " + e.message);
    if (ne === cur) status();
  } finally {
    cur.saving = false;
    if (cur.again) { cur.again = false; flushSave(); }
  }
}

$('#undoBtn').onclick = () => {
  if (!ne || !ne.undo.length) return;
  ne.notes = ne.undo.pop();
  ne.sel.clear();
  status();
  scheduleSave();
};
$('#resetNotesBtn').onclick = () => {
  if (!ne) return;
  const before = clone(ne.notes);
  ne.notes = clone(ne.detected);
  ne.sel.clear();
  commit(before);
};
$('#zoomSlider').oninput = (e) => {
  if (!ne) return;
  const sc = $('#rollScroll');
  const centerT = (sc.scrollLeft + sc.clientWidth / 2 - KEYS_W) / ne.pps;
  ne.pps = +e.target.value;
  layoutRoll();
  sc.scrollLeft = Math.max(0, centerT * ne.pps + KEYS_W - sc.clientWidth / 2);
};

function sourceFor(t) {
  const sel = ne.notes.find((n) => ne.sel.has(n.id));
  if (sel) return sel;
  let best = null, d = Infinity;
  for (const n of ne.notes) {
    const dd = Math.abs((n.start + n.end) / 2 - t);
    if (dd < d) { d = dd; best = n; }
  }
  return best;
}

const sc = $('#rollScroll');

sc.addEventListener('pointerdown', (e) => {
  if (!ne || e.button !== 0) return;
  const pt = at(e);
  sc.focus({ preventScroll: true });
  if (pt.y < RULER_H) {                              // click the ruler to jump
    player.seek(Math.max(0, Math.min(player.duration, pt.t)));
    return;
  }
  if (pt.x < KEYS_W) {                               // click a key to hear it
    if (ne.kind === 'synth') { preview({ start: 0, end: 0.5, midi: pt.m }, pt.m); return; }
    const src = sourceFor(player.position());
    if (src) preview(src, pt.m);
    return;
  }
  const h = hit(pt);
  if (h) {
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      if (ne.sel.has(h.n.id)) ne.sel.delete(h.n.id); else ne.sel.add(h.n.id);
    } else if (!ne.sel.has(h.n.id)) {
      ne.sel = new Set([h.n.id]);
    }
    if (!ne.sel.has(h.n.id)) return;
    ne.drag = {
      kind: h.edge ? 'resize' : 'move', anchor: h.n, t0: pt.t, m0: pt.m, lastDm: 0, moved: false,
      before: clone(ne.notes),
      snap: new Map(ne.notes.filter((n) => ne.sel.has(n.id)).map((n) => [n.id, { start: n.start, end: n.end, midi: n.midi }])),
    };
    if (!h.edge) preview(h.n);
  } else {
    if (!e.shiftKey) ne.sel.clear();
    ne.drag = { kind: 'box', x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y, keep: new Set(ne.sel) };
  }
  sc.setPointerCapture(e.pointerId);
});

sc.addEventListener('pointermove', (e) => {
  if (!ne) return;
  const pt = at(e);
  if (!ne.drag) {
    const h = pt.y > RULER_H && pt.x > KEYS_W ? hit(pt) : null;
    sc.style.cursor = h ? (h.edge ? 'ew-resize' : 'grab') : pt.y < RULER_H ? 'pointer' : 'default';
    return;
  }
  const d = ne.drag;
  if (d.kind === 'box') {
    d.x1 = pt.x; d.y1 = pt.y;
    const [xa, xb] = [Math.min(d.x0, d.x1), Math.max(d.x0, d.x1)];
    const [ya, yb] = [Math.min(d.y0, d.y1), Math.max(d.y0, d.y1)];
    ne.sel = new Set(d.keep);
    for (const n of ne.notes) {
      const x0 = tx(n.start, pt.v), x1 = tx(n.end, pt.v), y0 = my(n.midi, pt.v);
      if (x1 >= xa && x0 <= xb && y0 + ne.rowH >= ya && y0 <= yb) ne.sel.add(n.id);
    }
    return;
  }
  sc.style.cursor = d.kind === 'resize' ? 'ew-resize' : 'grabbing';
  const a0 = d.snap.get(d.anchor.id);
  if (d.kind === 'move') {
    let dt = pt.t - d.t0;
    dt = snap(a0.start + dt) - a0.start;
    const dm = pt.m - d.m0;
    for (const n of ne.notes) {
      const s0 = d.snap.get(n.id);
      if (!s0) continue;
      const len = s0.end - s0.start;
      n.start = Math.max(0, s0.start + dt);
      n.end = n.start + len;
      n.midi = Math.max(0, Math.min(127, s0.midi + dm));
    }
    if (dm !== d.lastDm) { d.lastDm = dm; preview(d.anchor); }
    if (Math.abs(dt) > 0.005 || dm) d.moved = true;
  } else {
    const end = snap(a0.end + (pt.t - d.t0));
    const delta = end - a0.end;
    for (const n of ne.notes) {
      const s0 = d.snap.get(n.id);
      if (!s0) continue;
      n.end = Math.max(n.start + 0.04, s0.end + delta);
    }
    if (Math.abs(delta) > 0.005) d.moved = true;
  }
  // keep dragged notes on screen
  if (pt.y < RULER_H + 10) sc.scrollTop -= 8; else if (pt.y > sc.clientHeight - 10) sc.scrollTop += 8;
  if (pt.x > sc.clientWidth - 10) sc.scrollLeft += 12; else if (pt.x < KEYS_W + 10) sc.scrollLeft -= 12;
});

function endDrag() {
  if (!ne || !ne.drag) return;
  const d = ne.drag;
  ne.drag = null;
  sc.style.cursor = 'default';
  if ((d.kind === 'move' || d.kind === 'resize') && d.moved) {
    ne.notes.sort((a, b) => a.start - b.start);
    commit(d.before);
  }
}
sc.addEventListener('pointerup', endDrag);
sc.addEventListener('pointercancel', endDrag);

sc.addEventListener('dblclick', (e) => {
  if (!ne) return;
  const pt = at(e);
  if (pt.y < RULER_H || pt.x < KEYS_W) return;
  const h = hit(pt);
  if (h) { preview(h.n); return; }
  if (ne.kind === 'synth') {
    const before = clone(ne.notes);
    const start = Math.max(0, snap(pt.t));
    const sel = ne.notes.find((x) => ne.sel.has(x.id));
    const beats = currentBeats();
    const len = sel ? sel.end - sel.start : beats.length > 1 ? (beats[beats.length - 1] - beats[0]) / (beats.length - 1) : 0.4;
    const n = { id: 'n' + Math.random().toString(36).slice(2, 9), start, end: start + len, midi: pt.m, vel: 0.8 };
    ne.notes.push(n);
    ne.notes.sort((a, b) => a.start - b.start);
    ne.sel = new Set([n.id]);
    preview(n);
    commit(before);
    return;
  }
  const src = sourceFor(pt.t);
  if (!src) { toast('Find the notes first, then add new ones from their sound.'); return; }
  const orig = src.src ? ne.detected.find((x) => x.id === src.src) : ne.detected.find((x) => x.id === src.id) || src;
  const before = clone(ne.notes);
  const start = Math.max(0, snap(pt.t));
  const n = {
    id: 'a' + Math.random().toString(36).slice(2, 9),
    src: orig.id,
    start, end: start + (src.end - src.start), midi: pt.m,
    orig_start: orig.orig_start, orig_end: orig.orig_end, orig_midi: orig.orig_midi,
    level: orig.level, cents: 0,
  };
  ne.notes.push(n);
  ne.notes.sort((a, b) => a.start - b.start);
  ne.sel = new Set([n.id]);
  preview(n);
  commit(before);
});

sc.addEventListener('wheel', (e) => {
  if (!ne || !(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  const z = $('#zoomSlider');
  z.value = Math.max(+z.min, Math.min(+z.max, +z.value * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
  z.oninput({ target: z });
}, { passive: false });

window.addEventListener('resize', () => { if (ne) layoutRoll(); });

// keys that only mean something in the note editor (Space and arrows left/right are global)
function noteKey(e) {
  if (!ne || $('#rollWrap').hidden) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.code === 'KeyZ') { e.preventDefault(); $('#undoBtn').click(); return; }
  if (mod && e.code === 'KeyA') { e.preventDefault(); ne.sel = new Set(ne.notes.map((n) => n.id)); return; }
  if (e.code === 'Escape') { ne.sel.clear(); return; }
  if (!ne.sel.size) return;
  if (e.code === 'Delete' || e.code === 'Backspace') {
    e.preventDefault();
    const before = clone(ne.notes);
    ne.notes = ne.notes.filter((n) => !ne.sel.has(n.id));
    ne.sel.clear();
    commit(before);
  } else if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
    e.preventDefault();
    const step = (e.code === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 12 : 1);
    const before = clone(ne.notes);
    let first = null;
    for (const n of ne.notes) {
      if (!ne.sel.has(n.id)) continue;
      n.midi = Math.max(0, Math.min(127, n.midi + step));
      first = first || n;
    }
    if (first) {
      preview(first);
      const y = my(first.midi, view());
      if (y < RULER_H || y > sc.clientHeight - ne.rowH) sc.scrollTop += y - sc.clientHeight / 2;
    }
    commit(before);
  }
}


// ------------------------------------------------------------------ track overview (all parts as blocks)

const envCache = new Map(); // part -> {buf, env}
function envelope(part) {
  const t = player.buffers[part];
  if (!t || !t.peaks) return null;
  const c = envCache.get(part);
  if (c && c.peaks === t.peaks) return c.env;
  // 50 values a second, scaled so quiet parts stay quiet
  const step = Math.max(1, Math.round(t.rate / 50));
  const env = new Float32Array(Math.ceil(t.peaks.length / step));
  let top = 0;
  for (let i = 0; i < env.length; i++) {
    let m = 0;
    for (let j = i * step, e = Math.min(t.peaks.length, j + step); j < e; j++) if (t.peaks[j] > m) m = t.peaks[j];
    env[i] = m; if (m > top) top = m;
  }
  top = Math.max(top, 0.25);
  for (let i = 0; i < env.length; i++) env[i] /= top;
  envCache.set(part, { peaks: t.peaks, env });
  return env;
}

function trackNotes(p, part) {
  if (ne && ne.stem === part && !$('#rollWrap').hidden) return ne.notes;
  if (isSynth(part)) return (p.synths[part] || {}).notes || [];
  const e = p.note_edits && p.note_edits[part];
  return e && e.base === state.version ? e.notes : null;
}

function layoutTracks() {
  const p = state.current;
  if (!p) return;
  $('#tracksWrap').style.height = `${parts(p).length * TRACK_H + 1}px`;
}

function drawTracks(pos, v) {
  const p = state.current;
  const cv = $('#tracks');
  if (!p || !ne || !cv.clientWidth) return;
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = cv.clientHeight;
  if (cv.width !== Math.floor(W * dpr) || cv.height !== Math.floor(H * dpr)) { cv.width = Math.floor(W * dpr); cv.height = Math.floor(H * dpr); }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = '#1c1a18';
  g.fillRect(0, 0, W, H);
  const beats = currentBeats();
  const t0 = v.x / ne.pps, t1 = (v.x + W - KEYS_W) / ne.pps;
  parts(p).forEach((part, i) => {
    const y = i * TRACK_H;
    const c = color(part);
    const active = part === ne.stem;
    g.fillStyle = active ? '#34302a' : i % 2 ? '#211f1c' : '#1e1c19';
    g.fillRect(KEYS_W, y, W - KEYS_W, TRACK_H);
    // bar lines
    g.fillStyle = 'rgba(237,231,220,0.07)';
    for (let b = 0; b < beats.length; b += 4) {
      const x = tx(beats[b], v);
      if (x >= KEYS_W && x <= W) g.fillRect(Math.round(x), y, 1, TRACK_H);
    }
    const notes = trackNotes(p, part);
    if (notes && notes.length) {
      let lo = 127, hi = 0;
      for (const n of notes) { if (n.midi < lo) lo = n.midi; if (n.midi > hi) hi = n.midi; }
      const span = Math.max(6, hi - lo);
      g.fillStyle = c;
      for (const n of notes) {
        if (n.end < t0 || n.start > t1) continue;
        const x0 = tx(n.start, v), x1 = tx(n.end, v);
        const ny = y + 3 + (1 - (n.midi - lo) / span) * (TRACK_H - 9);
        g.fillRect(Math.max(KEYS_W, x0), ny, Math.max(2, x1 - Math.max(KEYS_W, x0) - 1), 3);
      }
    } else {
      const env = envelope(part);
      if (env) {
        g.fillStyle = c;
        g.globalAlpha = 0.45;
        const mid = y + TRACK_H / 2;
        for (let x = KEYS_W; x < W; x += 2) {
          const k = Math.floor(((x - KEYS_W + v.x) / ne.pps) * 50);
          if (k < 0 || k >= env.length) continue;
          const hh = Math.max(0.5, env[k] * (TRACK_H / 2 - 3));
          g.fillRect(x, mid - hh, 1.5, hh * 2);
        }
        g.globalAlpha = 1;
      }
    }
    // name
    g.fillStyle = active ? '#34302a' : '#2d2a26';
    g.fillRect(0, y, KEYS_W, TRACK_H);
    g.fillStyle = c;
    g.fillRect(0, y, 4, TRACK_H);
    g.fillStyle = active ? '#fffaf0' : '#a39b8f';
    g.font = `${active ? 650 : 500} 11.5px Archivo`;
    g.textBaseline = 'middle';
    g.fillText(stemLabel(part), 11, y + TRACK_H / 2 + 0.5, KEYS_W - 16);
    g.fillStyle = '#3e3a34';
    g.fillRect(0, y + TRACK_H - 1, W, 1);
  });
  const x = tx(pos, v);
  if (x >= KEYS_W && x <= W) { g.fillStyle = '#f1ead9'; g.fillRect(Math.round(x), 0, 1.5, H); }
}

$('#tracks').addEventListener('pointerdown', (e) => {
  const p = state.current;
  if (!p || !ne) return;
  const r = e.currentTarget.getBoundingClientRect();
  const part = parts(p)[Math.floor((e.clientY - r.top) / TRACK_H)];
  const x = e.clientX - r.left;
  if (x > KEYS_W) player.seek(Math.max(0, Math.min(player.duration, (x - KEYS_W + $('#rollScroll').scrollLeft) / ne.pps)));
  if (part && part !== ne.stem) openNotes(part);
});
$('#tracks').addEventListener('wheel', (e) => {
  e.preventDefault();
  $('#rollScroll').scrollLeft += e.deltaY + e.deltaX;
}, { passive: false });

// ------------------------------------------------------------------ synth tools

function fillSynthTools() {
  const p = state.current;
  const sy = p.synths[ne.stem];
  const ps = $('#presetSelect');
  ps.innerHTML = '';
  for (const [k, v] of Object.entries(SYNTH_PRESETS)) {
    const o = document.createElement('option');
    o.value = k; o.textContent = v.label; o.title = v.desc;
    ps.append(o);
  }
  ps.value = sy.preset;
  const cf = $('#copyFrom');
  cf.innerHTML = '';
  const count = (s) => ((p.note_edits && p.note_edits[s] && p.note_edits[s].notes) || []).length;
  const srcs = p.stems.filter((s) => count(s) > 0).sort((a, b) => count(b) - count(a));
  for (const s of srcs) {
    const o = document.createElement('option');
    o.value = s; o.textContent = `${stemLabel(s)} (${count(s)} notes)`;
    cf.append(o);
  }
  if (!srcs.length) {
    const o = document.createElement('option');
    o.value = ''; o.textContent = 'no notes found yet';
    cf.append(o);
  }
  cf.disabled = $('#copyBtn').disabled = !srcs.length;
  $('#copyFrom').title = srcs.length ? '' : 'Click a track above (like Vocals) and find its notes first';
}

function refreshSynthLane(sid) {
  const l = lanes[sid];
  const sy = state.current.synths[sid];
  if (!l || !sy) return;
  const sub = $('.lane-sub', l.el);
  if (sub) sub.textContent = presetLabel(sy.preset) + (sy.notes.length ? '' : ', no notes yet');
}

$('#presetSelect').addEventListener('change', async (e) => {
  if (!ne || ne.kind !== 'synth') return;
  const p = state.current, sid = ne.stem;
  $('#noteStatus').textContent = 'Changing the sound…';
  try {
    const res = await api(`/projects/${p.id}/synths/${sid}`, { method: 'PUT', body: { preset: e.target.value } });
    p.synths[sid] = res;
    await player.replace(sid, stemUrl(p, sid));
    refreshSynthLane(sid);
    synthPreview(res.preset, 60, 0.5);
  } catch (err) { toast(err.message); }
  if (ne) status();
});

$('#copyBtn').addEventListener('click', async () => {
  if (!ne || ne.kind !== 'synth') return;
  const p = state.current, sid = ne.stem;
  const from = $('#copyFrom').value;
  if (!from) return;
  if (ne.notes.length && !confirm(`Replace the ${ne.notes.length} notes in ${stemLabel(sid)} with the notes from ${stemLabel(from)}?`)) return;
  const before = clone(ne.notes);
  $('#noteStatus').textContent = 'Copying notes…';
  try {
    const res = await api(`/projects/${p.id}/synths/${sid}`, { method: 'PUT', body: { copy_from: from, shift: +$('#copyShift').value } });
    p.synths[sid] = res;
    ne.notes = clone(res.notes);
    ne.undo.push(before);
    fitRange(); layoutRoll();
    await player.replace(sid, stemUrl(p, sid));
    refreshSynthLane(sid);
  } catch (err) { toast(err.message); }
  if (ne) status();
});

// quick in-app voice so notes can be heard while you place them
function synthPreview(preset, midi, len) {
  if (!player.ctx) return;
  const ctx = player.ctx;
  if (ctx.state === 'suspended') ctx.resume();
  const f = 440 * Math.pow(2, (midi - 69) / 12);
  const now = ctx.currentTime;
  const dur = Math.max(0.15, len || 0.4);
  const out = ctx.createGain();
  const filt = ctx.createBiquadFilter();
  filt.type = 'lowpass';
  const recipe = {
    lead: [['sawtooth', 1, 0.5], ['sawtooth', 1.004, 0.4]], pluck: [['sawtooth', 1, 0.6], ['square', 1, 0.3]],
    keys: [['sine', 1, 0.8], ['sine', 2, 0.15]], pad: [['sawtooth', 0.995, 0.3], ['sawtooth', 1.005, 0.3], ['sawtooth', 1, 0.3]],
    bass: [['sawtooth', 1, 0.5], ['sine', 1, 0.7]], square: [['square', 1, 0.4]],
  }[preset] || [['sawtooth', 1, 0.5]];
  filt.frequency.setValueAtTime(Math.min(9000, f * (preset === 'pad' ? 4 : 9)), now);
  if (preset === 'pluck' || preset === 'bass') filt.frequency.exponentialRampToValueAtTime(Math.max(200, f * 2), now + 0.15);
  const attack = preset === 'pad' ? 0.2 : 0.008;
  const level = preset === 'square' ? 0.12 : 0.22;
  out.gain.setValueAtTime(0, now);
  out.gain.linearRampToValueAtTime(level, now + attack);
  out.gain.setValueAtTime(level * (preset === 'pluck' || preset === 'keys' ? 0.5 : 0.85), now + dur);
  out.gain.exponentialRampToValueAtTime(0.0001, now + dur + 0.25);
  filt.connect(out); out.connect(player.master);
  for (const [type, ratio, amp] of recipe) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type; o.frequency.value = f * ratio; g.gain.value = amp;
    o.connect(g); g.connect(filt);
    o.start(now); o.stop(now + dur + 0.3);
  }
}

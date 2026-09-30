'use strict';
/* global stemlab */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const STEM_LABEL = { vocals: 'Vocals', guitar: 'Guitar', piano: 'Piano', bass: 'Bass', drums: 'Drums', other: 'Everything else' };
const STEM_SHORT = { other: 'Other' };
const NOTE = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const STATUS_TEXT = { importing: 'Getting audio', splitting: 'Splitting', analyzing: 'Finding tempo', error: 'Needs attention' };

const state = {
  engine: null,
  projects: [],
  current: null,        // full project object
  version: 'stems',
  jobs: {},             // projectId -> job
  renderJob: null,
  mixer: {},            // projectId -> {stem: {vol, mute, solo}}
  view: null,
};

// ------------------------------------------------------------------ helpers

function show(id) {
  ['setup', 'booting', 'app'].forEach((s) => { $('#' + s).hidden = s !== id; });
}
function showView(id) {
  state.view = id;
  $$('.view').forEach((v) => { v.hidden = v.id !== id; });
}
function fmtTime(s) {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}
const SYNTH_COLORS = ['#ef7fb4', '#4fc9b8', '#f0a04b', '#9fb3ff'];
const isSynth = (s) => /^synth\d+$/.test(s);
function color(stem) {
  if (isSynth(stem)) return SYNTH_COLORS[(parseInt(stem.slice(5), 10) - 1) % SYNTH_COLORS.length];
  return getComputedStyle(document.documentElement).getPropertyValue('--' + stem).trim() || '#c8c0b2';
}
function stemLabel(s) {
  if (isSynth(s)) {
    const sy = state.current && state.current.synths && state.current.synths[s];
    return sy ? sy.name : 'Synth';
  }
  return STEM_LABEL[s] || s[0].toUpperCase() + s.slice(1);
}
// every playable part: the split instruments plus any synth parts
function parts(p) { return [...p.stems, ...Object.keys(p.synths || {})]; }

let toastTimer = null;
function toast(msg, action) {
  const t = $('#toast');
  t.innerHTML = '';
  const span = document.createElement('span');
  span.textContent = msg;
  t.append(span);
  if (action) {
    const b = document.createElement('button');
    b.textContent = action.label;
    b.onclick = () => { action.run(); t.hidden = true; };
    t.append(b);
  }
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, action ? 9000 : 4500);
}

async function api(path, opts = {}) {
  const { port, token } = state.engine;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: opts.method || 'GET',
    headers: { 'X-Stemlab-Token': token, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) throw new Error((data && data.error) || `Engine error ${res.status}`);
  return data;
}
function noteEdited(p, stem, version = state.version) {
  const ne = p.note_edits && p.note_edits[stem];
  return !!(ne && ne.active && ne.base === version);
}
function stemUrl(p, stem) {
  if (isSynth(stem)) return audioUrl(p.id, 'synth', stem) + '&v=' + ((p.synths[stem] || {}).stamp || 0);
  if (noteEdited(p, stem)) return audioUrl(p.id, 'notes', stem) + '&v=' + (p.note_edits[stem].stamp || 0);
  return audioUrl(p.id, state.version, stem);
}
function markNoteLanes() {
  const p = state.current;
  for (const [s, l] of Object.entries(lanes)) l.el.classList.toggle('notes-edited', noteEdited(p, s));
}
function audioUrl(pid, version, stem) {
  const { port, token } = state.engine;
  return `http://127.0.0.1:${port}/projects/${pid}/audio/${version}/${stem}.wav?t=${token}`;
}

// ------------------------------------------------------------------ setup & boot

async function boot() {
  let st;
  try { st = await stemlab.setupStatus(); } catch (e) { st = { installed: false }; }
  if (!st.installed || !st.upToDate) {
    show('setup');
    if (st.installed && !st.upToDate) {
      $('.setup-card .lede').textContent = 'This version of Stemlab needs a few updated audio tools. This takes a minute.';
      $('#setupBtn').textContent = 'Update';
    }
    if (st.nvidia) { $('#gpuRow').hidden = false; $('#gpuCheck').checked = st.installed ? st.gpuInstalled : true; }
    return;
  }
  await startEngine();
}

$('#setupBtn').addEventListener('click', async () => {
  const gpu = !$('#gpuRow').hidden && $('#gpuCheck').checked;
  $('#setupBtn').disabled = true;
  $('#gpuRow').hidden = true;
  $('#setupError').hidden = true;
  $('#setupProgress').hidden = false;
  try {
    await stemlab.runSetup({ gpu });
    await startEngine();
  } catch (e) {
    $('#setupError').textContent = "Setup didn't finish. Check your internet connection and try again.\n\n" + cleanErr(e);
    $('#setupError').hidden = false;
    $('#setupBtn').disabled = false;
    $('#setupBtn').textContent = 'Try again';
  }
});
stemlab.onSetupLog((line) => {
  const log = $('#setupLog');
  log.textContent += line + '\n';
  if (log.textContent.length > 60000) log.textContent = log.textContent.slice(-40000);
  log.scrollTop = log.scrollHeight;
});
stemlab.onSetupProgress(({ label, fraction }) => {
  $('#setupLabel').textContent = label;
  $('#setupBar').style.width = `${Math.round(fraction * 100)}%`;
});

function cleanErr(e) {
  return String(e && e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

async function startEngine() {
  show('booting');
  $('#bootMsg').textContent = 'Starting the audio engine…';
  try {
    state.engine = await stemlab.startEngine();
  } catch (e) {
    $('#bootMsg').innerHTML = '';
    const p = document.createElement('p');
    p.className = 'error';
    p.textContent = "The audio engine didn't start.\n\n" + cleanErr(e);
    const b = document.createElement('button');
    b.className = 'btn primary';
    b.textContent = 'Try again';
    b.onclick = startEngine;
    $('#bootMsg').append(p, b);
    return;
  }
  show('app');
  api('/synth-presets').then((r) => { SYNTH_PRESETS = r; }).catch(() => {});
  await refreshList();
  if (state.projects.length) openProject(state.projects[0].id);
  else showView('emptyView');
}

stemlab.onEngineDied(() => {
  player.stop();
  toast('The audio engine stopped. Restarting it…');
  state.engine = null;
  startEngine();
});

// ------------------------------------------------------------------ song list

async function refreshList() {
  state.projects = await api('/projects');
  renderList();
}

state.expanded = new Set();

function renderList() {
  const nav = $('#songList');
  nav.innerHTML = '';
  if (!state.projects.length) {
    const p = document.createElement('p');
    p.className = 'side-empty';
    p.textContent = 'Songs you add show up here.';
    nav.append(p);
    return;
  }
  for (const p of state.projects) {
    const isCur = !!(state.current && state.current.id === p.id);
    const open = state.expanded.has(p.id) && p.status === 'ready';
    const row = document.createElement('div');
    row.className = 'song-row';
    const caret = document.createElement('button');
    caret.className = 'caret';
    caret.setAttribute('aria-expanded', String(open));
    caret.setAttribute('aria-label', `${open ? 'Hide' : 'Show'} the parts of ${p.title || 'Untitled'}`);
    caret.innerHTML = '<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><path d="M3 1.5 7 5 3 8.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    caret.disabled = p.status !== 'ready';
    caret.onclick = (e) => {
      e.stopPropagation();
      if (state.expanded.has(p.id)) state.expanded.delete(p.id); else state.expanded.add(p.id);
      renderList();
    };
    const b = document.createElement('button');
    b.className = 'song-item';
    b.setAttribute('aria-current', String(isCur && !state.focus));
    b.title = 'Double-click to rename';
    const left = document.createElement('div');
    left.style.minWidth = '0';
    const t = document.createElement('div'); t.className = 't'; t.textContent = p.title || 'Untitled';
    left.append(t);
    if (p.artist) { const ar = document.createElement('div'); ar.className = 'a'; ar.textContent = p.artist; left.append(ar); }
    b.append(left);
    if (p.status !== 'ready') {
      const st = document.createElement('span');
      st.className = 'state' + (p.status === 'error' ? ' err' : '');
      const job = state.jobs[p.id];
      st.textContent = p.status === 'error' ? STATUS_TEXT.error
        : job ? `${Math.round(job.progress * 100)}%` : STATUS_TEXT[p.status] || '';
      b.append(st);
    }
    b.onclick = () => { state.expanded.add(p.id); openProject(p.id, null); };
    b.ondblclick = (e) => { e.preventDefault(); startRename(p, t); };
    b.onkeydown = (e) => { if (e.key === 'F2') { e.preventDefault(); startRename(p, t); } };
    row.append(caret, b);
    nav.append(row);
    if (open) {
      const list = document.createElement('div');
      list.className = 'part-list';
      const all = [...(p.stems || []), ...(p.synths || []).map((x) => x.id)];
      for (const part of all) {
        const pb = document.createElement('button');
        pb.className = 'part-item';
        pb.style.setProperty('--c', color(part));
        const syn = (p.synths || []).find((x) => x.id === part);
        pb.textContent = syn ? syn.name : (STEM_LABEL[part] || part);
        pb.setAttribute('aria-current', String(isCur && state.focus === part));
        pb.onclick = () => openPart(p.id, part);
        list.append(pb);
      }
      nav.append(list);
    }
  }
}

async function openPart(pid, part) {
  if (!state.current || state.current.id !== pid) await openProject(pid, part);
  else setFocus(part);
}

// show one part by itself (and hear it alone) until "Show all parts"
function setFocus(part) {
  state.focus = part;
  state.focusHearAll = false;
  if (typeof ne !== 'undefined' && ne) {
    if (ne.stem !== part) openNotes(part);
  }
  paintFocus();
  renderList();
}
function paintFocus() {
  const f = state.focus;
  for (const [s, l] of Object.entries(lanes)) l.el.hidden = !!f && s !== f;
  const bar = $('#focusBar');
  if (bar) {
    bar.hidden = !f;
    if (f) {
      $('#focusText').textContent = `Showing ${stemLabel(f)} only`;
      $('#focusHear').textContent = state.focusHearAll ? 'Hear only this part' : 'Hear the whole song';
    }
  }
  $('.add-row') && ($('.add-row').hidden = !!f);
  applyMix();
  requestAnimationFrame(drawWaveImages);
}

function startRename(p, el) {
  const input = document.createElement('input');
  input.className = 'rename';
  input.value = p.title || '';
  input.setAttribute('aria-label', 'Song name');
  el.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (save && v && v !== p.title) await renameSong(p.id, v);
    else renderList();
  };
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  };
  input.onblur = () => finish(true);
  input.onclick = (e) => e.stopPropagation();
  input.ondblclick = (e) => e.stopPropagation();
}

async function renameSong(pid, title) {
  try {
    await api('/projects/' + pid, { method: 'PATCH', body: { title } });
    const item = state.projects.find((x) => x.id === pid);
    if (item) item.title = title;
    if (state.current && state.current.id === pid) { state.current.title = title; paintHeader(); }
  } catch (e) { toast("Couldn't rename: " + e.message); }
  renderList();
}

// ------------------------------------------------------------------ import

function openImport() {
  player.stop();
  state.current = null;
  renderList();
  $('#importError').hidden = true;
  $('#urlInput').value = '';
  showView('importView');
  $('#urlInput').focus();
}
$('#newBtn').onclick = openImport;
document.addEventListener('click', (e) => { if (e.target.closest('[data-action=new]')) openImport(); });

async function startImport(body) {
  $('#importError').hidden = true;
  try {
    const r = await api('/projects', { method: 'POST', body });
    state.jobs[r.project.id] = r.job;
    await refreshList();
    openProject(r.project.id);
  } catch (e) {
    $('#importError').textContent = e.message;
    $('#importError').hidden = false;
  }
}

$('#pickFileBtn').onclick = async () => {
  const path = await stemlab.pickAudio();
  if (path) startImport({ type: 'file', path });
};
$('#urlForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const url = $('#urlInput').value.trim();
  if (!/^(https?:\/\/|spotify:)/i.test(url)) {
    $('#importError').textContent = 'Paste a full link that starts with https://';
    $('#importError').hidden = false;
    return;
  }
  startImport({ type: 'url', url });
});

const drop = $('#dropZone');
['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => {
  e.preventDefault();
  if (state.view === 'importView' || state.view === 'emptyView') drop.classList.add('over');
}));
['dragleave', 'dragend'].forEach((ev) => document.addEventListener(ev, (e) => {
  if (!e.relatedTarget) drop.classList.remove('over');
}));
document.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (!f || !['importView', 'emptyView'].includes(state.view)) return;
  const path = stemlab.pathForFile(f);
  if (path) startImport({ type: 'file', path });
});
drop.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#pickFileBtn').click(); });

// ------------------------------------------------------------------ job polling

async function pollJobs() {
  const ids = Object.keys(state.jobs);
  let changed = false;
  for (const pid of ids) {
    const job = state.jobs[pid];
    if (!job || job.status !== 'running') continue;
    try {
      const j = await api('/jobs/' + job.id);
      state.jobs[pid] = j;
      if (j.status !== 'running') changed = true;
      if (state.current && state.current.id === pid && state.view === 'workView') paintWork();
    } catch { delete state.jobs[pid]; changed = true; }
  }
  if (ids.length) {
    if (changed) {
      await refreshList();
      for (const pid of ids) {
        const j = state.jobs[pid];
        if (j && j.status !== 'running') {
          delete state.jobs[pid];
          if (state.current && state.current.id === pid) openProject(pid);
          else if (j.status === 'done') toast(`${(state.projects.find((p) => p.id === pid) || {}).title || 'A song'} is ready`, { label: 'Open', run: () => openProject(pid) });
        }
      }
    } else renderList();
  }
  setTimeout(pollJobs, 800);
}

// ------------------------------------------------------------------ open a song

async function openProject(pid, focus) {
  // same song: just change what's shown, don't reload anything
  if (state.current && state.current.id === pid && state.current.status === 'ready' && state.view === 'projectView') {
    if (focus) setFocus(focus);
    else { state.focus = null; paintFocus(); renderList(); }
    return;
  }
  const wasNotes = typeof ne !== 'undefined' && !!ne;
  player.stop();
  closeNotes(true);
  state.focus = focus || null;
  state.focusHearAll = false;
  let p;
  try { p = await api('/projects/' + pid); } catch (e) { toast(e.message); await refreshList(); return; }
  state.current = p;
  renderList();
  if (p.status !== 'ready') {
    showView('workView');
    paintWork();
    return;
  }
  showView('projectView');
  state.version = p.render ? 'render' : 'stems';
  buildEditor(p);
  buildLanes(p);
  await loadVersion();
  paintFocus();
  if (wasNotes || state.openNotesNext) {
    state.openNotesNext = false;
    const target = focus || (p.stems.includes('vocals') ? 'vocals' : p.stems[0]);
    openNotes(target);
  }
  extrasPoll();
}

function paintWork() {
  const p = state.current;
  if (!p) return;
  $('#workTitle').textContent = p.title || 'Untitled';
  $('#workArtist').textContent = p.artist || '';
  const job = state.jobs[p.id];
  const err = p.status === 'error' || (job && job.status === 'error');
  $('#workError').hidden = !err;
  $('#workHint').hidden = err;
  if (err) {
    $('#workErrorMsg').textContent = (job && job.error) || p.error || 'Something stopped this song from finishing.';
    $('#workStage').textContent = '';
    $('#workBar').style.width = '0%';
    return;
  }
  $('#workBar').style.width = `${Math.round((job ? job.progress : 0) * 100)}%`;
  $('#workStage').textContent = job ? job.stage : (STATUS_TEXT[p.status] || 'Working');
}

$('#retryBtn').onclick = async () => {
  const p = state.current;
  try {
    const r = await api(`/projects/${p.id}/retry`, { method: 'POST' });
    state.jobs[p.id] = r.job;
    p.status = 'splitting';
    paintWork();
    refreshList();
  } catch (e) {
    $('#workErrorMsg').textContent = e.message;
  }
};

async function removeCurrent() {
  const p = state.current;
  if (!p) return;
  if (!confirm(`Remove "${p.title}" and its parts from Stemlab? Files you exported stay where you saved them.`)) return;
  player.stop();
  await api('/projects/' + p.id, { method: 'DELETE' });
  delete state.mixer[p.id];
  state.current = null;
  await refreshList();
  if (state.projects.length) openProject(state.projects[0].id);
  else showView('emptyView');
}
$('#workDeleteBtn').onclick = removeCurrent;
$('#deleteBtn').onclick = removeCurrent;

// ------------------------------------------------------------------ audio engine (playback)

class Player {
  // Each part streams from the engine through its own <audio> element into Web Audio (for
  // per-part volume). Nothing is decoded up front, so a 10-minute song opens as fast as a
  // 2-minute one. Parts are kept in step by nudging their playback rate.
  constructor() {
    this.ctx = null;
    this.buffers = {};   // part -> {el, node, duration, peaks, rate}  (name kept for older callers)
    this.gains = {};
    this.playing = false;
    this.offset = 0;
    this.duration = 0;
    this.loopOn = false;
    this.loopA = 0;
    this.loopB = 0;
    this.loadToken = 0;
    this.startToken = 0;
    this.lastSync = 0;
  }
  ensure() {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'playback' });
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
    }
  }
  gainFor(n) {
    this.ensure();
    if (!this.gains[n]) { this.gains[n] = this.ctx.createGain(); this.gains[n].connect(this.master); }
    return this.gains[n];
  }
  makeTrack(n, url) {
    const el = new Audio();
    el.crossOrigin = 'anonymous';
    el.preload = 'auto';
    el.preservesPitch = true;
    el.src = url;
    const node = this.ctx.createMediaElementSource(el);
    node.connect(this.gainFor(n));
    const t = { el, node, duration: 0, peaks: null, rate: 100 };
    t.ready = new Promise((resolve, reject) => {
      el.addEventListener('loadedmetadata', () => { t.duration = el.duration || 0; resolve(); }, { once: true });
      el.addEventListener('error', () => reject(new Error(`Couldn't load the ${stemLabel(n)} part`)), { once: true });
    });
    return t;
  }
  dropTrack(n) {
    const t = this.buffers[n];
    if (!t) return;
    t.el.pause();
    t.el.removeAttribute('src');
    t.el.load();
    t.node.disconnect();
    delete this.buffers[n];
  }
  async load(urls, onProgress, peakUrls) {
    this.ensure();
    this.stop();
    Object.keys(this.buffers).forEach((n) => this.dropTrack(n));
    const token = ++this.loadToken;
    const names = Object.keys(urls);
    names.forEach((n) => { this.buffers[n] = this.makeTrack(n, urls[n]); });
    let done = 0;
    await Promise.all(names.map(async (n) => {
      const t = this.buffers[n];
      await t.ready;
      await this.loadPeaks(t, (peakUrls && peakUrls[n]) || urls[n].replace('/audio/', '/peaks/')).catch(() => {});
      onProgress && onProgress(++done / names.length);
    }));
    if (token !== this.loadToken) return false;
    this.duration = Math.max(0, ...names.map((n) => this.buffers[n].duration));
    this.offset = Math.min(this.offset, this.duration);
    this.loopA = 0; this.loopB = this.duration;
    return true;
  }
  async loadPeaks(t, url) {
    const r = await fetch(url);
    if (!r.ok) return;
    const j = await r.json();
    const bin = atob(j.data);
    const q = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) q[i] = bin.charCodeAt(i);
    const peaks = new Float32Array(q.length);
    for (let i = 0; i < q.length; i++) { const v = q[i] / 255; peaks[i] = v * v; }
    t.peaks = peaks; t.rate = j.rate;
  }
  master_() {
    let best = null;
    for (const t of Object.values(this.buffers)) if (!best || t.duration > best.duration) best = t;
    return best;
  }
  position() {
    if (!this.playing) return this.offset;
    const m = this.master_();
    return m ? m.el.currentTime : this.offset;
  }
  async play() {
    const tracks = Object.values(this.buffers);
    if (!tracks.length) return;
    this.ensure();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    if (this.offset >= this.duration - 0.05) this.offset = 0;
    if (this.loopOn && (this.offset < this.loopA || this.offset >= this.loopB)) this.offset = this.loopA;
    const token = ++this.startToken;
    this.playing = true;
    await Promise.all(tracks.map((t) => this.cue(t, this.offset)));
    if (token !== this.startToken || !this.playing) return;
    for (const t of tracks) {
      t.el.playbackRate = 1;
      if (this.offset < t.duration) t.el.play().catch(() => {});
    }
  }
  cue(t, time) {
    return new Promise((resolve) => {
      const el = t.el;
      const done = () => { el.removeEventListener('seeked', done); el.removeEventListener('canplay', done); resolve(); };
      if (Math.abs(el.currentTime - time) < 0.005 && el.readyState >= 3) { resolve(); return; }
      el.addEventListener('seeked', done, { once: true });
      el.currentTime = Math.min(time, Math.max(0, t.duration - 0.01));
      setTimeout(done, 1500);
    });
  }
  pause() {
    if (!this.playing) return;
    this.offset = Math.min(this.position(), this.duration);
    this.startToken++;
    Object.values(this.buffers).forEach((t) => t.el.pause());
    this.playing = false;
  }
  stop() {
    this.startToken++;
    Object.values(this.buffers).forEach((t) => t.el.pause());
    this.playing = false;
  }
  seek(t) {
    const was = this.playing;
    if (was) this.pause();
    this.offset = Math.max(0, Math.min(t, this.duration));
    if (was) this.play();
  }
  setLoop(on, a, b) {
    const was = this.playing;
    if (was) this.pause();
    this.loopOn = on;
    if (a !== undefined) { this.loopA = a; this.loopB = b; }
    if (was) this.play();
  }
  // called every frame: keep parts together, handle looping and the end of the song
  tick() {
    if (!this.playing) return;
    const m = this.master_();
    if (!m) return;
    const pos = m.el.currentTime;
    if (this.loopOn && pos >= this.loopB) { this.seek(this.loopA); return; }
    if (m.el.ended || pos >= this.duration - 0.01) { this.stop(); this.offset = 0; return; }
    const now = performance.now();
    if (now - this.lastSync < 200) return;
    this.lastSync = now;
    for (const t of Object.values(this.buffers)) {
      if (t === m || t.el.paused || pos >= t.duration) continue;
      const d = t.el.currentTime - pos;
      if (Math.abs(d) > 0.15) { t.el.currentTime = pos; t.el.playbackRate = 1; }
      else if (Math.abs(d) > 0.01) t.el.playbackRate = Math.max(0.97, Math.min(1.03, 1 - d * 1.5));
      else t.el.playbackRate = 1;
    }
  }
  async replace(n, url, peakUrl) {
    this.ensure();
    const was = this.playing;
    const pos = this.position();
    if (was) this.pause();
    this.dropTrack(n);
    const t = this.buffers[n] = this.makeTrack(n, url);
    await t.ready;
    await this.loadPeaks(t, peakUrl || url.replace('/audio/', '/peaks/')).catch(() => {});
    this.duration = Math.max(0, ...Object.values(this.buffers).map((x) => x.duration));
    this.offset = pos;
    if (was) this.play();
    return t;
  }
  setGain(n, v) {
    const g = this.gains[n];
    if (g) g.gain.setTargetAtTime(v, this.ctx.currentTime, 0.015);
  }
}
const player = new Player();

// ------------------------------------------------------------------ lanes

const lanes = {}; // stem -> {el, canvas, bright, dim, peaksFor}

function mixerFor(p) {
  if (!state.mixer[p.id]) state.mixer[p.id] = {};
  parts(p).forEach((s) => { if (!state.mixer[p.id][s]) state.mixer[p.id][s] = { vol: 1, mute: false, solo: false }; });
  return state.mixer[p.id];
}

function buildLanes(p) {
  const wrap = $('#lanes');
  wrap.innerHTML = '';
  Object.keys(lanes).forEach((k) => delete lanes[k]);
  const mix = mixerFor(p);
  for (const s of parts(p)) {
    const lane = document.createElement('div');
    lane.className = 'lane';
    lane.style.setProperty('--c', color(s));
    lane.innerHTML = `
      <div class="lane-head">
        <div class="cap"></div>
        <div class="lane-name"></div>
        <div class="ms">
          <button class="m" aria-pressed="false" title="Mute">M</button>
          <button class="s" aria-pressed="false" title="Solo: hear only this part">S</button>
          <button class="n" title="See and edit the notes in this part">Notes</button>
        </div>
        <div class="vol"><input type="range" min="0" max="1.4" step="0.01" aria-label="Volume"></div>
      </div>
      <canvas class="wave"></canvas>`;
    $('.lane-name', lane).textContent = stemLabel(s);
    const m = $('.m', lane), so = $('.s', lane), vol = $('.vol input', lane);
    $('.vol input', lane).setAttribute('aria-label', `${stemLabel(s)} volume`);
    m.setAttribute('aria-label', `Mute ${stemLabel(s)}`);
    so.setAttribute('aria-label', `Solo ${stemLabel(s)}`);
    vol.value = mix[s].vol;
    m.onclick = () => { mix[s].mute = !mix[s].mute; applyMix(); };
    so.onclick = (e) => {
      const only = !e.ctrlKey && !e.metaKey && !e.shiftKey;
      const next = !mix[s].solo;
      if (only) parts(p).forEach((x) => { mix[x].solo = false; });
      mix[s].solo = next;
      applyMix();
    };
    vol.oninput = () => { mix[s].vol = +vol.value; applyMix(); };
    vol.ondblclick = () => { vol.value = 1; mix[s].vol = 1; applyMix(); };
    const nb = $('.n', lane);
    if (s === 'drums') nb.remove();
    else nb.onclick = () => openNotes(s);
    if (isSynth(s)) {
      lane.classList.add('synth-lane');
      const sub = document.createElement('div');
      sub.className = 'lane-sub';
      sub.textContent = presetLabel(p.synths[s].preset) + (p.synths[s].notes.length ? '' : ', no notes yet');
      $('.lane-name', lane).append(sub);
      const del = document.createElement('button');
      del.className = 'x';
      del.title = `Remove ${stemLabel(s)}`;
      del.setAttribute('aria-label', `Remove ${stemLabel(s)}`);
      del.textContent = '×';
      del.onclick = () => removeSynth(s);
      $('.ms', lane).append(del);
    }
    const canvas = $('canvas', lane);
    attachSeek(canvas);
    wrap.append(lane);
    lanes[s] = { el: lane, canvas, m, so };
  }
  const add = document.createElement('div');
  add.className = 'add-row';
  add.innerHTML = '<button class="btn small" id="addSynthBtn">Add a synth part</button><span class="muted small">Play your own notes with a synth sound, or copy a melody from another part.</span>';
  wrap.append(add);
  $('#addSynthBtn').onclick = addSynth;
  applyMix();
}

function applyMix() {
  const p = state.current;
  if (!p) return;
  const mix = mixerFor(p);
  const anySolo = parts(p).some((s) => mix[s].solo);
  for (const s of parts(p)) {
    let on = anySolo ? mix[s].solo : !mix[s].mute;
    if (state.focus && !state.focusHearAll) on = s === state.focus;
    if (state.noteSolo) on = s === state.noteSolo;
    player.setGain(s, on ? mix[s].vol : 0);
    const l = lanes[s];
    if (!l) continue;
    l.m.setAttribute('aria-pressed', String(mix[s].mute));
    l.so.setAttribute('aria-pressed', String(mix[s].solo));
    l.el.classList.toggle('off', !on);
  }
  $('#unsoloBtn').hidden = !anySolo;
}
$('#unsoloBtn').onclick = () => {
  const mix = mixerFor(state.current);
  Object.values(mix).forEach((m) => { m.solo = false; });
  applyMix();
};

function attachSeek(canvas) {
  const toTime = (e) => {
    const r = canvas.getBoundingClientRect();
    return ((e.clientX - r.left) / r.width) * player.duration;
  };
  canvas.addEventListener('pointerdown', (e) => {
    if (!player.duration) return;
    canvas.setPointerCapture(e.pointerId);
    player.seek(toTime(e));
    const move = (ev) => player.seek(toTime(ev));
    const up = () => { canvas.removeEventListener('pointermove', move); canvas.removeEventListener('pointerup', up); };
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
  });
}

function drawWaveImages() {
  const dpr = window.devicePixelRatio || 1;
  const info = {};
  let loudest = 1e-6;
  for (const [s, l] of Object.entries(lanes)) {
    const t = player.buffers[s];
    const w = Math.max(1, Math.floor(l.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(l.canvas.clientHeight * dpr));
    l.canvas.width = w; l.canvas.height = h;
    if (!t || !t.peaks || !player.duration) { l.dim = l.bright = null; continue; }
    const cols = Math.max(1, Math.floor(w * (t.duration / player.duration)));
    const per = t.peaks.length / cols;
    const peaks = new Float32Array(cols);
    let top = 0;
    for (let x = 0; x < cols; x++) {
      let mx = 0;
      for (let i = Math.floor(x * per), e = Math.max(i + 1, Math.floor((x + 1) * per)); i < e && i < t.peaks.length; i++) {
        if (t.peaks[i] > mx) mx = t.peaks[i];
      }
      peaks[x] = mx;
      if (mx > top) top = mx;
    }
    info[s] = { peaks, top, w, h, cols };
    loudest = Math.max(loudest, top);
  }
  for (const [s, it] of Object.entries(info)) {
    const l = lanes[s];
    l.el.classList.toggle('empty-part', it.top < 0.05 * loudest);
    const c = color(s);
    const mk = (alpha) => {
      const cv = document.createElement('canvas');
      cv.width = it.w; cv.height = it.h;
      const g = cv.getContext('2d');
      g.fillStyle = c;
      g.globalAlpha = alpha;
      const mid = it.h / 2;
      const step = Math.max(1, Math.round(2 * dpr));
      for (let x = 0; x < it.cols; x += step) {
        let mx = 0;
        for (let k = 0; k < step && x + k < it.cols; k++) mx = Math.max(mx, it.peaks[x + k]);
        const hh = Math.max(dpr * 0.5, Math.pow(mx / loudest, 0.75) * (it.h * 0.42));
        g.fillRect(x, mid - hh, Math.max(1, step - dpr), hh * 2);
      }
      return cv;
    };
    l.dim = mk(0.32);
    l.bright = mk(0.95);
  }
  drawRuler();
}

function currentBeats() {
  const p = state.current;
  if (!p) return [];
  if (state.version === 'render') return (p.render && p.render.beats) || [];
  return (p.analysis && p.analysis.beats) || [];
}

function drawRuler() {
  const cv = $('#ruler');
  const dpr = window.devicePixelRatio || 1;
  const w = Math.floor(cv.clientWidth * dpr), h = Math.floor(cv.clientHeight * dpr);
  cv.width = w; cv.height = h;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, w, h);
  if (!player.duration) return;
  const px = (t) => (t / player.duration) * w;
  if (player.loopOn) {
    g.fillStyle = 'rgba(241,234,217,0.14)';
    g.fillRect(px(player.loopA), 0, px(player.loopB) - px(player.loopA), h);
  }
  const beats = currentBeats();
  g.fillStyle = '#a39b8f';
  g.font = `${11 * dpr}px Archivo`;
  g.textBaseline = 'middle';
  if (beats.length > 4) {
    const minGap = 3 * dpr;
    let last = -1e9;
    beats.forEach((b, i) => {
      const x = px(b);
      const bar = i % 4 === 0;
      if (!bar && x - last < minGap) return;
      g.globalAlpha = bar ? 0.9 : 0.35;
      g.fillRect(x, bar ? h * 0.45 : h * 0.7, dpr, h);
      last = x;
    });
    // bar numbers where they fit
    g.globalAlpha = 0.9;
    let lastLabel = -1e9;
    for (let i = 0; i < beats.length; i += 4) {
      const x = px(beats[i]);
      if (x - lastLabel > 40 * dpr) { g.fillText(String(i / 4 + 1), x + 4 * dpr, h * 0.35); lastLabel = x; }
    }
  } else {
    const stepS = player.duration > 240 ? 30 : 15;
    for (let t = 0; t < player.duration; t += stepS) {
      g.globalAlpha = 0.5; g.fillRect(px(t), h * 0.6, dpr, h);
      g.globalAlpha = 0.9; g.fillText(fmtTime(t), px(t) + 4 * dpr, h * 0.35);
    }
  }
  g.globalAlpha = 1;
}

// loop region: drag across the ruler
(function rulerDrag() {
  const cv = $('#ruler');
  cv.addEventListener('pointerdown', (e) => {
    if (!player.duration) return;
    const r = cv.getBoundingClientRect();
    const t0 = ((e.clientX - r.left) / r.width) * player.duration;
    let dragged = false;
    cv.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const t1 = Math.max(0, Math.min(player.duration, ((ev.clientX - r.left) / r.width) * player.duration));
      if (Math.abs(t1 - t0) < 0.2) return;
      dragged = true;
      player.loopA = Math.min(t0, t1); player.loopB = Math.max(t0, t1);
      player.loopOn = true;
      $('#loopCheck').checked = true;
      drawRuler();
    };
    const up = () => {
      cv.removeEventListener('pointermove', move); cv.removeEventListener('pointerup', up);
      if (dragged) { player.setLoop(true, player.loopA, player.loopB); player.seek(player.loopA); }
      else player.seek(t0);
    };
    cv.addEventListener('pointermove', move);
    cv.addEventListener('pointerup', up);
  });
  cv.title = 'Click to jump. Drag to pick a section to loop.';
})();

$('#loopCheck').addEventListener('change', (e) => {
  if (e.target.checked && player.loopB - player.loopA < 0.2) { player.loopA = 0; player.loopB = player.duration; }
  if (!e.target.checked) { player.loopA = 0; player.loopB = player.duration; }
  player.setLoop(e.target.checked);
  drawRuler();
});

function frame() {
  player.tick();
  if (state.view === 'projectView' && player.duration) {
    let pos = player.position();
    if (player.playing && !player.loopOn && pos >= player.duration) {
      player.stop(); player.offset = 0; pos = 0; syncPlayBtn();
    }
    $('#posTime').textContent = fmtTime(pos);
    if (typeof drawRoll === 'function' && ne) drawRoll(pos);
    const dpr = window.devicePixelRatio || 1;
    for (const l of Object.values(lanes)) {
      const g = l.canvas.getContext('2d');
      const w = l.canvas.width, h = l.canvas.height;
      g.clearRect(0, 0, w, h);
      if (!l.dim) continue;
      const x = (pos / player.duration) * w;
      if (player.loopOn) {
        g.fillStyle = 'rgba(241,234,217,0.05)';
        g.fillRect((player.loopA / player.duration) * w, 0, ((player.loopB - player.loopA) / player.duration) * w, h);
      }
      g.drawImage(l.dim, 0, 0);
      if (x > 0) g.drawImage(l.bright, 0, 0, x, h, 0, 0, x, h);
      g.fillStyle = '#f1ead9';
      g.fillRect(x, 0, dpr, h);
    }
  }
  requestAnimationFrame(frame);
}

function syncPlayBtn() {
  $('#playIcon').hidden = player.playing;
  $('#pauseIcon').hidden = !player.playing;
  $('#playBtn').setAttribute('aria-label', player.playing ? 'Pause' : 'Play');
}
$('#playBtn').onclick = () => { player.playing ? player.pause() : player.play(); syncPlayBtn(); };
function typingIn(el) {
  if (!el || !el.closest) return false;
  if (el.closest('dialog, textarea, select')) return true;
  const inp = el.closest('input');
  return !!inp && !['range', 'checkbox', 'radio', 'button'].includes(inp.type);
}
document.addEventListener('keydown', (e) => {
  if (state.view !== 'projectView' || typingIn(e.target) || e.altKey) return;
  if (e.code === 'Space') {
    e.preventDefault();
    if (!e.repeat) $('#playBtn').click();
  } else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
    e.preventDefault();
    if (!player.duration) return;
    const step = e.code === 'ArrowLeft' ? -5 : 5;
    player.seek(Math.max(0, Math.min(player.duration - 0.05, player.position() + step)));
    if (typeof followPlayhead === 'function') followPlayhead(true);
  } else if (e.code === 'Home') {
    e.preventDefault();
    player.seek(player.loopOn ? player.loopA : 0);
  } else if (typeof noteKey === 'function') {
    noteKey(e);
  }
});
// stop Space from also "clicking" whatever button has focus
document.addEventListener('keyup', (e) => {
  if (e.code === 'Space' && state.view === 'projectView' && !typingIn(e.target)) e.preventDefault();
});
window.addEventListener('resize', () => { clearTimeout(window._rz); window._rz = setTimeout(drawWaveImages, 120); });

async function loadVersion() {
  const p = state.current;
  $$('#versionSeg button').forEach((b) => {
    b.setAttribute('aria-selected', String(b.dataset.version === state.version));
    if (b.dataset.version === 'render') b.disabled = !p.render;
  });
  $('#versionSeg [data-version=render]').title = p.render ? '' : 'Apply changes to make an edited version';
  const wasPlaying = player.playing;
  const keepPos = player.position();
  $('#loadingMsg').hidden = false;
  $('#playBtn').disabled = true;
  const urls = {};
  parts(p).forEach((s) => { urls[s] = stemUrl(p, s); });
  try {
    const ok = await player.load(urls, (f) => { $('#loadingMsg').textContent = `Loading audio… ${Math.round(f * 100)}%`; });
    if (!ok) return;
  } catch (e) {
    toast(e.message);
    return;
  } finally {
    $('#loadingMsg').hidden = true;
    $('#loadingMsg').textContent = 'Loading audio…';
    $('#playBtn').disabled = false;
  }
  $('#loopCheck').checked = false;
  player.loopOn = false;
  // keep roughly the same spot in the song when switching versions
  const other = state.version === 'render' ? p.analysis.duration : (p.render && p.render.duration) || player.duration;
  player.offset = Math.min(player.duration, keepPos * (player.duration / (other || player.duration)));
  $('#durTime').textContent = fmtTime(player.duration);
  applyMix();
  paintHeader();
  markNoteLanes();
  drawWaveImages();
  if (wasPlaying) player.play();
  syncPlayBtn();
}

$$('#versionSeg button').forEach((b) => b.addEventListener('click', () => {
  if (b.disabled || state.version === b.dataset.version) return;
  closeNotes();
  state.version = b.dataset.version;
  loadVersion();
}));

$('#songTitle').title = 'Click to rename';
$('#songTitle').addEventListener('click', () => {
  const p = state.current;
  if (p && !$('#songTitle input')) startHeaderRename(p);
});
function startHeaderRename(p) {
  const h = $('#songTitle');
  const input = document.createElement('input');
  input.className = 'rename big';
  input.value = p.title || '';
  input.setAttribute('aria-label', 'Song name');
  h.textContent = '';
  h.append(input);
  input.focus(); input.select();
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (save && v && v !== p.title) await renameSong(p.id, v); else paintHeader();
  };
  input.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); };
  input.onblur = () => finish(true);
}

function paintHeader() {
  const p = state.current;
  const a = p.analysis || {};
  $('#songTitle').textContent = p.title || 'Untitled';
  const bits = [];
  if (p.artist) bits.push(p.artist);
  if (state.version === 'render' && p.render) {
    if (p.render.bpm) bits.push(`${p.render.bpm} BPM`);
    if (p.render.key) bits.push(p.render.key);
  } else {
    if (a.bpm) bits.push(`${a.bpm} BPM`);
    if (a.key) bits.push(a.key.name);
  }
  const meta = $('#songMeta');
  meta.innerHTML = '';
  bits.forEach((b) => { const s = document.createElement('span'); s.textContent = b; meta.append(s); });
}

// ------------------------------------------------------------------ editor controls

const DEFAULTS = { transpose: 0, fix_tuning: false, keep_drums: true, target_bpm: null, steady: 0, grid: 4, tighten: {} };
let edit = null;

function buildEditor(p) {
  const saved = p.render && p.render.settings;
  edit = saved ? {
    transpose: saved.transpose || 0,
    fix_tuning: !!saved.fix_tuning,
    keep_drums: (saved.pitch_skip || []).includes('drums'),
    target_bpm: saved.target_bpm || null,
    steady: Math.round((saved.steady || 0) * 100),
    grid: saved.grid || 4,
    tighten: Object.fromEntries(Object.entries(saved.tighten || {}).map(([k, v]) => [k, Math.round(v * 100)])),
  } : JSON.parse(JSON.stringify(DEFAULTS));

  const a = p.analysis || {};
  const hasBeat = !!(a.beats && a.beats.length >= 8);
  $('#tempoGroup').classList.toggle('disabled', !hasBeat);
  $('#tightGroup').classList.toggle('disabled', !hasBeat);
  $('#noBeat').hidden = hasBeat;
  $('#tempoLine').textContent = hasBeat
    ? `Detected ${a.bpm} BPM. ${a.wobble < 1 ? 'The beat is already steady.' : `It drifts by about ${a.wobble} BPM.`}`
    : '';
  const cents = a.tuning_cents || 0;
  $('#tuneCheck').disabled = Math.abs(cents) < 3;
  $('#tuneLabel').textContent = Math.abs(cents) < 3
    ? 'Tuning is already at A440'
    : `Tune to A440 (song is ${cents > 0 ? '+' : ''}${cents} cents off)`;

  const rows = $('#tightRows');
  rows.innerHTML = '';
  for (const s of p.stems) {
    const r = document.createElement('div');
    r.className = 'tight-row';
    r.style.setProperty('--c', color(s));
    r.innerHTML = '<span></span><input type="range" min="0" max="100" step="5"><output></output>';
    r.firstChild.textContent = STEM_SHORT[s] || stemLabel(s);
    const inp = $('input', r);
    inp.setAttribute('aria-label', `Tighten ${stemLabel(s)}`);
    inp.value = edit.tighten[s] || 0;
    inp.oninput = () => { edit.tighten[s] = +inp.value; paintEditor(); };
    rows.append(r);
  }
  paintEditor();
}

function paintEditor() {
  const p = state.current;
  const a = p.analysis || {};
  $('#transposeOut').textContent = edit.transpose > 0 ? `+${edit.transpose}` : String(edit.transpose);
  if (a.key) {
    const k = a.key;
    const to = `${NOTE[((k.tonic + edit.transpose) % 12 + 12) % 12]} ${k.mode}`;
    $('#keyLine').textContent = edit.transpose ? `${k.name}  to  ${to}` : `In ${k.name}`;
  } else $('#keyLine').textContent = '';
  $('#tuneCheck').checked = edit.fix_tuning;
  $('#drumPitchCheck').checked = edit.keep_drums;
  $('#bpmInput').value = edit.target_bpm || a.bpm || '';
  $('#steadySlider').value = edit.steady;
  $('#steadyOut').textContent = `${edit.steady}%`;
  $('#gridSelect').value = String(edit.grid);
  $$('.tight-row').forEach((r) => { $('output', r).textContent = `${$('input', r).value}%`; });
  const applied = canon(p.render && p.render.settings ? p.render.settings : settingsPayload(DEFAULTS));
  const dirty = canon(settingsPayload(edit)) !== applied;
  $('#renderNote').textContent = dirty ? 'You have changes that aren\'t applied yet.' : (p.render ? 'The Edited version is up to date.' : 'Change anything, then apply to hear it.');
  $('#applyBtn').disabled = !dirty || !!state.renderJob;
}

function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${k}:${canon(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

function settingsPayload(e) {
  const a = (state.current && state.current.analysis) || {};
  const bpm = e.target_bpm && Math.abs(e.target_bpm - (a.bpm || 0)) > 0.05 ? e.target_bpm : null;
  const tighten = {};
  Object.entries(e.tighten || {}).forEach(([k, v]) => { if (v > 0) tighten[k] = v / 100; });
  return {
    transpose: e.transpose,
    fix_tuning: !!e.fix_tuning,
    pitch_skip: e.keep_drums ? ['drums'] : [],
    target_bpm: bpm,
    steady: (e.steady || 0) / 100,
    grid: +e.grid,
    tighten,
  };
}

$$('.stepper .step').forEach((b) => b.addEventListener('click', () => {
  edit.transpose = Math.max(-12, Math.min(12, edit.transpose + +b.dataset.step));
  paintEditor();
}));
$('#tuneCheck').onchange = (e) => { edit.fix_tuning = e.target.checked; paintEditor(); };
$('#drumPitchCheck').onchange = (e) => { edit.keep_drums = e.target.checked; paintEditor(); };
$('#bpmInput').onchange = (e) => {
  const v = parseFloat(e.target.value);
  edit.target_bpm = isFinite(v) ? Math.max(30, Math.min(300, v)) : null;
  paintEditor();
};
$('#bpmReset').onclick = () => { edit.target_bpm = null; paintEditor(); };
$('#steadySlider').oninput = (e) => { edit.steady = +e.target.value; paintEditor(); };
$('#gridSelect').onchange = (e) => { edit.grid = +e.target.value; paintEditor(); };
$('#resetBtn').onclick = () => {
  edit = JSON.parse(JSON.stringify(DEFAULTS));
  $$('.tight-row input').forEach((i) => { i.value = 0; });
  paintEditor();
};

$('#applyBtn').onclick = async () => {
  const p = state.current;
  const settings = settingsPayload(edit);
  const bpmRatio = settings.target_bpm && p.analysis.bpm ? settings.target_bpm / p.analysis.bpm : 1;
  if (bpmRatio < 0.5 || bpmRatio > 2) {
    toast('Pick a tempo between half and double the original.');
    return;
  }
  try {
    const r = await api(`/projects/${p.id}/render`, { method: 'POST', body: settings });
    state.renderJob = { pid: p.id, job: r.job };
    $('#renderProgress').hidden = false;
    $('#applyBtn').disabled = true;
    pollRender();
  } catch (e) { toast(e.message); }
};

async function pollRender() {
  const rj = state.renderJob;
  if (!rj) return;
  let j;
  try { j = await api('/jobs/' + rj.job.id); } catch (e) { j = { status: 'error', error: e.message }; }
  const here = state.current && state.current.id === rj.pid;
  if (here) {
    $('#renderBar').style.width = `${Math.round(j.progress * 100)}%`;
    $('#renderStage').textContent = j.stage || '';
  }
  if (j.status === 'running') { setTimeout(pollRender, 600); return; }
  state.renderJob = null;
  $('#renderProgress').hidden = true;
  $('#renderBar').style.width = '0%';
  if (j.status === 'error') { toast("Couldn't apply changes: " + j.error); if (here) paintEditor(); return; }
  if (here) {
    state.current = await api('/projects/' + rj.pid);
    state.version = 'render';
    paintEditor();
    await loadVersion();
    const cleared = (j.result && j.result.notes_cleared) || [];
    toast(cleared.length
      ? `Changes applied. Note edits on ${cleared.map(stemLabel).join(', ')} were cleared because the Edited version changed.`
      : 'Changes applied. You\'re hearing the Edited version.');
  }
}

$('#focusAll').onclick = () => { state.focus = null; paintFocus(); renderList(); };
$('#focusHear').onclick = () => { state.focusHearAll = !state.focusHearAll; paintFocus(); };

// ------------------------------------------------------------------ synth parts

let SYNTH_PRESETS = {};
function presetLabel(k) { return (SYNTH_PRESETS[k] || {}).label || k; }

async function addSynth() {
  const p = state.current;
  try {
    if (!Object.keys(SYNTH_PRESETS).length) SYNTH_PRESETS = await api('/synth-presets');
    const sy = await api(`/projects/${p.id}/synths`, { method: 'POST', body: { preset: 'lead' } });
    p.synths = p.synths || {};
    p.synths[sy.id] = sy;
    mixerFor(p);
    buildLanes(p);
    if (!player.gains[sy.id]) { player.gains[sy.id] = player.ctx.createGain(); player.gains[sy.id].connect(player.master); }
    await player.replace(sy.id, stemUrl(p, sy.id));
    applyMix();
    markNoteLanes();
    drawWaveImages();
    openNotes(sy.id);
  } catch (e) { toast("Couldn't add a synth: " + e.message); }
}

async function removeSynth(sid) {
  const p = state.current;
  const sy = p.synths[sid];
  if (sy.notes.length && !confirm(`Remove ${sy.name} and its ${sy.notes.length} notes?`)) return;
  if (ne && ne.stem === sid) closeNotes(true);
  await api(`/projects/${p.id}/synths/${sid}`, { method: 'DELETE' });
  delete p.synths[sid];
  player.dropTrack(sid);
  if (player.playing) { player.pause(); player.play(); }
  buildLanes(p);
  markNoteLanes();
  drawWaveImages();
}

// ------------------------------------------------------------------ mix / notes mode

function syncModeSeg() {
  const notes = !!ne;
  $$('#modeSeg button').forEach((b) => b.setAttribute('aria-selected', String((b.dataset.mode === 'notes') === notes)));
}
$$('#modeSeg button').forEach((b) => b.addEventListener('click', () => {
  if (b.dataset.mode === 'mix') { closeNotes(); return; }
  if (ne) return;
  const p = state.current;
  const withNotes = parts(p).find((s) => isSynth(s) || (p.note_edits && p.note_edits[s] && p.note_edits[s].base === state.version));
  openNotes(state.lastNoteStem && parts(p).includes(state.lastNoteStem) ? state.lastNoteStem
    : withNotes || (p.stems.includes('vocals') ? 'vocals' : p.stems.find((s) => s !== 'drums')));
}));

// ------------------------------------------------------------------ export

$('#exportBtn').onclick = () => {
  const p = state.current;
  const dlg = $('#exportDialog');
  $('#exportError').hidden = true;
  const vr = $$('input[name=version]', dlg);
  vr.forEach((r) => {
    r.disabled = r.value === 'render' && !p.render;
    r.checked = r.value === (p.render ? state.version : 'stems');
  });
  const mix = mixerFor(p);
  const anySolo = parts(p).some((s) => mix[s].solo);
  const box = $('#exportParts');
  box.innerHTML = '';
  parts(p).forEach((s) => {
    const l = document.createElement('label');
    l.className = 'check small';
    l.innerHTML = '<input type="checkbox"><span></span>';
    $('span', l).textContent = STEM_SHORT[s] || stemLabel(s);
    $('input', l).value = s;
    const quiet = lanes[s] && lanes[s].el.classList.contains('empty-part');
    $('input', l).checked = anySolo ? mix[s].solo : (!mix[s].mute && !quiet);
    box.append(l);
  });
  dlg.showModal();
};

$('#exportDialog').addEventListener('close', async () => {
  const dlg = $('#exportDialog');
  if (dlg.returnValue !== 'go') return;
  const p = state.current;
  const stems = $$('#exportParts input:checked').map((i) => i.value);
  if (!stems.length) { toast('Pick at least one part to export.'); return; }
  const dest = await stemlab.pickFolder();
  if (!dest) return;
  const mix = mixerFor(p);
  const body = {
    version: ($('input[name=version]:checked', dlg) || {}).value || 'stems',
    mode: ($('input[name=mode]:checked', dlg) || {}).value || 'separate',
    format: $('#formatSelect').value,
    stems,
    volumes: Object.fromEntries(stems.map((s) => [s, mix[s].vol])),
    dest_dir: dest,
  };
  try {
    const r = await api(`/projects/${p.id}/export`, { method: 'POST', body });
    toast('Exporting…');
    let j;
    do {
      await new Promise((res) => setTimeout(res, 500));
      j = await api('/jobs/' + r.job.id);
    } while (j.status === 'running');
    if (j.status === 'error') throw new Error(j.error);
    const n = j.result.files.length;
    toast(`Exported ${n} file${n > 1 ? 's' : ''}`, { label: 'Show in folder', run: () => stemlab.showItem(j.result.files[0]) });
  } catch (e) {
    toast("Export didn't finish: " + e.message);
  }
});

// ------------------------------------------------------------------ go

requestAnimationFrame(frame);
pollJobs();
boot();

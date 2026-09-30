'use strict';
/* Chords & lyrics: a chord sheet for the selected part, with the chords placed over the words
   they change on. Everything can be fixed by hand: lyric lines, chord names, chord positions.
   Shares globals with app.js / notes.js. */

const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
let sheetUserScroll = 0;
let sheetDrag = null;

$$('#viewSeg button').forEach((b) => b.addEventListener('click', () => {
  state.noteMode = b.dataset.view;
  if (!ne) return;
  $$('#viewSeg button').forEach((x) => x.setAttribute('aria-selected', String(x.dataset.view === state.noteMode)));
  openNotes(ne.stem);
}));

// ------------------------------------------------------------------ time & key of the version being played

function timeMap() {
  const p = state.current;
  return state.version === 'render' && p.render && p.render.time_map ? p.render.time_map : null;
}
function interp(x, xs, ys) {
  if (!xs || xs.length < 2) return x;
  if (x <= xs[0]) return ys[0] + (x - xs[0]);
  if (x >= xs[xs.length - 1]) return ys[ys.length - 1] + (x - xs[xs.length - 1]);
  let lo = 0, hi = xs.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] <= x) lo = m; else hi = m; }
  return ys[lo] + (ys[hi] - ys[lo]) * (x - xs[lo]) / (xs[hi] - xs[lo]);
}
const toView = (t) => { const m = timeMap(); return m ? interp(t, m.src, m.dst) : t; };
const toSource = (t) => { const m = timeMap(); return m ? interp(t, m.dst, m.src) : t; };
function shiftSemis() {
  const p = state.current;
  return state.version === 'render' && p.render && p.render.settings ? Math.round(p.render.settings.transpose || 0) : 0;
}
function useFlats() {
  const p = state.current;
  const key = state.version === 'render' && p.render ? p.render.key : (p.analysis && p.analysis.key && p.analysis.key.name);
  if (!key) return false;
  const [root, mode] = key.split(' ');
  return (mode === 'major' ? ['F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb'] : ['D', 'G', 'C', 'F', 'Bb', 'Eb']).includes(root);
}
function transposeChord(ch, semis) {
  if (!ch || ch === 'N' || !semis) return ch;
  const m = ch.match(/^([A-G])([#b]?)(.*)$/);
  if (!m) return ch;
  const root = m[1] + m[2];
  const idx = (SHARP_NAMES.includes(root) ? SHARP_NAMES : FLAT_NAMES).indexOf(root);
  if (idx < 0) return ch;
  let rest = m[3];
  const slash = rest.match(/^(.*)\/([A-G][#b]?)$/);
  if (slash) rest = slash[1] + '/' + transposeChord(slash[2], semis);
  return (useFlats() ? FLAT_NAMES : SHARP_NAMES)[(idx + semis + 120) % 12] + rest;
}
const display = (ch) => transposeChord(ch, shiftSemis());
const stored = (ch) => transposeChord(ch, -shiftSemis());

// ------------------------------------------------------------------ data for the selected part

function sheet() { return state.current.sheet || {}; }
function chordKey() {
  const src = (sheet().chord_source || {})[ne.stem];
  return src === 'own' && (sheet().chords || {})[ne.stem] ? ne.stem : 'song';
}
function chordList() { return ((sheet().chords || {})[chordKey()] || []).map((c) => ({ ...c })); }

async function saveChords(list) {
  const p = state.current;
  try {
    p.sheet = await api(`/projects/${p.id}/sheet`, { method: 'PUT', body: { part: chordKey(), chords: list } });
  } catch (e) { toast("Couldn't save the chords: " + e.message); }
  renderSheet();
}

// ------------------------------------------------------------------ showing the sheet

function showSheet() {
  $('#rollWrap').hidden = true;
  $('#noteDetect').hidden = true;
  $('#noteHelp').hidden = true;
  $('#sheetView').hidden = false;
  $$('.note-bar #undoBtn, .note-bar #resetNotesBtn, .note-bar #redetectBtn, .note-bar .zoom, .note-bar .inline')
    .forEach((el) => { el.hidden = true; });
  $('#synthTools').hidden = true;
  $('#noteStatus').textContent = '';
  // make sure chords and lyrics are being worked on
  const ex = state.extras || {};
  const st = ex.status || {};
  if (!sheet().chords && st.chords !== 'running') {
    api(`/projects/${state.current.id}/extras`, { method: 'POST', body: { first: 'chords' } }).then((r) => { state.extras = r; paintSheetStatus(); }).catch(() => {});
  }
  renderSheet();
  paintSheetStatus();
  extrasPoll();
}

function paintSheetStatus(changed) {
  if (!ne || $('#sheetView').hidden) return;
  const ex = state.extras || {};
  const st = ex.status || {};
  const now = ex.now || {};
  const bits = [];
  const errs = [];
  if (!sheet().chords) {
    if (now.task === 'chords') bits.push(`Finding the chords… ${Math.round((now.progress || 0) * 100)}%`);
    else if (String(st.chords || '').startsWith('error')) errs.push(['chords', `Couldn't find the chords. ${String(st.chords).replace(/^error:\s*/, '')}`]);
    else bits.push('Chords are next once the notes are found.');
  }
  const lyr = sheet().lyrics;
  if (!lyr && state.current.stems.includes('vocals')) {
    if (now.task === 'lyrics') bits.push(`Writing out the lyrics… ${Math.round((now.progress || 0) * 100)}%`);
    else if (String(st.lyrics || '').startsWith('error')) errs.push(['lyrics', `Couldn't write out the lyrics. ${String(st.lyrics).replace(/^error:\s*/, '')}`]);
    else bits.push('Lyrics will appear after the chords.');
  }
  const el = $('#sheetStatus');
  el.innerHTML = '';
  el.hidden = !bits.length && !errs.length;
  if (bits.length) { const s = document.createElement('span'); s.textContent = bits.join('  '); el.append(s); }
  for (const [task, msg] of errs) {
    const s = document.createElement('span'); s.className = 'error'; s.textContent = ' ' + msg + ' ';
    const b = document.createElement('button'); b.className = 'btn ghost small'; b.textContent = 'Try again';
    b.onclick = async () => { state.extras = await api(`/projects/${state.current.id}/extras`, { method: 'POST', body: { retry: task } }); paintSheetStatus(); extrasPoll(); };
    el.append(s, b);
  }
  if (changed) renderSheet();
}

function renderSheet() {
  if (!ne || $('#sheetView').hidden) return;
  const p = state.current;
  const body = $('#sheetBody');
  const keep = body.scrollTop;
  body.innerHTML = '';
  closeChordPop();
  const sh = sheet();
  const key = chordKey();
  const sharers = p.stems.filter((s) => s !== ne.stem && ((sh.chord_source || {})[s] || 'song') === 'song' && s !== 'drums');
  const verNote = state.version === 'render' && timeMap() ? ' Shown in the Edited version\'s key and tempo.' : '';
  $('#sheetSource').textContent = (key === 'song'
    ? `Song chords${sharers.length ? `, shared with ${sharers.map(stemLabel).join(', ')}` : ''}. Changes here apply to every part that shares them.`
    : `${stemLabel(ne.stem)} has its own chords.`) + verNote;
  $('#sheetOwnBtn').hidden = isSynth(ne.stem) || !sh.chords;
  $('#sheetOwnBtn').textContent = key === 'song' ? `Give ${stemLabel(ne.stem)} its own chords` : 'Use the song chords';
  $('#addLineBtn').hidden = !sh.chords && !sh.lyrics;

  const chords = chordList().filter((c) => c.chord && c.chord !== 'N').map((c) => ({ ...c, vs: toView(c.start), ve: toView(c.end) }));
  const lines = ((sh.lyrics || {}).lines || []).filter((l) => l.words && l.words.length)
    .map((l) => ({ ...l, vs: toView(l.start), ve: toView(l.end), words: l.words.map((w) => ({ ...w, vs: toView(w.start) })) }));
  if (!chords.length && !lines.length) {
    const e = document.createElement('p');
    e.className = 'muted sheet-empty';
    e.textContent = sh.chords ? 'No chords were found in this part.' : 'The chord sheet will show up here as soon as it\'s ready.';
    body.append(e);
    return;
  }
  const tol = 0.3;
  let ci = 0;
  let prevEnd = -1e9;
  const activeAt = (t) => { let a = null; for (const c of chords) { if (c.vs <= t + 1e-3) a = c; else break; } return a; };
  const rows = [];
  lines.forEach((ln, li) => {
    const start = ln.words[0].vs - tol;
    const gap = [];
    while (ci < chords.length && chords[ci].vs < start) { if (chords[ci].vs >= prevEnd - 1e-3) gap.push(chords[ci]); ci++; }
    if (gap.length) rows.push({ kind: 'inst', chords: gap });
    const next = li + 1 < lines.length ? lines[li + 1].words[0].vs - tol : Infinity;
    const mine = [];
    while (ci < chords.length && chords[ci].vs < next && chords[ci].vs <= ln.ve + 0.8) { mine.push(chords[ci]); ci++; }
    rows.push({ kind: 'line', line: ln, chords: mine, carry: mine.length && mine[0].vs <= ln.words[0].vs + 0.05 ? null : activeAt(ln.words[0].vs) });
    prevEnd = ln.ve;
  });
  if (ci < chords.length) rows.push({ kind: 'inst', chords: chords.slice(ci) });

  for (const r of rows) {
    if (r.kind === 'inst') body.append(instRow(r.chords));
    else body.append(lineRow(r.line, r.chords, r.carry));
  }
  if (!lines.length && sh.lyrics && sh.lyrics.note) {
    const n = document.createElement('p'); n.className = 'muted small'; n.textContent = sh.lyrics.note; body.prepend(n);
  }
  body.scrollTop = keep;
}

function chordLabel(c, cls) {
  const b = document.createElement('button');
  b.className = 'chord' + (cls ? ' ' + cls : '');
  b.textContent = display(c.chord);
  b.dataset.id = c.id;
  b.dataset.vs = c.vs ?? toView(c.start);
  b.dataset.ve = c.ve ?? toView(c.end);
  b.draggable = !cls;
  b.title = cls ? 'Chord still ringing from before' : 'Click to change, drag to move';
  b.onclick = (e) => { e.stopPropagation(); openChordPop(b, c); };
  b.addEventListener('dragstart', (e) => { sheetDrag = c; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', c.id); b.classList.add('dragging'); });
  b.addEventListener('dragend', () => { sheetDrag = null; b.classList.remove('dragging'); $$('.w.drop').forEach((x) => x.classList.remove('drop')); });
  return b;
}

function instRow(chords) {
  const row = document.createElement('div');
  row.className = 'sheet-row inst';
  row.dataset.start = chords[0].vs;
  for (const c of chords) {
    const cell = document.createElement('span');
    cell.className = 'bar';
    cell.dataset.t = c.vs;
    cell.append(chordLabel(c));
    cell.onclick = () => player.seek(c.vs);
    row.append(cell);
  }
  return row;
}

function lineRow(ln, chords, carry) {
  const row = document.createElement('div');
  row.className = 'sheet-row line';
  row.dataset.id = ln.id;
  row.dataset.start = ln.vs;
  row.dataset.end = ln.ve;
  const words = ln.words;
  const attach = words.map(() => []);
  for (const c of chords) {
    let k = 0;
    for (let i = 0; i < words.length; i++) if (words[i].vs <= c.vs + 0.12) k = i;
    attach[k].push(c);
  }
  words.forEach((w, i) => {
    const span = document.createElement('span');
    span.className = 'w';
    const top = document.createElement('span');
    top.className = 'ch';
    if (attach[i].length) attach[i].forEach((c) => top.append(chordLabel(c)));
    else if (i === 0 && carry) top.append(chordLabel(carry, 'carry'));
    else {
      const add = document.createElement('button');
      add.className = 'chord add';
      add.textContent = '+';
      add.title = 'Add a chord here';
      add.setAttribute('aria-label', `Add a chord on "${w.text}"`);
      add.onclick = (e) => { e.stopPropagation(); openChordPop(add, null, w.vs); };
      top.append(add);
    }
    const tx = document.createElement('span');
    tx.className = 'tx';
    tx.textContent = w.text;
    tx.onclick = () => player.seek(Math.max(0, w.vs - 0.05));
    span.append(top, tx);
    span.addEventListener('dragover', (e) => { if (sheetDrag) { e.preventDefault(); span.classList.add('drop'); } });
    span.addEventListener('dragleave', () => span.classList.remove('drop'));
    span.addEventListener('drop', (e) => {
      e.preventDefault(); span.classList.remove('drop');
      if (sheetDrag) moveChord(sheetDrag.id, w.vs);
    });
    row.append(span);
  });
  const edit = document.createElement('button');
  edit.className = 'btn ghost small edit-line';
  edit.textContent = 'Edit words';
  edit.onclick = () => editLine(row, ln);
  row.append(edit);
  row.ondblclick = (e) => { if (!e.target.closest('.chord')) editLine(row, ln); };
  return row;
}

// ------------------------------------------------------------------ chord edits

function openChordPop(anchor, c, atView) {
  closeChordPop();
  const pop = document.createElement('div');
  pop.className = 'chord-pop';
  pop.id = 'chordPop';
  pop.innerHTML = `
    <input type="text" aria-label="Chord" placeholder="e.g. G, Em, D7, Cmaj7">
    <div class="row">
      <button class="btn small" data-a="save">${c ? 'Save' : 'Add'}</button>
      ${c ? '<button class="btn ghost small" data-a="left" title="Move to the word before">Earlier</button><button class="btn ghost small" data-a="right" title="Move to the next word">Later</button><button class="btn ghost small" data-a="del">Delete</button>' : ''}
    </div>`;
  const input = $('input', pop);
  input.value = c ? display(c.chord) : (activeChordAt(atView) || '');
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.left = `${Math.min(window.innerWidth - 280, Math.max(8, r.left))}px`;
  pop.style.top = `${r.bottom + 6}px`;
  input.focus(); input.select();
  const save = () => {
    const v = input.value.trim();
    if (!/^[A-G][#b]?[a-zA-Z0-9#+°ø()\-]*(\/[A-G][#b]?)?$/.test(v)) { input.classList.add('bad'); return; }
    if (c) setChordName(c.id, stored(v)); else addChord(atView, stored(v));
  };
  pop.addEventListener('click', (e) => {
    const a = e.target.dataset && e.target.dataset.a;
    if (a === 'save') save();
    if (a === 'del') deleteChord(c.id);
    if (a === 'left' || a === 'right') nudgeChord(c, a === 'left' ? -1 : 1);
  });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    input.classList.remove('bad');
    if (e.key === 'Enter') save();
    if (e.key === 'Escape') closeChordPop();
  });
}
function closeChordPop() { const p = $('#chordPop'); if (p) p.remove(); }
document.addEventListener('pointerdown', (e) => { if (!e.target.closest('#chordPop, .chord')) closeChordPop(); });

function activeChordAt(tView) {
  let a = null;
  for (const c of chordList()) if (toView(c.start) <= tView + 1e-3 && c.chord !== 'N') a = c;
  return a ? display(a.chord) : '';
}

function setChordName(id, name) {
  const list = chordList();
  const c = list.find((x) => x.id === id);
  if (c) c.chord = name;
  saveChords(list);
}

function moveChord(id, tView) {
  const list = chordList();
  const i = list.findIndex((x) => x.id === id);
  if (i < 0) return;
  let t = toSource(tView);
  const lo = i > 0 ? list[i - 1].start + 0.05 : 0;
  const hi = i + 1 < list.length ? list[i + 1].start - 0.05 : list[i].end - 0.05;
  if (t <= lo || t >= hi) {
    // moving past a neighbour: take the chord out and put it back in at the new spot
    const [c] = list.splice(i, 1);
    if (i > 0) list[i - 1].end = c.end; else if (list.length) list[0].start = c.start;
    return insertAt(list, t, c.chord, c.id);
  }
  if (i > 0) list[i - 1].end = t;
  list[i].start = t;
  saveChords(list);
}

function insertAt(list, t, chord, id) {
  const j = list.findIndex((x) => x.start <= t && t < x.end);
  if (j < 0) {
    const end = list.length ? Math.max(t + 1, list[list.length - 1].end) : t + 2;
    list.push({ id: id || 'u' + Math.random().toString(36).slice(2, 7), start: t, end, chord });
  } else {
    const s = list[j];
    list.splice(j + 1, 0, { id: id || 'u' + Math.random().toString(36).slice(2, 7), start: t, end: s.end, chord });
    s.end = t;
    if (s.end - s.start < 0.02) list.splice(j, 1);
  }
  list.sort((a, b) => a.start - b.start);
  saveChords(list);
}

function addChord(tView, name) { insertAt(chordList(), toSource(tView), name); }

function deleteChord(id) {
  const list = chordList();
  const i = list.findIndex((x) => x.id === id);
  if (i < 0) return;
  const [c] = list.splice(i, 1);
  if (i > 0) list[i - 1].end = c.end; else if (list.length) list[0].start = c.start;
  saveChords(list);
}

function nudgeChord(c, dir) {
  // step to the neighbouring word (or beat, between lyric lines)
  const ws = [];
  for (const l of ((sheet().lyrics || {}).lines || [])) for (const w of l.words || []) ws.push(toView(w.start));
  const beats = currentBeats();
  const cands = [...ws, ...beats].sort((a, b) => a - b);
  const t = toView(c.start);
  const target = dir < 0 ? [...cands].reverse().find((x) => x < t - 0.05) : cands.find((x) => x > t + 0.05);
  if (target !== undefined) moveChord(c.id, target);
}

$('#sheetOwnBtn').onclick = async () => {
  const p = state.current;
  const own = chordKey() !== 'song';
  try {
    p.sheet = await api(`/projects/${p.id}/sheet`, {
      method: 'PUT',
      body: own ? { use_song_chords: ne.stem } : { part: ne.stem, chords: (sheet().chords || {}).song || [] },
    });
  } catch (e) { toast(e.message); }
  renderSheet();
};

// ------------------------------------------------------------------ lyric edits

function editLine(row, ln) {
  if (row.querySelector('input')) return;
  const box = document.createElement('div');
  box.className = 'line-edit';
  box.innerHTML = '<input type="text" aria-label="Lyric line"><button class="btn small" data-a="save">Save</button><button class="btn ghost small" data-a="del">Delete line</button><button class="btn ghost small" data-a="cancel">Cancel</button>';
  const input = $('input', box);
  input.value = ln.words.map((w) => w.text).join(' ');
  row.replaceWith(box);
  input.focus();
  const p = state.current;
  const finish = async (action) => {
    try {
      if (action === 'save') p.sheet = await api(`/projects/${p.id}/sheet`, { method: 'PUT', body: { line: { id: ln.id, text: input.value } } });
      if (action === 'del') p.sheet = await api(`/projects/${p.id}/sheet`, { method: 'PUT', body: { delete_line: ln.id } });
    } catch (e) { toast(e.message); }
    renderSheet();
  };
  box.addEventListener('click', (e) => { const a = e.target.dataset.a; if (a) finish(a); });
  input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') finish('save'); if (e.key === 'Escape') finish('cancel'); });
}

$('#addLineBtn').onclick = () => {
  const box = document.createElement('div');
  box.className = 'line-edit';
  const t = player.position();
  box.innerHTML = `<span class="muted small">At ${fmtTime(t)}</span><input type="text" aria-label="New lyric line" placeholder="Type the words"><button class="btn small">Add</button>`;
  const input = $('input', box);
  const body = $('#sheetBody');
  const after = [...body.querySelectorAll('.sheet-row')].find((r) => +r.dataset.start > t);
  body.insertBefore(box, after || null);
  input.focus();
  const go = async () => {
    if (!input.value.trim()) { renderSheet(); return; }
    const p = state.current;
    try { p.sheet = await api(`/projects/${p.id}/sheet`, { method: 'PUT', body: { add_line: { time: toSource(t), text: input.value } } }); } catch (e) { toast(e.message); }
    renderSheet();
  };
  $('button', box).onclick = go;
  input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') go(); if (e.key === 'Escape') renderSheet(); });
};

// ------------------------------------------------------------------ following playback

$('#sheetBody').addEventListener('wheel', () => { sheetUserScroll = performance.now(); }, { passive: true });

function followSheet(pos) {
  const body = $('#sheetBody');
  if (!body || $('#sheetView').hidden) return;
  let cur = null;
  for (const b of body.querySelectorAll('.chord:not(.add):not(.carry)')) {
    b.classList.toggle('now', +b.dataset.vs <= pos && pos < +b.dataset.ve);
  }
  for (const r of body.querySelectorAll('.sheet-row')) {
    const s = +r.dataset.start;
    if (s <= pos + 0.2) cur = r;
  }
  body.querySelectorAll('.sheet-row.now').forEach((r) => { if (r !== cur) r.classList.remove('now'); });
  if (cur && !cur.classList.contains('now')) {
    cur.classList.add('now');
    if (player.playing && performance.now() - sheetUserScroll > 3000) {
      const top = cur.offsetTop - body.clientHeight * 0.3;
      body.scrollTo({ top, behavior: 'smooth' });
    }
  }
}

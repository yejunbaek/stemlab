"""Local HTTP engine for Stemlab. Started by the desktop app; listens on 127.0.0.1 only."""
import argparse
import base64
import json
import os
import shutil
import sys
import threading
import time
import traceback
import uuid

from flask import Flask, abort, jsonify, request, send_file

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import notes as notes_mod  # noqa: E402
import synth as synth_mod  # noqa: E402
import chords as chords_mod  # noqa: E402
import lyrics as lyrics_mod  # noqa: E402
import clicker as clicker_mod  # noqa: E402
import audio_io  # noqa: E402
import processing  # noqa: E402
import sources  # noqa: E402

app = Flask(__name__)
CFG = {"data": None, "token": None, "js_runtime": None}
JOBS = {}
JOBS_LOCK = threading.Lock()
HEAVY_LOCK = threading.Lock()  # one separation/render at a time keeps memory sane
NOTE_LOCKS = {}


def log(*a):
    print(*a, flush=True)


# --------------------------------------------------------------------------- storage

def projects_dir():
    d = os.path.join(CFG["data"], "projects")
    os.makedirs(d, exist_ok=True)
    return d


def pdir(pid):
    if not pid or not all(c.isalnum() or c == "-" for c in pid):
        abort(404)
    d = os.path.join(projects_dir(), pid)
    if not os.path.isdir(d):
        abort(404)
    return d


def load_project(pid):
    with open(os.path.join(pdir(pid), "project.json"), encoding="utf-8") as f:
        return json.load(f)


def save_project(p):
    d = os.path.join(projects_dir(), p["id"])
    tmp = os.path.join(d, "project.json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(p, f, indent=1)
    os.replace(tmp, os.path.join(d, "project.json"))


# --------------------------------------------------------------------------- jobs

def start_job(kind, pid, fn):
    jid = uuid.uuid4().hex[:12]
    job = {"id": jid, "kind": kind, "project": pid, "status": "running",
           "progress": 0.0, "stage": "Starting", "error": None, "result": None}
    with JOBS_LOCK:
        JOBS[jid] = job

    def progress(frac, stage=None):
        job["progress"] = round(max(0.0, min(1.0, frac)), 4)
        if stage:
            job["stage"] = stage

    def runner():
        try:
            job["result"] = fn(progress)
            job["status"] = "done"
            job["progress"] = 1.0
        except Exception as e:  # report the error to the UI
            traceback.print_exc()
            job["status"] = "error"
            job["error"] = str(e) or e.__class__.__name__
    threading.Thread(target=runner, daemon=True).start()
    return job


def set_status(p, status, error=None):
    p["status"] = status
    p["error"] = error
    save_project(p)


# --------------------------------------------------------------------------- auth

@app.before_request
def check_token():
    tok = request.headers.get("X-Stemlab-Token") or request.args.get("t")
    if tok != CFG["token"]:
        abort(403)


@app.after_request
def no_cache(resp):
    resp.headers["Cache-Control"] = "no-store"
    # the app's page loads audio from here; allow it (every request still needs the token)
    if "/audio/" in request.path or "/peaks/" in request.path:
        resp.headers["Access-Control-Allow-Origin"] = "*"
    return resp


# --------------------------------------------------------------------------- routes

@app.get("/health")
def health():
    import torch
    return jsonify(ok=True, gpu=bool(torch.cuda.is_available()),
                   gpu_name=torch.cuda.get_device_name(0) if torch.cuda.is_available() else None)


@app.get("/projects")
def list_projects():
    out = []
    for pid in os.listdir(projects_dir()):
        f = os.path.join(projects_dir(), pid, "project.json")
        if os.path.isfile(f):
            try:
                with open(f, encoding="utf-8") as fh:
                    p = json.load(fh)
                item = {k: p.get(k) for k in ("id", "title", "artist", "status", "created", "error", "stems")}
                item["synths"] = [{"id": k, "name": v.get("name")} for k, v in (p.get("synths") or {}).items()]
                item["clicker"] = bool(p.get("clicker"))
                out.append(item)
            except Exception:
                pass
    out.sort(key=lambda p: p.get("created") or 0, reverse=True)
    return jsonify(out)


@app.get("/projects/<pid>")
def get_project(pid):
    return jsonify(load_project(pid))


@app.delete("/projects/<pid>")
def delete_project(pid):
    shutil.rmtree(pdir(pid), ignore_errors=True)
    return jsonify(ok=True)


@app.post("/projects")
def create_project():
    body = request.get_json(force=True)
    kind = body.get("type")
    value = body.get("path") if kind == "file" else body.get("url")
    if kind not in ("file", "url") or not value:
        return jsonify(error="Give a file or a link."), 400
    pid = time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6]
    d = os.path.join(projects_dir(), pid)
    os.makedirs(d)
    guess = os.path.splitext(os.path.basename(value))[0] if kind == "file" else "Fetching…"
    p = {"id": pid, "title": guess, "artist": None, "created": time.time(),
         "status": "importing", "error": None, "stems": [], "analysis": None, "render": None}
    save_project(p)

    def work(progress):
        try:
            progress(0.0, "Getting the audio")
            meta = sources.fetch(kind, value, d, lambda f: progress(0.08 * f, "Getting the audio"),
                                 CFG["js_runtime"])
            p.update(meta)
            set_status(p, "splitting")
            progress(0.08, "Waiting for another song to finish")
            with HEAVY_LOCK:
                progress(0.08, "Separating instruments")
                stems = processing.separate(os.path.join(d, "original.wav"), os.path.join(d, "stems"),
                                            lambda f, s=None: progress(0.08 + 0.82 * f, s), log)
            p["stems"] = stems
            set_status(p, "analyzing")
            progress(0.9, "Finding tempo and key")
            p["analysis"] = processing.analyze(d, stems)
            set_status(p, "ready")
            queue_extras(pid)
            return {"project": pid}
        except Exception as e:
            set_status(p, "error", str(e))
            raise

    job = start_job("import", pid, work)
    return jsonify(project=p, job=job)


@app.post("/projects/<pid>/retry")
def retry(pid):
    p = load_project(pid)
    d = pdir(pid)
    if not os.path.isfile(os.path.join(d, "original.wav")):
        return jsonify(error="The original audio is missing; import the song again."), 400

    def work(progress):
        try:
            set_status(p, "splitting")
            with HEAVY_LOCK:
                p["stems"] = processing.separate(os.path.join(d, "original.wav"), os.path.join(d, "stems"),
                                                 lambda f, s=None: progress(0.9 * f, s), log)
            set_status(p, "analyzing")
            progress(0.9, "Finding tempo and key")
            p["analysis"] = processing.analyze(d, p["stems"])
            set_status(p, "ready")
            queue_extras(pid)
            return {"project": pid}
        except Exception as e:
            set_status(p, "error", str(e))
            raise
    return jsonify(job=start_job("import", pid, work))


@app.patch("/projects/<pid>")
def rename(pid):
    p = load_project(pid)
    body = request.get_json(force=True)
    for k in ("title", "artist"):
        if k in body:
            p[k] = (body[k] or "").strip()[:200] or p.get(k)
    save_project(p)
    return jsonify(p)


@app.post("/projects/<pid>/render")
def render(pid):
    p = load_project(pid)
    if p.get("status") != "ready":
        return jsonify(error="This song isn't finished splitting yet."), 400
    settings = request.get_json(force=True) or {}
    d = pdir(pid)

    def work(progress):
        with HEAVY_LOCK:
            info = processing.render(d, p, settings, progress)
        p["render"] = info
        if p.get("clicker"):
            _render_click(pid, p, "render")
        cleared = []
        for stem, ne in list((p.get("note_edits") or {}).items()):
            if ne.get("base") == "render":
                cleared.append(stem)
                del p["note_edits"][stem]
                try:
                    audio_io.remove(os.path.join(d, "notes", stem + ".wav"))
                except OSError:
                    pass
        save_project(p)
        return {**info, "notes_cleared": cleared}
    return jsonify(job=start_job("render", pid, work))


@app.post("/projects/<pid>/export")
def export(pid):
    p = load_project(pid)
    req = request.get_json(force=True) or {}
    if not req.get("dest_dir"):
        return jsonify(error="Pick a folder to save to."), 400
    if req.get("version") == "render" and not p.get("render"):
        req["version"] = "stems"
    d = pdir(pid)
    version = req.get("version", "render")
    req["_extra"] = list((p.get("synths") or {}).keys())
    req["_paths"] = {sid: audio_io.current(os.path.join(d, "synth", sid + ".wav")) for sid in req["_extra"]}
    if p.get("clicker"):
        which = "render" if version == "render" and p.get("render") else "stems"
        cpath = os.path.join(d, "click", which + ".wav")
        if not os.path.isfile(cpath):
            _render_click(pid, p, which)
        req["_extra"].append("click")
        req["_paths"]["click"] = audio_io.current(cpath)
    req["_paths"].update({stem: audio_io.current(os.path.join(d, "notes", stem + ".wav"))
                     for stem, ne in (p.get("note_edits") or {}).items()
                     if ne.get("active") and ne.get("base") == version
                     and os.path.isfile(audio_io.current(os.path.join(d, "notes", stem + ".wav")))})
    def work(progress):
        try:
            return processing.export(d, p, req, progress)
        except PermissionError as e:
            raise RuntimeError(
                f"Windows didn't allow saving to {req['dest_dir']}. Pick another folder, like Downloads. "
                "If it keeps happening, Windows Security's ransomware protection may be blocking Stemlab.") from e
        except OSError as e:
            if getattr(e, "errno", None) == 28:
                raise RuntimeError("There isn't enough free disk space for the export.") from e
            raise
    return jsonify(job=start_job("export", pid, work))


@app.get("/jobs/<jid>")
def job_status(jid):
    job = JOBS.get(jid)
    if not job:
        abort(404)
    return jsonify(job)


def audio_path(pid, version, name):
    d = pdir(pid)
    if version == "original":
        path = os.path.join(d, "original.wav")
    elif version == "click":
        which = name.rsplit(".", 1)[0]
        if which not in ("stems", "render"):
            abort(404)
        path = os.path.join(d, "click", which + ".wav")
        if not os.path.isfile(path):
            p = load_project(pid)
            if not p.get("clicker"):
                abort(404)
            _render_click(pid, p, which)
    elif version in ("stems", "render", "notes", "synth"):
        stem = name.rsplit(".", 1)[0]
        if not stem.isalnum():
            abort(404)
        path = os.path.join(d, version, stem + ".wav")
    else:
        abort(404)
    path = audio_io.current(path)
    if not os.path.isfile(path):
        abort(404)
    return path


@app.get("/projects/<pid>/audio/<version>/<name>")
def audio(pid, version, name):
    return send_file(audio_path(pid, version, name), mimetype="audio/wav", conditional=True)


PEAK_RATE = 100


@app.get("/projects/<pid>/peaks/<version>/<name>")
def peaks(pid, version, name):
    """Loudness outline of a part (100 values per second) for drawing, so the app never has to
    load whole songs into memory."""
    import numpy as np
    import soundfile as sf
    path = audio_path(pid, version, name)
    cache = path + ".peaks"
    if not (os.path.isfile(cache) and os.path.getmtime(cache) >= os.path.getmtime(path)):
        vals = []
        with sf.SoundFile(path) as f:
            per = f.samplerate // PEAK_RATE
            while True:
                block = f.read(per * 2000, dtype="float32", always_2d=True)
                if not len(block):
                    break
                mono = np.abs(block.mean(axis=1))
                n = len(mono) // per
                if n:
                    vals.append(mono[: n * per].reshape(n, per).max(axis=1))
                if len(mono) % per:
                    vals.append(np.array([mono[n * per:].max()]))
        v = np.concatenate(vals) if vals else np.zeros(1)
        q = np.clip(np.round(np.sqrt(np.clip(v, 0, 1)) * 255), 0, 255).astype(np.uint8)
        with open(cache + ".tmp", "wb") as fh:
            fh.write(q.tobytes())
        os.replace(cache + ".tmp", cache)
    with open(cache, "rb") as fh:
        data = fh.read()
    return jsonify(rate=PEAK_RATE, scale="sqrt", data=base64.b64encode(data).decode("ascii"))


# --------------------------------------------------------------------------- notes

def _stem_or_404(p, stem):
    if stem not in p.get("stems", []) or stem == "drums":
        abort(404)


@app.get("/projects/<pid>/notes/<stem>")
def get_notes(pid, stem):
    p = load_project(pid)
    _stem_or_404(p, stem)
    return jsonify((p.get("note_edits") or {}).get(stem))


@app.post("/projects/<pid>/notes/<stem>/detect")
def detect_notes(pid, stem):
    p = load_project(pid)
    _stem_or_404(p, stem)
    base = (request.get_json(silent=True) or {}).get("base", "stems")
    if base not in ("stems", "render") or (base == "render" and not p.get("render")):
        base = "stems"
    d = pdir(pid)
    path = audio_io.current(os.path.join(d, base, stem + ".wav"))

    def work(progress):
        found = notes_mod.detect(path, stem, progress)
        with NOTE_LOCKS.setdefault(pid, threading.Lock()):
            q = load_project(pid)
            q.setdefault("note_edits", {})[stem] = {"base": base, "detected": found, "notes": found,
                                                    "active": False}
            save_project(q)
            try:
                audio_io.remove(os.path.join(d, "notes", stem + ".wav"))
            except OSError:
                pass
        return {"count": len(found)}
    return jsonify(job=start_job("notes", pid, work))


@app.put("/projects/<pid>/notes/<stem>")
def save_notes(pid, stem):
    body = request.get_json(force=True) or {}
    d = pdir(pid)
    with NOTE_LOCKS.setdefault(pid, threading.Lock()):
        p = load_project(pid)
        _stem_or_404(p, stem)
        ne = (p.get("note_edits") or {}).get(stem)
        if not ne:
            return jsonify(error="Find the notes first."), 400
        clean = []
        for n in body.get("notes", []):
            try:
                item = {k: n[k] for k in ("id", "start", "end", "midi", "orig_start", "orig_end", "orig_midi")}
                item.update(start=max(0.0, float(item["start"])), end=float(item["end"]), midi=int(item["midi"]))
                if item["end"] <= item["start"] or not 0 <= item["midi"] <= 127:
                    continue
                item["src"] = n.get("src")
                item["level"] = n.get("level", 1)
                item["cents"] = n.get("cents", 0)
                clean.append(item)
            except (KeyError, TypeError, ValueError):
                continue
        clean.sort(key=lambda n: n["start"])
        ne["notes"] = clean
        out = os.path.join(d, "notes", stem + ".wav")
        edited = any(n.get("src") is not None or notes_mod._changed(n) for n in clean) or \
            len([n for n in clean if n.get("src") is None]) != len(ne["detected"])
        if edited:
            notes_mod.render(audio_io.current(os.path.join(d, ne["base"], stem + ".wav")), out, ne["detected"], clean)
        else:
            audio_io.remove(out)
        ne["active"] = edited
        ne["stamp"] = time.time()
        save_project(p)
        return jsonify(ne)


@app.delete("/projects/<pid>/notes/<stem>")
def drop_notes(pid, stem):
    d = pdir(pid)
    with NOTE_LOCKS.setdefault(pid, threading.Lock()):
        p = load_project(pid)
        (p.get("note_edits") or {}).pop(stem, None)
        save_project(p)
        try:
            audio_io.remove(os.path.join(d, "notes", stem + ".wav"))
        except OSError:
            pass
    return jsonify(ok=True)


# --------------------------------------------------------------------------- synth parts

def _song_length(p):
    lens = [(p.get("analysis") or {}).get("duration") or 0, (p.get("render") or {}).get("duration") or 0]
    return max(lens) or 1.0


def _render_synth(pid, p, sid):
    sy = p["synths"][sid]
    audio = synth_mod.render(sy["notes"], sy["preset"], _song_length(p))
    import audio_io
    audio_io.write(os.path.join(pdir(pid), "synth", sid + ".wav"), audio, synth_mod.SR)
    sy["stamp"] = time.time()


def _clean_synth_notes(raw):
    out = []
    for n in raw or []:
        try:
            s, e, m = float(n["start"]), float(n["end"]), int(n["midi"])
        except (KeyError, TypeError, ValueError):
            continue
        if e > s >= 0 and 0 <= m <= 127:
            out.append({"id": str(n.get("id") or uuid.uuid4().hex[:8])[:16], "start": round(s, 4),
                        "end": round(e, 4), "midi": m, "vel": float(n.get("vel", 0.8))})
    out.sort(key=lambda n: n["start"])
    return out


@app.get("/synth-presets")
def synth_presets():
    return jsonify(synth_mod.PRESETS)


@app.post("/projects/<pid>/synths")
def add_synth(pid):
    body = request.get_json(silent=True) or {}
    os.makedirs(os.path.join(pdir(pid), "synth"), exist_ok=True)
    with NOTE_LOCKS.setdefault(pid, threading.Lock()):
        p = load_project(pid)
        synths = p.setdefault("synths", {})
        k = 1
        while f"synth{k}" in synths:
            k += 1
        sid = f"synth{k}"
        preset = body.get("preset") if body.get("preset") in synth_mod.PRESETS else "lead"
        synths[sid] = {"id": sid, "name": f"Synth {k}" if k > 1 else "Synth", "preset": preset, "notes": []}
        _render_synth(pid, p, sid)
        save_project(p)
        return jsonify(synths[sid])


@app.put("/projects/<pid>/synths/<sid>")
def update_synth(pid, sid):
    body = request.get_json(force=True) or {}
    with NOTE_LOCKS.setdefault(pid, threading.Lock()):
        p = load_project(pid)
        sy = (p.get("synths") or {}).get(sid)
        if not sy:
            abort(404)
        if "notes" in body:
            sy["notes"] = _clean_synth_notes(body["notes"])
        if body.get("preset") in synth_mod.PRESETS:
            sy["preset"] = body["preset"]
        if body.get("copy_from"):
            src = ((p.get("note_edits") or {}).get(body["copy_from"]) or {}).get("notes")
            if not src:
                return jsonify(error="Find the notes in that part first."), 400
            shift = int(body.get("shift", 0))
            sy["notes"] = _clean_synth_notes([{"start": n["start"], "end": n["end"], "midi": n["midi"] + shift,
                                               "vel": 0.5 + 0.5 * float(n.get("level", 0.6))} for n in src])
        _render_synth(pid, p, sid)
        save_project(p)
        return jsonify(sy)


@app.delete("/projects/<pid>/synths/<sid>")
def delete_synth(pid, sid):
    with NOTE_LOCKS.setdefault(pid, threading.Lock()):
        p = load_project(pid)
        (p.get("synths") or {}).pop(sid, None)
        save_project(p)
        try:
            audio_io.remove(os.path.join(pdir(pid), "synth", sid + ".wav"))
        except OSError:
            pass
    return jsonify(ok=True)


# --------------------------------------------------------------------------- background extras
# After a song is split, find the notes in every part, the chords, and the lyrics, one task at a
# time, so they're ready when the person opens the Notes screen.

EXTRA_Q = []                 # [(pid, task)] task: "notes:<stem>" | "chords" | "lyrics"
EXTRA_CV = threading.Condition()
EXTRA_NOW = {}               # pid -> {"task", "progress", "stage"}


def _extras_needed(p):
    tasks = []
    ex = p.get("extras") or {}
    for stem in p.get("stems", []):
        if stem == "drums":
            continue
        if not (p.get("note_edits") or {}).get(stem) and not str((ex.get("notes") or {}).get(stem, "")).startswith("error"):
            tasks.append(f"notes:{stem}")
    sheet = p.get("sheet") or {}
    if not sheet.get("chords") and not str(ex.get("chords", "")).startswith("error"):
        tasks.append("chords")
    if "vocals" in p.get("stems", []) and sheet.get("lyrics") is None and not str(ex.get("lyrics", "")).startswith("error"):
        tasks.append("lyrics")
    return tasks


def _set_extra(pid, task, status):
    with NOTE_LOCKS.setdefault(pid, threading.Lock()):
        try:
            q = load_project(pid)
        except Exception:
            return
        ex = q.setdefault("extras", {})
        if task.startswith("notes:"):
            ex.setdefault("notes", {})[task[6:]] = status
        else:
            ex[task] = status
        save_project(q)


def queue_extras(pid, front=None):
    try:
        p = load_project(pid)
    except Exception:
        return
    if p.get("status") != "ready":
        return
    with EXTRA_CV:
        for t in _extras_needed(p):
            if (pid, t) not in EXTRA_Q and EXTRA_NOW.get(pid, {}).get("task") != t:
                EXTRA_Q.append((pid, t))
                _set_extra(pid, t, "queued")
        if front:
            items = [x for x in EXTRA_Q if x[0] == pid and x[1] == front]
            for x in items:
                EXTRA_Q.remove(x)
                EXTRA_Q.insert(0, x)
        EXTRA_CV.notify()


def _run_extra(pid, task):
    d = pdir(pid)
    p = load_project(pid)
    now = EXTRA_NOW[pid] = {"task": task, "progress": 0.0, "stage": "Starting"}

    def progress(f, stage=None):
        now["progress"] = round(max(0.0, min(1.0, f)), 3)
        if stage:
            now["stage"] = stage

    if task.startswith("notes:"):
        stem = task[6:]
        found = notes_mod.detect(os.path.join(d, "stems", stem + ".wav"), stem, progress)
        with NOTE_LOCKS.setdefault(pid, threading.Lock()):
            q = load_project(pid)
            if not (q.get("note_edits") or {}).get(stem):
                q.setdefault("note_edits", {})[stem] = {"base": "stems", "detected": found, "notes": found, "active": False}
                save_project(q)
    elif task == "chords":
        import librosa
        import numpy as np
        sr = 22050
        loads = {}
        for s in p["stems"]:
            if s != "drums":
                loads[s], _ = librosa.load(os.path.join(d, "stems", s + ".wav"), sr=sr, mono=True)
        beats = (p.get("analysis") or {}).get("beats") or []
        key = (p.get("analysis") or {}).get("key")
        harm = [loads[s] for s in loads if s not in ("vocals",)] or list(loads.values())
        n = min(len(x) for x in harm)
        mix = sum(x[:n] for x in harm)
        progress(0.1, "Finding the chords")
        song, _ = chords_mod.detect(mix, sr, beats, key)
        result = {"song": song}
        source = {}
        loud = max(float(np.sqrt(np.mean(x ** 2))) for x in loads.values()) + 1e-9
        for i, (s, y) in enumerate(loads.items()):
            progress(0.2 + 0.8 * i / max(1, len(loads)), f"Finding the chords for {s}")
            active = float(np.sqrt(np.mean(y ** 2))) > 0.15 * loud
            if s in ("vocals", "bass") or not active:
                source[s] = "song"
                continue
            own, conf = chords_mod.detect(y, sr, beats, key)
            same = _agreement(own, song)
            if conf >= 0.82 and same < 0.85:
                result[s] = own
                source[s] = "own"
            else:
                source[s] = "song"
        with NOTE_LOCKS.setdefault(pid, threading.Lock()):
            q = load_project(pid)
            sheet = q.setdefault("sheet", {})
            sheet["chords"] = result
            sheet["chord_source"] = source
            save_project(q)
    elif task == "lyrics":
        res = lyrics_mod.transcribe(os.path.join(d, "stems", "vocals.wav"),
                                    os.path.join(CFG["data"], "models", "whisper"), progress)
        with NOTE_LOCKS.setdefault(pid, threading.Lock()):
            q = load_project(pid)
            q.setdefault("sheet", {})["lyrics"] = res
            save_project(q)


def _agreement(a, b):
    """Share of time two chord timelines agree."""
    if not a or not b:
        return 0.0
    end = max(a[-1]["end"], b[-1]["end"])
    ts = [i * 0.25 for i in range(int(end / 0.25))]
    def at(segs, t):
        for s in segs:
            if s["start"] <= t < s["end"]:
                return s["chord"]
        return "N"
    same = sum(1 for t in ts if at(a, t) == at(b, t))
    return same / max(1, len(ts))


def _extras_worker():
    while True:
        with EXTRA_CV:
            while not EXTRA_Q:
                EXTRA_CV.wait()
            pid, task = EXTRA_Q.pop(0)
        try:
            _set_extra(pid, task, "running")
            _run_extra(pid, task)
            _set_extra(pid, task, "done")
        except Exception as e:  # keep going with the other tasks
            traceback.print_exc()
            _set_extra(pid, task, "error: " + (str(e) or e.__class__.__name__)[:300])
        finally:
            EXTRA_NOW.pop(pid, None)


@app.get("/projects/<pid>/extras")
def extras_status(pid):
    p = load_project(pid)
    with EXTRA_CV:
        queued = [t for (q, t) in EXTRA_Q if q == pid]
    return jsonify(status=p.get("extras") or {}, now=EXTRA_NOW.get(pid), queued=queued)


@app.post("/projects/<pid>/extras")
def extras_request(pid):
    """Queue anything missing; 'first' moves one task to the front; 'retry' clears an error."""
    body = request.get_json(silent=True) or {}
    retry = body.get("retry")
    if retry:
        with NOTE_LOCKS.setdefault(pid, threading.Lock()):
            p = load_project(pid)
            ex = p.setdefault("extras", {})
            if retry.startswith("notes:"):
                (ex.get("notes") or {}).pop(retry[6:], None)
            else:
                ex.pop(retry, None)
                if retry == "lyrics":
                    (p.get("sheet") or {}).pop("lyrics", None)
                if retry == "chords":
                    (p.get("sheet") or {}).pop("chords", None)
            save_project(p)
    queue_extras(pid, front=body.get("first") or retry)
    return extras_status(pid)


# --------------------------------------------------------------------------- chord sheet edits

@app.put("/projects/<pid>/sheet")
def save_sheet(pid):
    body = request.get_json(force=True) or {}
    with NOTE_LOCKS.setdefault(pid, threading.Lock()):
        p = load_project(pid)
        sheet = p.setdefault("sheet", {})
        if "line" in body:                      # one lyric line's text changed
            ln = body["line"]
            lines = (sheet.get("lyrics") or {}).get("lines") or []
            for i, old in enumerate(lines):
                if old["id"] == ln.get("id"):
                    lines[i] = lyrics_mod.retime_line(old, str(ln.get("text", ""))[:500])
            sheet["lyrics"]["edited"] = True
        if "add_line" in body:                   # a new lyric line at a time
            t = float(body["add_line"].get("time", 0))
            lyr = sheet.setdefault("lyrics", {"lines": []})
            lyr.setdefault("lines", [])
            new = lyrics_mod.retime_line({"id": "u" + uuid.uuid4().hex[:6], "start": t, "end": t + 3.0, "words": []},
                                         str(body["add_line"].get("text", ""))[:500])
            lyr["lines"].append(new)
            lyr["lines"].sort(key=lambda l: l["start"])
            lyr["edited"] = True
        if "delete_line" in body:
            lyr = sheet.get("lyrics") or {}
            lyr["lines"] = [l for l in lyr.get("lines", []) if l["id"] != body["delete_line"]]
        if "chords" in body:                     # a part's chord list (or the shared "song" list)
            key = body.get("part") or "song"
            clean = []
            for c in body["chords"]:
                try:
                    clean.append({"id": str(c.get("id") or uuid.uuid4().hex[:6])[:12],
                                  "start": round(float(c["start"]), 3), "end": round(float(c["end"]), 3),
                                  "chord": str(c["chord"])[:12]})
                except (KeyError, TypeError, ValueError):
                    continue
            clean.sort(key=lambda c: c["start"])
            sheet.setdefault("chords", {})[key] = clean
            if key != "song":
                sheet.setdefault("chord_source", {})[key] = "own"
        if body.get("use_song_chords"):
            part = body["use_song_chords"]
            (sheet.get("chords") or {}).pop(part, None)
            sheet.setdefault("chord_source", {})[part] = "song"
        save_project(p)
        return jsonify(sheet)


# --------------------------------------------------------------------------- clicker

def _click_beats(p, which):
    if which == "render" and p.get("render"):
        return p["render"].get("beats") or [], p["render"].get("duration") or 0
    a = p.get("analysis") or {}
    return a.get("beats") or [], a.get("duration") or 0


def _render_click(pid, p, which):
    import audio_io
    beats, dur = _click_beats(p, which)
    ck = p.get("clicker") or {}
    audio = clicker_mod.render(beats, dur, int(ck.get("per_bar", 4)), int(ck.get("offset", 0)))
    os.makedirs(os.path.join(pdir(pid), "click"), exist_ok=True)
    audio_io.write(os.path.join(pdir(pid), "click", which + ".wav"), audio, clicker_mod.SR)


@app.post("/projects/<pid>/clicker")
def set_clicker(pid):
    """Add the clicker or change it: per_bar (beats in a bar), offset (which beat is the bar's first)."""
    body = request.get_json(silent=True) or {}
    with NOTE_LOCKS.setdefault(pid, threading.Lock()):
        p = load_project(pid)
        beats = (p.get("analysis") or {}).get("beats") or []
        if len(beats) < 8:
            return jsonify(error="This song has no steady beat to click along to."), 400
        ck = p.get("clicker") or {}
        per_bar = int(body.get("per_bar", ck.get("per_bar", 4)))
        if per_bar not in (2, 3, 4, 5, 6, 7, 8, 12):
            per_bar = 4
        if "offset" in body:
            offset = int(body["offset"]) % per_bar
        elif ck and per_bar == ck.get("per_bar"):
            offset = ck.get("offset", 0)
        else:
            drums = os.path.join(pdir(pid), "stems", "drums.wav")
            offset = clicker_mod.guess_downbeat(beats, drums if os.path.isfile(drums) else None, per_bar)
        p["clicker"] = {"per_bar": per_bar, "offset": offset, "stamp": time.time()}
        _render_click(pid, p, "stems")
        if p.get("render"):
            _render_click(pid, p, "render")
        save_project(p)
        return jsonify(p["clicker"])


@app.delete("/projects/<pid>/clicker")
def remove_clicker(pid):
    with NOTE_LOCKS.setdefault(pid, threading.Lock()):
        p = load_project(pid)
        p.pop("clicker", None)
        save_project(p)
        shutil.rmtree(os.path.join(pdir(pid), "click"), ignore_errors=True)
    return jsonify(ok=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--data", required=True)
    ap.add_argument("--token", required=True)
    ap.add_argument("--js-runtime", default=None)
    a = ap.parse_args()
    CFG.update(data=a.data, token=a.token, js_runtime=a.js_runtime)
    os.makedirs(a.data, exist_ok=True)
    os.environ.setdefault("TORCH_HOME", os.path.join(a.data, "models"))
    # mark imports interrupted by a previous crash
    for pid in os.listdir(projects_dir()):
        f = os.path.join(projects_dir(), pid, "project.json")
        try:
            with open(f, encoding="utf-8") as fh:
                p = json.load(fh)
            if p.get("status") in ("importing", "splitting", "analyzing"):
                p["status"], p["error"] = "error", "Stopped before it finished. Hit Retry."
                save_project(p)
        except Exception:
            pass
    threading.Thread(target=_extras_worker, daemon=True).start()
    for pid in sorted(os.listdir(projects_dir()), reverse=True):
        if os.path.isfile(os.path.join(projects_dir(), pid, "project.json")):
            queue_extras(pid)
    log(f"STEMLAB_READY {a.port}")
    app.run(host="127.0.0.1", port=a.port, threaded=True, use_reloader=False)


if __name__ == "__main__":
    main()

"""Local HTTP engine for Stemlab. Started by the desktop app; listens on 127.0.0.1 only."""
import argparse
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
                out.append({k: p.get(k) for k in ("id", "title", "artist", "status", "created", "error")})
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
        cleared = []
        for stem, ne in list((p.get("note_edits") or {}).items()):
            if ne.get("base") == "render":
                cleared.append(stem)
                del p["note_edits"][stem]
                try:
                    os.remove(os.path.join(d, "notes", stem + ".wav"))
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
    req["_paths"] = {sid: os.path.join(d, "synth", sid + ".wav") for sid in req["_extra"]}
    req["_paths"].update({stem: os.path.join(d, "notes", stem + ".wav")
                     for stem, ne in (p.get("note_edits") or {}).items()
                     if ne.get("active") and ne.get("base") == version
                     and os.path.isfile(os.path.join(d, "notes", stem + ".wav"))})
    return jsonify(job=start_job("export", pid, lambda progress: processing.export(d, p, req, progress)))


@app.get("/jobs/<jid>")
def job_status(jid):
    job = JOBS.get(jid)
    if not job:
        abort(404)
    return jsonify(job)


@app.get("/projects/<pid>/audio/<version>/<name>")
def audio(pid, version, name):
    d = pdir(pid)
    if version == "original":
        path = os.path.join(d, "original.wav")
    elif version in ("stems", "render", "notes", "synth"):
        stem = name.rsplit(".", 1)[0]
        if not stem.isalnum():
            abort(404)
        path = os.path.join(d, version, stem + ".wav")
    else:
        abort(404)
    if not os.path.isfile(path):
        abort(404)
    return send_file(path, mimetype="audio/wav", conditional=True)


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
    path = os.path.join(d, base, stem + ".wav")

    def work(progress):
        found = notes_mod.detect(path, stem, progress)
        with NOTE_LOCKS.setdefault(pid, threading.Lock()):
            q = load_project(pid)
            q.setdefault("note_edits", {})[stem] = {"base": base, "detected": found, "notes": found,
                                                    "active": False}
            save_project(q)
            try:
                os.remove(os.path.join(d, "notes", stem + ".wav"))
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
            notes_mod.render(os.path.join(d, ne["base"], stem + ".wav"), out, ne["detected"], clean)
        elif os.path.isfile(out):
            os.remove(out)
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
            os.remove(os.path.join(d, "notes", stem + ".wav"))
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
            os.remove(os.path.join(pdir(pid), "synth", sid + ".wav"))
        except OSError:
            pass
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
    log(f"STEMLAB_READY {a.port}")
    app.run(host="127.0.0.1", port=a.port, threaded=True, use_reloader=False)


if __name__ == "__main__":
    main()

"""The heavy lifting: stem separation, tempo/key analysis, and rendering pitch/tempo/rhythm edits."""
import os
import threading
from concurrent.futures import ThreadPoolExecutor

import numpy as np

import audio_io

STEM_ORDER = ["vocals", "guitar", "piano", "bass", "drums", "other"]
MODEL_NAME = "htdemucs_6s"
NOTE_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]


# --------------------------------------------------------------------------- separation

def separate(mix_path, stems_dir, progress_cb, log=print):
    import torch
    import demucs.apply as dapply
    from demucs.apply import BagOfModels, apply_model
    from demucs.pretrained import get_model

    progress_cb(0.0, "Loading the separation model (first time downloads it)")
    try:
        model = get_model(MODEL_NAME)
    except Exception as e:
        raise RuntimeError("Couldn't download the instrument-splitting model. Check your internet "
                           f"connection, then hit Retry. ({e})")
    model.eval()

    wav, sr = audio_io.read(mix_path)
    if sr != model.samplerate:
        raise RuntimeError(f"Expected {model.samplerate} Hz audio, got {sr}")
    wav = torch.from_numpy(wav)
    ref = wav.mean(0)
    mean, std = ref.mean(), ref.std() + 1e-8
    wav = (wav - mean) / std

    n_models = len(model.models) if isinstance(model, BagOfModels) else 1
    state = {"done": 0}

    class _ProgressShim:
        @staticmethod
        def tqdm(iterable, **_kw):
            items = list(iterable)
            total = max(1, len(items))
            for i, item in enumerate(items):
                yield item
                progress_cb((state["done"] + (i + 1) / total) / n_models, "Separating instruments")
            state["done"] += 1

    dapply.tqdm = _ProgressShim

    def run(device):
        state["done"] = 0
        with torch.no_grad():
            return apply_model(model, wav[None], device=device, shifts=1, split=True,
                               overlap=0.25, progress=True, num_workers=0)[0]

    device = "cuda" if torch.cuda.is_available() else "cpu"
    try:
        sources = run(device)
    except RuntimeError as e:
        if device == "cuda":
            log(f"GPU failed ({e}); falling back to CPU")
            torch.cuda.empty_cache()
            sources = run("cpu")
        else:
            raise
    sources = (sources * std + mean).cpu().numpy()

    os.makedirs(stems_dir, exist_ok=True)
    names = []
    for name, src in zip(model.sources, sources):
        audio_io.write(os.path.join(stems_dir, name + ".wav"), src.astype(np.float32), sr)
        names.append(name)
    return [n for n in STEM_ORDER if n in names] + [n for n in names if n not in STEM_ORDER]


# --------------------------------------------------------------------------- analysis

_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


def key_name(tonic, mode, shift=0):
    return f"{NOTE_NAMES[(tonic + shift) % 12]} {'major' if mode == 'major' else 'minor'}"


def clean_beats(beats):
    b = np.asarray(beats, dtype=float)
    if len(b) < 4:
        return b
    med = float(np.median(np.diff(b)))
    out = [b[0]]
    for t in b[1:]:
        gap = t - out[-1]
        if gap < 0.55 * med:
            continue  # spurious extra beat
        if gap > 1.6 * med:  # missed beat(s): fill in evenly
            n = int(round(gap / med))
            start = out[-1]
            for i in range(1, n):
                out.append(start + gap * i / n)
        out.append(t)
    return np.array(out)


def refine_beats(beats, y, sr):
    """The beat tracker works on ~23 ms frames and smooths out the player's timing. Snap each
    beat to the actual hit it belongs to, so the tempo map follows what was really played."""
    import librosa
    if len(beats) < 2:
        return beats
    hop = 128
    env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop, aggregate=np.median)
    hits = librosa.onset.onset_detect(onset_envelope=env, sr=sr, hop_length=hop, units="time",
                                      backtrack=True)
    if len(hits) == 0:
        return beats
    window = 0.25 * float(np.median(np.diff(beats)))
    out = beats.copy()
    for i, b in enumerate(beats):
        j = np.searchsorted(hits, b)
        near = [h for h in hits[max(0, j - 2): j + 2] if abs(h - b) < window]
        if near:
            out[i] = min(near, key=lambda h: abs(h - b))
    # keep order and spacing sane after snapping
    keep = np.concatenate([[True], np.diff(out) > 0.5 * np.median(np.diff(beats))])
    return out[keep]


def fit_grid(beats):
    """Least-squares straight line through the beats: returns (period, offset)."""
    k = np.arange(len(beats))
    period, offset = np.polyfit(k, beats, 1)
    return float(period), float(offset)


def _load_mono(path, sr=22050):
    import librosa
    y, _ = librosa.load(path, sr=sr, mono=True)
    return y


def analyze(project_dir, stems):
    import librosa
    sr = 22050
    stems_dir = os.path.join(project_dir, "stems")
    mix = _load_mono(os.path.join(project_dir, "original.wav"), sr)
    duration = len(mix) / sr

    oenv = librosa.onset.onset_strength(y=mix, sr=sr, aggregate=np.median)
    # the drum part carries the beat far more clearly than the full mix
    dr = mix
    if "drums" in stems:
        dr = _load_mono(os.path.join(stems_dir, "drums.wav"), sr)
        if np.sqrt(np.mean(dr ** 2)) > 0.02 * (np.sqrt(np.mean(mix ** 2)) + 1e-9):
            denv = librosa.onset.onset_strength(y=dr, sr=sr, aggregate=np.median)
            m = min(len(oenv), len(denv))
            oenv = 0.75 * denv[:m] / (denv.max() + 1e-9) + 0.25 * oenv[:m] / (oenv.max() + 1e-9)
    dtempo = librosa.feature.tempo(onset_envelope=oenv, sr=sr, aggregate=None, std_bpm=4.0)
    _, beats = librosa.beat.beat_track(onset_envelope=oenv, sr=sr, bpm=dtempo, units="time")
    beats = clean_beats(beats)
    beats = refine_beats(beats, dr, sr)

    result = {"duration": duration, "beats": [], "bpm": None, "wobble": None}
    if len(beats) >= 8:
        period, _ = fit_grid(beats)
        local = 60.0 / np.diff(beats)
        result.update(beats=[round(float(b), 4) for b in beats],
                      bpm=round(60.0 / period, 1),
                      wobble=round(float(np.std(local)), 2))

    harmonic_names = [s for s in stems if s != "drums"]
    harm = None
    for s in harmonic_names:
        y = _load_mono(os.path.join(stems_dir, s + ".wav"), sr)
        harm = y if harm is None else harm[: len(y)] + y[: len(harm)]
    if harm is None:
        harm = mix
    try:
        chroma = librosa.feature.chroma_cqt(y=harm, sr=sr).mean(axis=1)
        best = None
        for tonic in range(12):
            for mode, prof in (("major", _MAJOR), ("minor", _MINOR)):
                c = np.corrcoef(chroma, np.roll(prof, tonic))[0, 1]
                if best is None or c > best[0]:
                    best = (c, tonic, mode)
        result["key"] = {"tonic": best[1], "mode": best[2], "name": key_name(best[1], best[2])}
    except Exception:
        result["key"] = None
    try:
        result["tuning_cents"] = int(round(float(librosa.estimate_tuning(y=harm, sr=sr)) * 100))
    except Exception:
        result["tuning_cents"] = 0
    return result


# --------------------------------------------------------------------------- warping

MIN_GAP = 0.05          # seconds between anchors
RATIO_LIMITS = (0.5, 2.0)


def global_anchors(analysis, target_bpm, steady):
    """Source->output time anchors for the whole song (every stem shares these)."""
    L = analysis["duration"]
    beats = np.asarray(analysis.get("beats") or [], dtype=float)
    if len(beats) < 8:
        return np.array([0.0, L]), np.array([0.0, L]), np.array([])
    period, offset = fit_grid(beats)
    src_bpm = 60.0 / period
    target = float(target_bpm or src_bpm)
    scale = src_bpm / target
    k = np.arange(len(beats))
    natural = beats * scale
    grid = offset * scale + k * (60.0 / target)
    d = natural + steady * (grid - natural)
    src = np.concatenate([[0.0], beats, [L]])
    dst = np.concatenate([[d[0] - beats[0] * scale], d, [d[-1] + (L - beats[-1]) * scale]])
    dst = dst - dst[0]
    return src, dst, dst[1:-1]


def subdivision_grid(out_beats, per_beat):
    pts = []
    for i in range(len(out_beats) - 1):
        a, b = out_beats[i], out_beats[i + 1]
        for j in range(per_beat):
            pts.append(a + (b - a) * j / per_beat)
    if len(out_beats):
        pts.append(out_beats[-1])
    return np.array(pts)


def tighten_anchors(stem_path, src, dst, out_beats, per_beat, strength):
    """Anchors that pull a stem's note onsets toward the nearest grid line."""
    import librosa
    if strength <= 0 or len(out_beats) < 2:
        return np.array([]), np.array([])
    sr = 22050
    y = _load_mono(stem_path, sr)
    hop = 128
    env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop, aggregate=np.median)
    onsets = librosa.onset.onset_detect(onset_envelope=env, sr=sr, hop_length=hop, units="time",
                                        backtrack=True, delta=0.1, wait=int(0.06 * sr / hop))
    if len(onsets) == 0:
        return np.array([]), np.array([])
    grid = subdivision_grid(out_beats, per_beat)
    step = np.median(np.diff(grid))
    w = np.interp(onsets, src, dst)
    idx = np.clip(np.searchsorted(grid, w), 1, len(grid) - 1)
    left, right = grid[idx - 1], grid[idx]
    q = np.where(np.abs(w - left) < np.abs(w - right), left, right)
    off = q - w
    keep = np.abs(off) < 0.35 * step  # far-off notes are probably intentional (triplets, pushes)
    return onsets[keep], (w + strength * off)[keep]


def merge_anchors(src, dst, extra_src, extra_dst):
    """Combine the song-wide anchors with a stem's onset anchors (which win on conflicts),
    then drop anchors until every segment has a sane, forward-moving stretch."""
    start, end = (src[0], dst[0], 2), (src[-1], dst[-1], 2)
    inner = [(s, d, 0) for s, d in zip(src[1:-1], dst[1:-1])]
    inner += [(s, d, 1) for s, d in zip(extra_src, extra_dst)
              if src[0] + MIN_GAP < s < src[-1] - MIN_GAP]
    inner.sort(key=lambda p: p[0])
    kept = [start]
    for p in inner:
        if p[0] - kept[-1][0] < MIN_GAP:
            if p[2] > kept[-1][2]:
                kept[-1] = p
            continue
        kept.append(p)
    if len(kept) > 1 and end[0] - kept[-1][0] < MIN_GAP:
        kept.pop()
    kept.append(end)
    while True:
        bad = None
        for i in range(1, len(kept)):
            ds, dd = kept[i][0] - kept[i - 1][0], kept[i][1] - kept[i - 1][1]
            if dd <= 0 or not (RATIO_LIMITS[0] <= ds / dd <= RATIO_LIMITS[1]):
                cand = [j for j in (i - 1, i) if kept[j][2] < 2]
                if cand:
                    bad = min(cand, key=lambda j: kept[j][2])
                break
        if bad is None:
            break
        del kept[bad]
    return np.array([p[0] for p in kept]), np.array([p[1] for p in kept])


def factor_array(src, dst, n, sr):
    """Per-input-sample speed factor for pedalboard.time_stretch."""
    f = np.ones(n, dtype=np.float64)
    for i in range(len(src) - 1):
        a, b = int(round(src[i] * sr)), int(round(src[i + 1] * sr))
        dd = dst[i + 1] - dst[i]
        if b > a and dd > 0:
            f[a:min(b, n)] = (src[i + 1] - src[i]) / dd
    return f


def calibrated_factor(src, dst, n, sr, pitch=0.0):
    """Rubber Band drifts a few ms per segment when the ratio keeps changing. Stretch a cheap
    click track with the same map, see where each anchor actually lands, and correct."""
    import pedalboard
    f = factor_array(src, dst, n, sr)
    pos = np.round(np.asarray(src[1:-1]) * sr).astype(int)
    if len(pos) == 0:
        return f
    for _ in range(3):
        clicks = np.zeros((1, n), np.float32)
        clicks[0, np.clip(pos, 0, n - 1)] = 1.0
        out = np.abs(pedalboard.time_stretch(clicks, sr, stretch_factor=f, pitch_shift_in_semitones=float(pitch),
                                             transient_mode="crisp")[0])
        want = np.asarray(dst[1:-1]) * sr
        got = np.empty(len(want))
        gaps = np.diff(np.concatenate([[0.0], want, [dst[-1] * sr]]))
        for i, e in enumerate(want):
            wl = int(min(0.45 * gaps[i], 0.15 * sr))
            wr = int(min(0.45 * gaps[i + 1], 0.15 * sr))
            a, b = max(0, int(e) - wl), min(len(out), int(e) + wr)
            got[i] = a + np.argmax(out[a:b]) if b > a else e
        got_all = np.concatenate([[0.0], got, [dst[-1] * sr]])
        want_all = np.concatenate([[0.0], want, [dst[-1] * sr]])
        if np.max(np.abs(got - want)) < 0.002 * sr:
            break
        for i in range(len(src) - 1):
            a, b = int(round(src[i] * sr)), int(round(src[i + 1] * sr))
            actual, desired = got_all[i + 1] - got_all[i], want_all[i + 1] - want_all[i]
            if b > a and actual > 0 and desired > 0:
                f[a:min(b, n)] *= np.clip(actual / desired, 0.8, 1.25)
    return f


def is_identity(src, dst):
    return np.allclose(src, dst, atol=1e-4)


def process_stem(in_path, out_path, src, dst, pitch, out_len, factor_for):
    import pedalboard
    audio, sr = audio_io.read(in_path)
    n = audio.shape[1]
    if is_identity(src, dst) and abs(pitch) < 1e-3:
        out = audio
    else:
        factor = 1.0 if is_identity(src, dst) else factor_for(src, dst, n, sr, pitch)
        out = pedalboard.time_stretch(
            audio, sr, stretch_factor=factor, pitch_shift_in_semitones=float(pitch),
            high_quality=True, transient_mode="crisp", preserve_formants=True)
    m = int(round(out_len * sr))
    if out.shape[1] < m:
        out = np.pad(out, ((0, 0), (0, m - out.shape[1])))
    audio_io.write(out_path, out[:, :m].astype(np.float32), sr)


def render(project_dir, project, settings, progress_cb):
    analysis = project["analysis"]
    stems = project["stems"]
    target_bpm = settings.get("target_bpm") or None
    steady = float(settings.get("steady", 0))
    per_beat = int(settings.get("grid", 4))
    tighten = settings.get("tighten", {}) or {}
    pitch = float(settings.get("transpose", 0))
    if settings.get("fix_tuning"):
        pitch -= (analysis.get("tuning_cents") or 0) / 100.0
    skip_pitch = set(settings.get("pitch_skip", ["drums"]))

    src, dst, out_beats = global_anchors(analysis, target_bpm, steady)
    out_len = float(dst[-1])
    stems_dir = os.path.join(project_dir, "stems")
    render_dir = os.path.join(project_dir, "render")
    os.makedirs(render_dir, exist_ok=True)

    progress_cb(0.02, "Finding note timings")
    jobs = []
    for s in stems:
        path = os.path.join(stems_dir, s + ".wav")
        es, ed = tighten_anchors(path, src, dst, out_beats, per_beat, float(tighten.get(s, 0)))
        s_src, s_dst = merge_anchors(src, dst, es, ed)
        jobs.append((s, path, s_src, s_dst))

    done = [0]
    cache, lock = {}, threading.Lock()

    def factor_for(a, b, n, sr, p):
        key = (a.tobytes(), b.tobytes(), n, round(p, 3))
        with lock:
            if key not in cache:
                cache[key] = calibrated_factor(a, b, n, sr, p)
            return cache[key]

    def work(job):
        s, path, s_src, s_dst = job
        process_stem(path, os.path.join(render_dir, s + ".wav"), s_src, s_dst,
                     0.0 if s in skip_pitch else pitch, out_len, factor_for)
        done[0] += 1
        progress_cb(0.1 + 0.9 * done[0] / len(jobs), f"Rendered {done[0]} of {len(jobs)} parts")

    workers = max(1, min(3, (os.cpu_count() or 2) // 2))
    progress_cb(0.1, "Rendering parts")
    with ThreadPoolExecutor(workers) as ex:
        list(ex.map(work, jobs))

    key = analysis.get("key")
    shift = int(round(settings.get("transpose", 0)))
    return {
        "settings": settings,
        "duration": out_len,
        "bpm": round(float(target_bpm), 1) if target_bpm else analysis.get("bpm"),
        "key": key_name(key["tonic"], key["mode"], shift) if key else None,
        "beats": [round(float(b), 4) for b in out_beats],
        "time_map": {"src": [round(float(x), 4) for x in src], "dst": [round(float(x), 4) for x in dst]},
    }


# --------------------------------------------------------------------------- export

def export(project_dir, project, req, progress_cb):
    version = req.get("version", "render")
    folder = os.path.join(project_dir, "render" if version == "render" else "stems")
    fmt = req.get("format", "wav")
    paths = req.get("_paths") or {}
    dest = req["dest_dir"]
    os.makedirs(dest, exist_ok=True)
    allowed = list(project["stems"]) + list(req.get("_extra") or [])
    stems = [s for s in req.get("stems", project["stems"]) if s in allowed]
    if not stems:
        raise ValueError("Pick at least one part to export.")
    base = _safe(project.get("title") or "song")
    suffix = " (edited)" if version == "render" else ""
    written = []
    if req.get("mode") == "mix":
        vols = req.get("volumes", {})
        mix = None
        for i, s in enumerate(stems):
            a, sr = audio_io.read(paths.get(s) or os.path.join(folder, s + ".wav"))
            a = a * float(vols.get(s, 1.0))
            mix = a if mix is None else mix[:, : a.shape[1]] + a[:, : mix.shape[1]]
            progress_cb(0.6 * (i + 1) / len(stems), "Mixing")
        peak = float(np.max(np.abs(mix))) if mix is not None else 0
        if peak > 0.99:
            mix = mix * (0.99 / peak)
        label = "mix" if set(project["stems"]) <= set(stems) else " + ".join(stems)
        tmp = os.path.join(project_dir, "_export_tmp.wav")
        audio_io.write(tmp, mix.astype(np.float32), sr)
        out = _unique(os.path.join(dest, f"{base}{suffix} - {label}.{fmt}"))
        audio_io.encode(tmp, out, fmt)
        os.remove(tmp)
        written.append(out)
    else:
        for i, s in enumerate(stems):
            out = _unique(os.path.join(dest, f"{base}{suffix} - {s}.{fmt}"))
            audio_io.encode(paths.get(s) or os.path.join(folder, s + ".wav"), out, fmt)
            written.append(out)
            progress_cb((i + 1) / len(stems), f"Saved {s}")
    return {"files": written, "folder": dest}


def _safe(name):
    return "".join(c for c in name if c not in '<>:"/\\|?*').strip()[:120] or "song"


def _unique(path):
    if not os.path.exists(path):
        return path
    root, ext = os.path.splitext(path)
    i = 2
    while os.path.exists(f"{root} ({i}){ext}"):
        i += 1
    return f"{root} ({i}){ext}"

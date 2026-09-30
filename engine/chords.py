"""Chord recognition: which chord is playing on each beat, for the whole song or one part."""
import numpy as np

QUALITIES = [  # suffix, intervals, preference weight
    ("", (0, 4, 7), 1.00),
    ("m", (0, 3, 7), 1.00),
    ("7", (0, 4, 7, 10), 0.94),
    ("maj7", (0, 4, 7, 11), 0.93),
    ("m7", (0, 3, 7, 10), 0.94),
    ("sus4", (0, 5, 7), 0.9),
    ("dim", (0, 3, 6), 0.86),
]
SHARPS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
FLATS = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]


def use_flats(key):
    if not key:
        return False
    t, mode = key["tonic"], key["mode"]
    return t in ((5, 10, 3, 8, 1, 6) if mode == "major" else (2, 7, 0, 5, 10, 3))


def _templates():
    names, mats, weights = [], [], []
    for root in range(12):
        for q, ivs, w in QUALITIES:
            v = np.zeros(12)
            for i in ivs:
                v[(root + i) % 12] = 1.0
            v[root] += 0.5  # the root usually rings strongest
            names.append((root, q))
            mats.append(v / np.linalg.norm(v))
            weights.append(w)
    return names, np.array(mats), np.array(weights)


NAMES, TEMPL, WEIGHTS = _templates()


def name(root, q, flats=False):
    return (FLATS if flats else SHARPS)[root % 12] + q


def detect(y, sr, beats, key=None, change_penalty=0.35):
    """y: mono audio. beats: beat times in seconds (may be empty).
    Returns (segments, confidence) where segments = [{start, end, chord}] and chord 'N' = none."""
    import librosa
    hop = 512
    dur = len(y) / sr
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=hop, bins_per_octave=36)
    rms = librosa.feature.rms(y=y, hop_length=hop)[0][: chroma.shape[1]]
    if len(beats) >= 8:
        # two chord slots per beat catches quick changes without flicker
        b = np.asarray(beats)
        half = (b[:-1] + b[1:]) / 2
        bounds = np.unique(np.concatenate([[0.0], np.sort(np.concatenate([b, half])), [dur]]))
    else:
        bounds = np.arange(0, dur + 0.5, 0.5)
    frames = librosa.time_to_frames(bounds, sr=sr, hop_length=hop)
    frames = np.clip(frames, 0, chroma.shape[1])
    n = len(bounds) - 1
    feats = np.zeros((n, 12))
    energy = np.zeros(n)
    for i in range(n):
        a, e = frames[i], max(frames[i] + 1, frames[i + 1])
        seg = chroma[:, a:e]
        if seg.size:
            feats[i] = np.median(seg, axis=1)
            energy[i] = float(np.mean(rms[a:e])) if e <= len(rms) else 0.0
    norms = np.linalg.norm(feats, axis=1, keepdims=True) + 1e-9
    scores = (feats / norms) @ TEMPL.T * WEIGHTS  # (n, 84)
    quiet = energy < 0.06 * (np.percentile(energy, 95) + 1e-9)

    # Viterbi: staying on a chord is free, changing costs a little; 'N' (no chord) for silence
    k = scores.shape[1]
    obs = np.concatenate([scores, np.where(quiet, 1.0, 0.2)[:, None]], axis=1)
    cost = np.zeros(k + 1)
    back = np.zeros((n, k + 1), dtype=np.int32)
    prev = obs[0].copy()
    for i in range(1, n):
        best = int(np.argmax(prev))
        stay = prev
        move = prev[best] - change_penalty
        take_move = move > stay
        back[i] = np.where(take_move, best, np.arange(k + 1))
        prev = np.where(take_move, move, stay) + obs[i]
    path = np.zeros(n, dtype=np.int32)
    path[-1] = int(np.argmax(prev))
    for i in range(n - 1, 0, -1):
        path[i - 1] = back[i, path[i]]

    flats = use_flats(key)
    segs = []
    for i in range(n):
        c = "N" if path[i] == k else name(*NAMES[path[i]], flats)
        if segs and segs[-1]["chord"] == c:
            segs[-1]["end"] = float(bounds[i + 1])
        else:
            segs.append({"start": round(float(bounds[i]), 3), "end": round(float(bounds[i + 1]), 3), "chord": c})
    voiced = path != k
    conf = float(np.mean(scores[np.arange(n), np.minimum(path, k - 1)][voiced])) if voiced.any() else 0.0
    # drop blips shorter than half a beat by merging them into the previous chord
    period = float(np.median(np.diff(beats))) if len(beats) >= 8 else 0.5
    out = []
    for s in segs:
        if out and s["end"] - s["start"] < period * 0.6 and s["chord"] != "N":
            out[-1]["end"] = s["end"]
        elif out and out[-1]["chord"] == s["chord"]:
            out[-1]["end"] = s["end"]
        else:
            out.append(dict(s))
    for i, s in enumerate(out):
        s["id"] = f"c{i}"
    return out, conf


def transpose_name(ch, semis, flats=False):
    if ch == "N" or not ch:
        return ch
    root = ch[:2] if len(ch) > 1 and ch[1] in "#b" else ch[:1]
    rest = ch[len(root):]
    table = SHARPS if root in SHARPS else FLATS
    if root not in table:
        return ch
    return (FLATS if flats else SHARPS)[(table.index(root) + semis) % 12] + rest

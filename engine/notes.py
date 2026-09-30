"""Turning a part into notes, and rendering note edits back into audio.

Works best on parts that play one note at a time (vocals, bass, lead guitar). Each detected
note remembers where its sound lives in the audio, so a moved, stretched or added note is made
from real recorded sound pitch-shifted to the new note.
"""
import os
import uuid

import numpy as np

import audio_io

RANGES = {  # (lowest, highest) Hz to search per part
    "bass": (30.0, 420.0),
    "vocals": (65.0, 1200.0),
    "guitar": (70.0, 1400.0),
    "piano": (27.5, 2100.0),
    "other": (50.0, 1600.0),
}
SR = 22050
HOP = 256


def detect(path, stem, progress_cb):
    import librosa
    y, _ = librosa.load(path, sr=SR, mono=True)
    fmin, fmax = RANGES.get(stem, (50.0, 1600.0))
    chunk = HOP * 2000  # ~23 s per chunk keeps memory flat and gives progress
    f0_parts, voiced_parts = [], []
    starts = list(range(0, max(1, len(y)), chunk))
    for i, s in enumerate(starts):
        seg = y[s: s + chunk]
        if len(seg) < 4096:
            seg = np.pad(seg, (0, 4096 - len(seg)))
        f0, voiced, _ = librosa.pyin(seg, fmin=fmin, fmax=fmax, sr=SR, frame_length=2048,
                                     hop_length=HOP, center=True)
        n_frames = int(np.ceil(min(chunk, len(y) - s) / HOP))
        f0_parts.append(f0[:n_frames])
        voiced_parts.append(voiced[:n_frames])
        progress_cb(0.9 * (i + 1) / len(starts), "Listening for notes")
    f0 = np.concatenate(f0_parts)
    voiced = np.concatenate(voiced_parts)
    rms = librosa.feature.rms(y=y, frame_length=2048, hop_length=HOP)[0][: len(f0)]
    if len(rms) < len(f0):
        rms = np.pad(rms, (0, len(f0) - len(rms)))
    loud = rms > 0.08 * (np.percentile(rms, 98) + 1e-9)
    onsets = set(librosa.onset.onset_detect(y=y, sr=SR, hop_length=HOP, backtrack=True).tolist())

    midi = librosa.hz_to_midi(np.where(voiced, f0, np.nan))
    notes = []
    cur = []

    def close():
        if len(cur) * HOP / SR >= 0.07:
            m = np.array([midi[k] for k in cur])
            med = float(np.median(m))
            start = cur[0] * HOP / SR
            end = (cur[-1] + 1) * HOP / SR
            notes.append({
                "id": uuid.uuid4().hex[:8],
                "start": round(start, 4), "end": round(end, 4), "midi": int(round(med)),
                "orig_start": round(start, 4), "orig_end": round(end, 4), "orig_midi": int(round(med)),
                "cents": int(round((med - round(med)) * 100)),
                "level": round(float(np.mean(rms[cur[0]: cur[-1] + 1])), 5),
            })
        cur.clear()

    for k in range(len(f0)):
        ok = bool(voiced[k]) and bool(loud[k]) and not np.isnan(midi[k])
        if not ok:
            if cur:
                close()
            continue
        if cur:
            ref = float(np.median([midi[j] for j in cur[-6:]]))
            if abs(midi[k] - ref) > 0.7 or (k in onsets and len(cur) > 3):
                close()
        cur.append(k)
    if cur:
        close()
    top = max([n["level"] for n in notes] or [1.0])
    for n in notes:
        n["level"] = round(n["level"] / top, 3)
    progress_cb(1.0, "Done")
    return notes


# --------------------------------------------------------------------------- rendering edits

PRE = 0.006    # seconds of lead-in kept before a note's detected start
TAIL = 0.035   # seconds of release kept after its end
FADE = 0.008


def _fade(seg, sr):
    n = seg.shape[1]
    f = min(int(FADE * sr), n // 2)
    if f > 1:
        ramp = np.linspace(0.0, 1.0, f, dtype=np.float32)
        seg[:, :f] *= ramp
        seg[:, n - f:] *= ramp[::-1]
    return seg


def _changed(n):
    return (n.get("src") is not None or n["midi"] != n["orig_midi"]
            or abs(n["start"] - n["orig_start"]) > 1e-3 or abs(n["end"] - n["orig_end"]) > 1e-3)


def render(base_path, out_path, detected, notes):
    """detected: the notes as originally found. notes: the edited list. Added notes carry
    'src' (the id of the note whose sound they reuse)."""
    import pedalboard
    audio, sr = audio_io.read(base_path)
    n_samples = audio.shape[1]
    out = audio.copy()
    by_id = {n["id"]: n for n in detected}
    kept_ids = {n["id"] for n in notes if n.get("src") is None}

    # 1. clear the original sound of every note that was deleted, moved, resized or re-pitched
    gain = np.ones(n_samples, dtype=np.float32)
    to_clear = [by_id[i] for i in by_id if i not in kept_ids]
    to_clear += [n for n in notes if n.get("src") is None and _changed(n)]
    f = int(FADE * sr)
    for n in to_clear:
        a = max(0, int((n["orig_start"] - PRE) * sr))
        b = min(n_samples, int((n["orig_end"] + TAIL) * sr))
        if b <= a:
            continue
        gain[a:b] = 0.0
        lo = max(0, a - f)
        gain[lo:a] = np.minimum(gain[lo:a], np.linspace(1, 0, a - lo, dtype=np.float32))
        hi = min(n_samples, b + f)
        gain[b:hi] = np.minimum(gain[b:hi], np.linspace(0, 1, hi - b, dtype=np.float32))
    out *= gain

    # 2. place the new sound for every changed or added note
    for n in notes:
        if n.get("src") is None and not _changed(n):
            continue
        src = by_id.get(n["src"]) if n.get("src") is not None else by_id.get(n["id"])
        if not src:
            continue
        a = max(0, int((src["orig_start"] - PRE) * sr))
        b = min(n_samples, int((src["orig_end"] + TAIL) * sr))
        if b - a < 64:
            continue
        seg = _fade(audio[:, a:b].copy(), sr)
        src_len = src["orig_end"] - src["orig_start"]
        new_len = max(0.03, n["end"] - n["start"])
        stretch = float(np.clip(src_len / new_len, 0.25, 4.0))  # >1 = shorter
        semis = float(n["midi"] - src["orig_midi"])
        if abs(stretch - 1) > 1e-3 or abs(semis) > 1e-3:
            seg = pedalboard.time_stretch(seg, sr, stretch_factor=stretch,
                                          pitch_shift_in_semitones=semis, high_quality=True,
                                          transient_mode="crisp", preserve_formants=True)
        seg = _fade(seg, sr)
        at = int((n["start"] - PRE) * sr)
        lo, hi = max(0, at), min(n_samples, at + seg.shape[1])
        if hi > lo:
            out[:, lo:hi] += seg[:, lo - at: hi - at]
    peak = float(np.max(np.abs(out)))
    if peak > 1.0:
        out /= peak
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    audio_io.write(out_path, out.astype(np.float32), sr)

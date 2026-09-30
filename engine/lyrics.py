"""Lyrics: transcribe the vocal part with Whisper, keeping the time of every word."""
import os

import numpy as np

MODEL = "small"


def transcribe(vocals_path, model_dir, progress_cb):
    import librosa
    y, sr = librosa.load(vocals_path, sr=16000, mono=True)
    if len(y) == 0 or float(np.sqrt(np.mean(y ** 2))) < 0.004:
        return {"lines": [], "note": "This song doesn't seem to have vocals."}
    from faster_whisper import WhisperModel
    progress_cb(0.02, "Loading the lyrics model (first time downloads it)")
    try:
        model = WhisperModel(MODEL, device="cpu", compute_type="int8", download_root=model_dir)
    except Exception as e:
        raise RuntimeError("Couldn't download the lyrics model. Check your internet connection, then try again.") from e
    progress_cb(0.1, "Listening for lyrics")
    segments, info = model.transcribe(
        y.astype(np.float32), word_timestamps=True, vad_filter=True, beam_size=5,
        condition_on_previous_text=False, no_speech_threshold=0.5)
    total = len(y) / 16000.0
    lines = []
    for seg in segments:
        words = [{"text": w.word.strip(), "start": round(float(w.start), 3), "end": round(float(w.end), 3)}
                 for w in (seg.words or []) if w.word.strip()]
        if not words:
            continue
        # break long segments into sung-line-sized pieces at pauses
        cur = []
        for w in words:
            if cur and (w["start"] - cur[-1]["end"] > 0.7 or len(cur) >= 12):
                lines.append(cur)
                cur = []
            cur.append(w)
        if cur:
            lines.append(cur)
        progress_cb(0.1 + 0.9 * min(1.0, seg.end / total), "Listening for lyrics")
    out = []
    for i, ws in enumerate(lines):
        out.append({"id": f"l{i}", "start": ws[0]["start"], "end": ws[-1]["end"], "words": ws})
    return {"lines": out, "language": getattr(info, "language", None)}


def retime_line(line, text):
    """The person edited a line's text: keep its start and end, spread new words across it,
    re-using the old word times where the word count matches."""
    words = text.split()
    if not words:
        return {**line, "words": []}
    old = line.get("words") or []
    if len(old) == len(words):
        return {**line, "words": [{**o, "text": w} for o, w in zip(old, words)]}
    a, b = float(line["start"]), float(line["end"])
    weights = np.array([len(w) + 1 for w in words], dtype=float)
    edges = a + (b - a) * np.concatenate([[0], np.cumsum(weights)]) / weights.sum()
    return {**line, "words": [{"text": w, "start": round(float(edges[i]), 3), "end": round(float(edges[i + 1]), 3)}
                              for i, w in enumerate(words)]}

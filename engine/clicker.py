"""The clicker: a metronome click on every detected beat, with an accent on each bar's first beat."""
import numpy as np

SR = 44100


def _click(freq, length, gain):
    n = int(length * SR)
    t = np.arange(n) / SR
    tone = np.sin(2 * np.pi * freq * t) + 0.35 * np.sin(2 * np.pi * freq * 2.01 * t)
    env = np.exp(-t * 90.0)
    env[: int(0.0015 * SR)] *= np.linspace(0, 1, int(0.0015 * SR))
    return (tone * env * gain).astype(np.float32)


ACCENT = _click(2000.0, 0.06, 0.55)
NORMAL = _click(1400.0, 0.05, 0.38)


def guess_downbeat(beats, drums_path, per_bar):
    """Which beat starts a bar: the phase where the low end (kick drum) hits hardest."""
    if not drums_path or len(beats) < per_bar * 2:
        return 0
    try:
        import librosa
        y, sr = librosa.load(drums_path, sr=11025, mono=True)
        from scipy.signal import butter, sosfilt
        low = np.abs(sosfilt(butter(4, 150, btype="low", fs=sr, output="sos"), y))
        w = int(0.05 * sr)
        energy = np.array([low[int(b * sr): int(b * sr) + w].mean() if int(b * sr) + w < len(low) else 0.0
                           for b in beats])
        scores = [energy[k::per_bar].mean() for k in range(per_bar)]
        return int(np.argmax(scores))
    except Exception:
        return 0


def render(beats, duration, per_bar=4, offset=0):
    n = int((duration + 0.2) * SR)
    out = np.zeros(n, dtype=np.float32)
    for i, b in enumerate(beats):
        c = ACCENT if (i - offset) % per_bar == 0 else NORMAL
        a = int(b * SR)
        e = min(n, a + len(c))
        if 0 <= a < n:
            out[a:e] += c[: e - a]
    return np.stack([out, out])

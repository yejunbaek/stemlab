"""A small built-in synthesizer. Renders a list of notes to audio with one of a few sounds.

Oscillators are band-limited (polyBLEP) so high notes don't alias; each preset is a recipe of
oscillators, envelopes, a filter and a touch of effects.
"""
import numpy as np
from scipy.signal import butter, sosfilt

SR = 44100

PRESETS = {
    "lead":   {"label": "Lead",          "desc": "Bright singing lead, good for melodies"},
    "pluck":  {"label": "Pluck",         "desc": "Short plucked sound, good for riffs and arps"},
    "keys":   {"label": "Electric keys", "desc": "Soft electric piano"},
    "pad":    {"label": "Pad",           "desc": "Slow, wide and warm, good for chords"},
    "bass":   {"label": "Synth bass",    "desc": "Deep and punchy"},
    "square": {"label": "Retro square",  "desc": "Chiptune-style square wave"},
}


def hz(midi):
    return 440.0 * 2.0 ** ((midi - 69) / 12.0)


def _blep(t, dt):
    dt = np.broadcast_to(dt, t.shape)
    out = np.zeros_like(t)
    a = t < dt
    x = t[a] / dt[a]
    out[a] = x + x - x * x - 1.0
    b = t > 1.0 - dt
    x = (t[b] - 1.0) / dt[b]
    out[b] = x * x + x + x + 1.0
    return out


def saw(freq, n, phase0=0.0, vib=None):
    f = np.full(n, freq) if vib is None else freq * vib
    dt = f / SR
    ph = (phase0 + np.cumsum(dt)) % 1.0
    return 2.0 * ph - 1.0 - _blep(ph, dt)


def square(freq, n, phase0=0.0, width=0.5, vib=None):
    f = np.full(n, freq) if vib is None else freq * vib
    dt = f / SR
    ph = (phase0 + np.cumsum(dt)) % 1.0
    s = np.where(ph < width, 1.0, -1.0) + _blep(ph, dt) - _blep((ph + 1.0 - width) % 1.0, dt)
    return s


def sine(freq, n, phase0=0.0, fm=None):
    t = np.arange(n) / SR
    arg = 2 * np.pi * freq * t + phase0
    if fm is not None:
        arg = arg + fm
    return np.sin(arg)


def adsr(n, rel_n, a, d, s, r):
    """Envelope over the held length n plus release rel_n samples."""
    env = np.empty(n + rel_n)
    an, dn = max(1, int(a * SR)), max(1, int(d * SR))
    idx = np.arange(n)
    held = np.where(idx < an, idx / an,
                    np.where(idx < an + dn, 1.0 - (1.0 - s) * (idx - an) / dn, s))
    env[:n] = held
    last = held[-1] if n else 0.0
    rt = np.arange(rel_n)
    env[n:] = last * np.exp(-rt / max(1.0, r * SR / 5.0))
    return env


def lowpass(x, cutoff, order=2):
    cutoff = float(np.clip(cutoff, 40.0, SR * 0.45))
    sos = butter(order, cutoff, btype="low", fs=SR, output="sos")
    return sosfilt(sos, x)


def voice(preset, midi, length, vel):
    f = hz(midi)
    held = max(1, int(length * SR))
    rng = np.random.default_rng(int(midi * 997 + length * 1000))
    if preset == "lead":
        rel = int(0.18 * SR); n = held + rel
        t = np.arange(n) / SR
        vib = 1.0 + 0.004 * np.sin(2 * np.pi * 5.5 * t) * np.clip((t - 0.25) / 0.3, 0, 1)
        x = 0.55 * saw(f, n, vib=vib) + 0.45 * saw(f * 1.004, n, 0.3, vib=vib)
        x = lowpass(x, min(9000, f * 9 + 1200))
        env = adsr(held, rel, 0.012, 0.15, 0.8, 0.18)
    elif preset == "pluck":
        rel = int(0.25 * SR); n = held + rel
        x = saw(f, n) + 0.5 * square(f, n, width=0.3)
        bright = lowpass(x, min(12000, f * 14))
        dark = lowpass(x, min(1500, f * 2.2))
        k = np.exp(-np.arange(n) / (0.09 * SR))
        x = bright * k + dark * (1 - k)
        env = adsr(held, rel, 0.002, 0.35, 0.25, 0.25)
    elif preset == "keys":
        rel = int(0.5 * SR); n = held + rel
        t = np.arange(n) / SR
        idx = 2.2 * np.exp(-t * 3.0) + 0.3
        mod = idx * np.sin(2 * np.pi * f * 1.0 * t)
        x = sine(f, n, fm=mod) + 0.12 * sine(f * 4.0, n) * np.exp(-t * 9)
        env = adsr(held, rel, 0.004, 1.2, 0.35, 0.5)
    elif preset == "pad":
        rel = int(0.9 * SR); n = held + rel
        x = sum(saw(f * d, n, rng.random()) for d in (0.993, 0.998, 1.0, 1.003, 1.008)) / 3.0
        x = lowpass(x, min(4000, f * 4 + 600))
        env = adsr(held, rel, 0.35, 0.4, 0.85, 0.9)
    elif preset == "bass":
        rel = int(0.08 * SR); n = held + rel
        x = 0.7 * saw(f, n) + 0.9 * sine(f, n) + 0.3 * square(f, n)
        bright = lowpass(x, min(3500, f * 10))
        dark = lowpass(x, min(700, f * 3))
        k = np.exp(-np.arange(n) / (0.06 * SR))
        x = bright * k + dark * (1 - k)
        env = adsr(held, rel, 0.003, 0.2, 0.75, 0.08)
    else:  # square
        rel = int(0.05 * SR); n = held + rel
        x = square(f, n, width=0.5) * 0.7 + square(f * 2.0, n, width=0.25) * 0.15
        env = adsr(held, rel, 0.002, 0.05, 0.85, 0.05)
    return (x * env * vel).astype(np.float32)


def render(notes, preset, duration):
    """notes: [{start, end, midi, vel?}] in seconds. Returns stereo float32 (2, samples)."""
    n_total = int((max([duration] + [nt["end"] + 1.5 for nt in notes])) * SR)
    mono = np.zeros(n_total, dtype=np.float32)
    for nt in notes:
        length = max(0.03, float(nt["end"]) - float(nt["start"]))
        v = voice(preset, int(nt["midi"]), length, float(nt.get("vel", 0.8)))
        a = int(float(nt["start"]) * SR)
        b = min(n_total, a + len(v))
        if b > a:
            mono[a:b] += v[: b - a]
    # stereo width + light effects per sound
    import pedalboard as pb
    stereo = np.stack([mono, mono])
    fx = {
        "lead": [pb.Chorus(rate_hz=0.8, depth=0.15, mix=0.25), pb.Delay(delay_seconds=0.32, feedback=0.25, mix=0.12),
                 pb.Reverb(room_size=0.35, wet_level=0.12, dry_level=0.9)],
        "pluck": [pb.Delay(delay_seconds=0.24, feedback=0.3, mix=0.15), pb.Reverb(room_size=0.4, wet_level=0.15, dry_level=0.9)],
        "keys": [pb.Chorus(rate_hz=0.6, depth=0.2, mix=0.3), pb.Reverb(room_size=0.45, wet_level=0.18, dry_level=0.9)],
        "pad": [pb.Chorus(rate_hz=0.3, depth=0.4, mix=0.5), pb.Reverb(room_size=0.8, wet_level=0.35, dry_level=0.8)],
        "bass": [pb.Compressor(threshold_db=-14, ratio=3)],
        "square": [pb.Reverb(room_size=0.25, wet_level=0.08, dry_level=0.95)],
    }[preset if preset in PRESETS else "lead"]
    out = pb.Pedalboard(fx)(stereo, SR)[:, :n_total]
    gain = {"lead": 0.45, "pluck": 0.3, "keys": 0.22, "pad": 0.5, "bass": 0.65, "square": 0.14}
    out = out * gain.get(preset, 0.45)
    peak = float(np.max(np.abs(out))) if out.size else 0.0
    if peak > 0.97:
        out = out * (0.97 / peak)
    return out.astype(np.float32)

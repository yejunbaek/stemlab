"""Clean up split parts after the AI splitter has run.

The splitter's own output can smear the top end (so it sounds less crisp), leave other
instruments faintly in the background, and flip a held note between two parts (a guitar chord
that jumps into "piano" for a moment and back). This rebuilds every part from the original song
instead:

* each part becomes a share of the original recording, frequency by frequency, so it keeps the
  recording's real detail and all the parts still add up exactly to the song;
* instruments that get confused with each other (guitar, piano, everything else) are kept
  consistent over short stretches of time, so a note stays in one part;
* "isolation" sets how strictly each part keeps out everything else: more isolation means less
  background, at the cost of a slightly thinner sound;
* rumble below an instrument's lowest note (bass and kick leaking into guitar or vocals) is handed
  to the part it belongs to.
"""
import numpy as np

import audio_io

N_FFT = 4096
HOP = 1024
BLOCK_S = 60.0          # process in one-minute blocks so long songs don't need lots of memory
OVERLAP_S = 3.0
PUMP_FRAMES = 3          # ~70 ms
CONFUSABLE = ("guitar", "piano", "other")   # parts the splitter mixes up with each other
LOWEST_HZ = {"guitar": 70.0, "vocals": 70.0, "piano": 0.0, "other": 0.0, "bass": 0.0, "drums": 0.0}


def _stft(x):
    import librosa
    return librosa.stft(x, n_fft=N_FFT, hop_length=HOP, window="hann", center=True)


def _istft(X, length):
    import librosa
    return librosa.istft(X, hop_length=HOP, window="hann", center=True, length=length)


def _smooth_time(a, frames):
    """Moving average along time (axis 1)."""
    if frames <= 1:
        return a
    from scipy.ndimage import uniform_filter1d
    return uniform_filter1d(a, size=frames, axis=1, mode="nearest")


def _masks(powers, names, sr, isolation, steady_s):
    """powers: dict part -> (bins, frames) power. Returns dict part -> mask; masks sum to 1."""
    eps = 1e-10
    freqs = np.linspace(0, sr / 2, N_FFT // 2 + 1)
    P = {n: powers[n].astype(np.float32) for n in names}

    # rumble below an instrument's range belongs to the parts that can play that low
    for n in names:
        lo = LOWEST_HZ.get(n, 0.0)
        if lo > 0:
            P[n][freqs < lo, :] *= 0.02

    # Guitar, piano and "everything else" are treated as one group against drums, bass and
    # vocals: isolation is strict between them (that's where background bleed comes from)...
    group = [n for n in names if n in CONFUSABLE]
    solo = [n for n in names if n not in CONFUSABLE]
    alpha = 1.0 + float(isolation)
    units = {n: P[n] for n in solo}
    if group:
        units["_group"] = sum(P[n] for n in group)
    # a touch of smoothing over time so a drum hit doesn't duck the guitar for an instant
    W = {k: np.power(_smooth_time(v, PUMP_FRAMES) + eps, alpha) for k, v in units.items()}
    total = sum(W.values()) + eps
    masks = {n: W[n] / total for n in solo}
    if group:
        gmask = W["_group"] / total
        # ...while inside the group, shares are averaged over a short stretch of time so a held
        # note stays in one part instead of flickering between guitar and piano
        frames = max(1, int(round(steady_s * sr / HOP)))
        Gp = units["_group"] + eps
        Gs = _smooth_time(Gp, frames) + eps
        sh = {n: _smooth_time(P[n], frames) / Gs for n in group}
        # isolation within the group too, applied to the smoothed shares so it can't flicker
        sh = {n: np.power(v + eps, alpha) for n, v in sh.items()}
        tot = sum(sh.values()) + eps
        for n in group:
            masks[n] = gmask * sh[n] / tot
    return masks


def refine(mix_path, stem_paths, out_paths, isolation=0.5, steady_s=0.4, progress_cb=None):
    """mix_path: the original song. stem_paths / out_paths: dict part -> wav path.
    Works through the song in one-minute blocks that overlap and cross-fade, so memory use stays
    small however long the song is."""
    import os
    import soundfile as sf
    names = list(stem_paths)
    mix_path = audio_io.current(mix_path)
    stem_paths = {n: audio_io.current(p) for n, p in stem_paths.items()}
    info = sf.info(mix_path)
    sr, N = info.samplerate, info.frames
    block = int(BLOCK_S * sr)
    ov = int(OVERLAP_S * sr)
    h = ov // 2
    fade = np.linspace(0.0, 1.0, 2 * h, dtype=np.float32)[:, None]
    ins = {n: sf.SoundFile(p) for n, p in stem_paths.items()}
    mixf = sf.SoundFile(mix_path)
    tmp = {n: out_paths[n] + ".refine.tmp.wav" for n in names}
    outs = {n: sf.SoundFile(tmp[n], "w", samplerate=sr, channels=2, subtype="PCM_16") for n in names}

    def read(f, a, b, ch):
        f.seek(a)
        x = f.read(b - a, dtype="float32", always_2d=True)
        if x.shape[1] == 1:
            x = np.repeat(x, 2, axis=1)
        if x.shape[0] < b - a:
            x = np.pad(x, ((0, b - a - x.shape[0]), (0, 0)))
        return x[:, :ch]

    try:
        pos, tails, s = 0, None, 0
        while s < N:
            e = s + block
            if N - e < 2 * ov:          # don't leave a tiny last block
                e = N
            a, b = max(0, s - ov), min(N, e + ov)
            mix = read(mixf, a, b, 2)
            parts = {n: read(ins[n], a, b, 2) for n in names}
            y = {n: np.zeros_like(mix) for n in names}
            for ch in range(2):
                X = _stft(mix[:, ch])
                powers = {n: np.abs(_stft(parts[n][:, ch])) ** 2 for n in names}
                masks = _masks(powers, names, sr, isolation, steady_s)
                for n in names:
                    y[n][:, ch] = _istft(masks[n] * X, length=b - a)
            cut = e - h if e < N else N
            for n in names:
                if tails is not None:                      # cross-fade into this block
                    seg = y[n][pos - a: pos - a + 2 * h]
                    outs[n].write(np.clip(tails[n] * (1 - fade) + seg * fade, -1, 1))
                start = pos + (2 * h if tails is not None else 0)
                outs[n].write(np.clip(y[n][start - a: cut - a], -1, 1))
            if e < N:
                tails = {n: y[n][cut - a: cut - a + 2 * h].copy() for n in names}
                pos = cut
            s = e
            if progress_cb:
                progress_cb(min(1.0, e / N), "Cleaning up the parts")
    finally:
        mixf.close()
        for f in list(ins.values()) + list(outs.values()):
            f.close()
    for n in names:
        data, _ = sf.read(tmp[n], dtype="float32", always_2d=True)
        audio_io.write(out_paths[n], data.T, sr)
        os.remove(tmp[n])

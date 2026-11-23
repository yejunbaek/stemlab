"""Split one guitar part into two guitars.

Two ways, picked automatically:

* side by side: when the guitars sit in different places left-to-right (common in studio mixes,
  one guitar on each side), each sound goes to the side it comes from;
* lead and rhythm: otherwise, the lead guitar's melody is followed note by note and its sound
  (each note plus its overtones) is lifted out, leaving the chords as the rhythm guitar.

Neither is perfect: when both guitars play the same notes at the same moment they can't be told
apart, and that sound stays with the rhythm guitar.
"""
import numpy as np

import audio_io

N_FFT = 4096
HOP = 512


def _stft(x):
    import librosa
    return librosa.stft(x, n_fft=N_FFT, hop_length=HOP)


def _istft(X, n):
    import librosa
    return librosa.istft(X, hop_length=HOP, length=n)


def pan_spread(audio, sr):
    """How strongly the sound sits in two separate places left and right (0..1)."""
    L, R = _stft(audio[0]), _stft(audio[1])
    aL, aR = np.abs(L), np.abs(R)
    w = aL ** 2 + aR ** 2
    pan = (aR - aL) / (aL + aR + 1e-9)
    m = w > np.percentile(w, 70)
    left = w[m & (pan < -0.35)].sum()
    right = w[m & (pan > 0.35)].sum()
    centre = w[m & (np.abs(pan) <= 0.35)].sum()
    tot = left + right + centre + 1e-12
    return float(min(left, right) * 2 / tot)


def split_by_side(audio):
    out = []
    L, R = _stft(audio[0]), _stft(audio[1])
    aL, aR = np.abs(L), np.abs(R)
    pan = (aR - aL) / (aL + aR + 1e-9)
    # soft split: left-leaning sound to guitar 1, right-leaning to guitar 2, centre shared
    w2 = np.clip(0.5 + pan, 0.0, 1.0)
    w1 = 1.0 - w2
    n = audio.shape[1]
    g1 = np.stack([_istft(w1 * L, n), _istft(w1 * R, n)])
    g2 = np.stack([_istft(w2 * L, n), _istft(w2 * R, n)])
    out = (g1, g2)
    return out


def lead_line(mono, sr, fmin=150.0, fmax=1400.0):
    """Follow the strongest single melody line. Returns f0 per frame (0 = no lead)."""
    import librosa
    S = np.abs(_stft(mono))
    freqs = librosa.fft_frequencies(sr=sr, n_fft=N_FFT)
    harm = [1, 2, 3, 4, 5, 6]
    weights = [1.0, 0.8, 0.6, 0.45, 0.35, 0.25]
    sal = librosa.salience(S, freqs=freqs, harmonics=harm, weights=weights, fill_value=0)
    band = (freqs >= fmin) & (freqs <= fmax)
    sub = sal[band]
    fb = freqs[band]
    k = np.argmax(sub, axis=0)
    peak = sub[k, np.arange(sub.shape[1])]
    # a lead line stands out clearly above the rest of the frame's salience
    spread = np.median(sub, axis=0) + 1e-9
    clarity = peak / spread
    f0 = fb[k]
    # smooth jumps: median over ~70 ms in pitch (log scale)
    from scipy.ndimage import median_filter
    lf = median_filter(np.log2(f0), size=7)
    f0 = 2 ** lf
    loud = 20 * np.log10(S.sum(axis=0) + 1e-9)
    voiced = (clarity > np.percentile(clarity, 55)) & (loud > np.percentile(loud, 25))
    voiced = median_filter(voiced.astype(np.uint8), size=9).astype(bool)   # no flicker
    return np.where(voiced, f0, 0.0)


def harmonic_mask(f0, sr, n_bins, cents=35.0, n_harm=24):
    freqs = np.linspace(0, sr / 2, n_bins).astype(np.float32)
    df = float(freqs[1])
    M = np.zeros((n_bins, len(f0)), dtype=np.float32)
    on = np.where(f0 > 0)[0]
    for c in range(0, len(on), 2000):            # a few thousand frames at a time
        idx = on[c:c + 2000]
        f = f0[idx].astype(np.float32)
        acc = np.zeros((n_bins, len(idx)), dtype=np.float32)
        for h in range(1, n_harm + 1):
            fh = f * h
            ok = fh < sr / 2
            if not ok.any():
                break
            bw = np.maximum(fh * (2 ** (cents / 1200) - 1), 1.5 * df)
            g = np.exp(-0.5 * ((freqs[:, None] - fh[None, :]) / bw[None, :]) ** 2)
            np.maximum(acc, np.where(ok[None, :], g, 0), out=acc)
        M[:, idx] = acc
    # soften in time so notes fade in and out instead of switching hard
    from scipy.ndimage import uniform_filter1d
    return uniform_filter1d(M, size=3, axis=1)


def split_lead_rhythm(audio, sr):
    mono = audio.mean(axis=0)
    f0 = lead_line(mono, sr)
    L, R = _stft(audio[0]), _stft(audio[1])
    M = harmonic_mask(f0, sr, L.shape[0])[:, : L.shape[1]]
    n = audio.shape[1]
    lead = np.stack([_istft(M * L, n), _istft(M * R, n)])
    rhythm = np.stack([_istft((1 - M) * L, n), _istft((1 - M) * R, n)])
    return rhythm, lead, float((f0 > 0).mean())


def split(path_in, out1, out2, progress_cb=None, method=None):
    """Writes two guitar parts. method: "sides", "lead" or None to pick automatically.
    Returns a dict describing how it split."""
    audio, sr = audio_io.read(path_in)
    if audio.shape[0] == 1:
        audio = np.repeat(audio, 2, axis=0)
    if progress_cb:
        progress_cb(0.1, "Listening to the guitars")
    spread = pan_spread(audio, sr)
    if method == "sides" or (method is None and spread > 0.35):
        g1, g2 = split_by_side(audio)
        info = {"method": "sides", "names": ["Guitar 1 (left)", "Guitar 2 (right)"], "spread": round(spread, 2)}
    else:
        if progress_cb:
            progress_cb(0.3, "Following the lead guitar")
        g1, g2, share = split_lead_rhythm(audio, sr)
        info = {"method": "lead", "names": ["Rhythm guitar", "Lead guitar"], "spread": round(spread, 2),
                "lead_share": round(share, 2)}
    audio_io.write(out1, g1.astype(np.float32), sr)
    audio_io.write(out2, g2.astype(np.float32), sr)
    if progress_cb:
        progress_cb(1.0, "Done")
    return info

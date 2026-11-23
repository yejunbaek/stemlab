"""Audio file helpers: decoding anything via ffmpeg, reading/writing WAV, encoding exports."""
import glob
import os
import subprocess
import sys
import time

import numpy as np
import soundfile as sf

SR = 44100

_FFMPEG = None


def ffmpeg_exe():
    global _FFMPEG
    if _FFMPEG is None:
        try:
            import imageio_ffmpeg
            _FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
        except Exception:
            _FFMPEG = "ffmpeg"
    return _FFMPEG


def _run(cmd):
    kwargs = {}
    if sys.platform == "win32":
        kwargs["creationflags"] = 0x08000000  # CREATE_NO_WINDOW
    p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kwargs)
    if p.returncode != 0:
        err = p.stderr.decode("utf-8", "replace").strip().splitlines()
        raise RuntimeError("ffmpeg failed: " + (err[-1] if err else "unknown error"))


def to_wav(src, dst, sr=SR):
    """Decode any audio/video file into 44.1 kHz stereo 16-bit WAV."""
    _run([ffmpeg_exe(), "-y", "-hide_banner", "-loglevel", "error", "-i", src,
          "-vn", "-ac", "2", "-ar", str(sr), "-c:a", "pcm_s16le", dst])


def read(path):
    """Returns float32 array shaped (channels, samples) and sample rate."""
    data, sr = sf.read(current(path), dtype="float32", always_2d=True)
    return data.T.copy(), sr


# Parts are stored as FLAC: lossless (the samples are bit-for-bit the same as WAV) at about a
# third of the size. The code still names files "part.wav"; these helpers find the real file,
# which may be part.flac, part.wav (songs from before), or a newer copy part.v<time>.flac saved
# beside a file Windows had open for playback.

def _base(path):
    for ext in (".wav", ".flac"):
        if path.endswith(ext):
            return path[: -len(ext)]
    return path


def _versions(path):
    base = _base(path)
    found = [base + ".wav", base + ".flac"]
    for ext in ("wav", "flac"):
        found += glob.glob(glob.escape(base) + f".v*.{ext}")
    return [f for f in found if os.path.isfile(f) and ".tmp." not in f]


def current(path):
    """The newest saved copy of a part's audio (FLAC or WAV)."""
    found = _versions(path)
    return max(found, key=os.path.getmtime) if found else path


def exists(path):
    return bool(_versions(path))


def remove(path):
    for f in _versions(path):
        for g in (f, f + ".peaks"):
            try:
                os.remove(g)
            except OSError:
                pass


def _tidy(path, keep):
    for f in _versions(path):
        if f != keep:
            for g in (f, f + ".peaks"):
                try:
                    os.remove(g)
                except OSError:
                    pass   # still open somewhere; current() already prefers the newer copy


def write(path, audio, sr=SR):
    """audio: (channels, samples) float32. Saves losslessly as FLAC; returns the file written."""
    audio = np.clip(audio, -1.0, 1.0)
    base = _base(path)
    tmp = base + ".tmp.flac"
    sf.write(tmp, audio.T, sr, format="FLAC", subtype="PCM_16")
    final = base + ".flac"
    try:
        os.replace(tmp, final)
    except PermissionError:
        # the old file is open (being played): save the new one beside it
        final = base + f".v{int(time.time() * 1000)}.flac"
        os.replace(tmp, final)
    _tidy(path, final)
    return final


def compress(path):
    """Convert a stored WAV to FLAC (identical samples). Returns True if it converted."""
    if not path.endswith(".wav") or not os.path.isfile(path):
        return False
    info = sf.info(path)
    base = _base(path)
    tmp = base + ".tmp.flac"
    frames = 0
    with sf.SoundFile(path) as src, sf.SoundFile(tmp, "w", samplerate=info.samplerate, channels=info.channels,
                                                 format="FLAC", subtype="PCM_16") as dst:
        while True:
            block = src.read(1 << 20, dtype="int16", always_2d=True)
            if not len(block):
                break
            dst.write(block)
            frames += len(block)
    if frames != info.frames or sf.info(tmp).frames != info.frames:
        os.remove(tmp)
        return False
    flac = base + ".flac" if not os.path.exists(base + ".flac") else base + f".v{int(time.time() * 1000)}.flac"
    os.replace(tmp, flac)
    for g in (path, path + ".peaks"):
        try:
            os.remove(g)
        except OSError:
            pass   # in use: it's older, so current() already picks the FLAC; removed next time
    return True


def encode(src_wav, dst, fmt):
    src_wav = current(src_wav)
    if fmt == "wav":
        if os.path.abspath(src_wav) != os.path.abspath(dst):
            info = sf.info(src_wav)
            if info.subtype == "PCM_16" and info.samplerate == SR:
                import shutil
                shutil.copyfile(src_wav, dst)   # already the right kind of WAV: just copy it
            else:
                data, sr = sf.read(src_wav, dtype="float32", always_2d=True)
                sf.write(dst, data, sr, subtype="PCM_16")
        return
    if fmt == "flac":
        if src_wav.endswith(".flac"):
            import shutil
            shutil.copyfile(src_wav, dst)
            return
        data, sr = sf.read(src_wav, dtype="float32", always_2d=True)
        sf.write(dst, data, sr, format="FLAC", subtype="PCM_16")
        return
    if fmt == "mp3":
        _run([ffmpeg_exe(), "-y", "-hide_banner", "-loglevel", "error", "-i", src_wav,
              "-c:a", "libmp3lame", "-b:a", "320k", "-compression_level", "2", dst])
        return
    raise ValueError("Unknown format " + fmt)

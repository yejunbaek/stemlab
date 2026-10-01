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
    data, sr = sf.read(path, dtype="float32", always_2d=True)
    return data.T.copy(), sr


def _versions(path):
    base = path[:-4] if path.endswith(".wav") else path
    found = [path] + glob.glob(glob.escape(base) + ".v*.wav")
    return [f for f in found if os.path.isfile(f) and not f.endswith(".tmp.wav")]


def current(path):
    """The newest saved copy of a part's audio. On Windows a file that's being played can't be
    replaced, so a newer copy may sit next to it as name.v<time>.wav until the old one is free."""
    found = _versions(path)
    return max(found, key=os.path.getmtime) if found else path


def remove(path):
    for f in _versions(path):
        try:
            os.remove(f)
        except OSError:
            pass


def write(path, audio, sr=SR):
    """audio: (channels, samples) float32."""
    audio = np.clip(audio, -1.0, 1.0)
    tmp = path + ".tmp.wav"
    sf.write(tmp, audio.T, sr, subtype="PCM_16")
    try:
        os.replace(tmp, path)
        final = path
    except PermissionError:
        # the old file is open (being played): save the new one beside it
        final = path[:-4] + f".v{int(time.time() * 1000)}.wav"
        os.replace(tmp, final)
    for f in _versions(path):
        if f != final:
            try:
                os.remove(f)
            except OSError:
                pass   # still in use; current() already prefers the newer copy
    return final


def encode(src_wav, dst, fmt):
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
        data, sr = sf.read(src_wav, dtype="float32", always_2d=True)
        sf.write(dst, data, sr, format="FLAC", subtype="PCM_16")
        return
    if fmt == "mp3":
        _run([ffmpeg_exe(), "-y", "-hide_banner", "-loglevel", "error", "-i", src_wav,
              "-c:a", "libmp3lame", "-b:a", "320k", "-compression_level", "2", dst])
        return
    raise ValueError("Unknown format " + fmt)

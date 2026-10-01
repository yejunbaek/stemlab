"""Audio file helpers: decoding anything via ffmpeg, reading/writing WAV, encoding exports."""
import os
import subprocess
import sys

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


def write(path, audio, sr=SR):
    """audio: (channels, samples) float32."""
    audio = np.clip(audio, -1.0, 1.0)
    tmp = path + ".tmp.wav"
    sf.write(tmp, audio.T, sr, subtype="PCM_16")
    os.replace(tmp, path)


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

"""Best-quality splitting with BS-RoFormer-SW (6 parts: vocals, guitar, piano, bass, drums, other).

On MVSep's benchmark it scores well above Demucs on every part (guitar 9.05 dB, piano 7.83 dB,
vocals 11.30 dB). It is a larger model, so it is slower: on a CPU expect a few times the song's
length; with an NVIDIA graphics card it's quick. The checkpoint (about 700 MB) is downloaded once
into Stemlab's own data folder.
"""
import os
import time

import numpy as np

import audio_io

MODEL_KEY = "roformer-model-bs-roformer-sw-by-jarredou"


def models_dir():
    base = os.environ.get("STEMLAB_DATA") or os.path.join(os.path.expanduser("~"), ".stemlab")
    return os.path.join(base, "models", "roformer")


def ensure_assets(download=True):
    from bs_roformer.download import ensure_model_assets
    ckpt, cfg = ensure_model_assets(MODEL_KEY, models_dir(), download_missing=download)
    return str(ckpt), str(cfg)


def available():
    """True when the model is already downloaded (no network needed)."""
    try:
        ensure_assets(download=False)
        return True
    except Exception:
        return False


def _load(device):
    import torch
    import yaml
    from ml_collections import ConfigDict
    from bs_roformer.utils import get_model_from_config
    ckpt, cfg = ensure_assets(download=True)
    with open(cfg, encoding="utf-8") as f:
        config = ConfigDict(yaml.load(f, Loader=yaml.FullLoader))
    model = get_model_from_config("bs_roformer", config)
    try:
        state = torch.load(ckpt, map_location="cpu", weights_only=True)
    except Exception:
        # checkpoint verified by its sha256 when downloaded; older formats need the full loader
        state = torch.load(ckpt, map_location="cpu", weights_only=False)
    if isinstance(state, dict) and "state_dict" in state:
        state = state["state_dict"]
    model.load_state_dict(state)
    model.eval().to(device)
    return model, config


def _demix(model, config, mix, device, progress_cb):
    """mix: torch tensor (2, n). Overlapping windows, cross-faded, like the reference code, but
    with progress and an estimate of the time left."""
    import torch
    import torch.nn.functional as F
    C = int(config.inference.chunk_size)
    step = C // int(config.inference.num_overlap)
    fade = C // 10
    border = C - step
    n0 = mix.shape[1]
    padded = mix.shape[1] > 2 * border
    if padded:
        mix = F.pad(mix[None], (border, border), mode="reflect")[0]
    win = torch.ones(C)
    win[:fade] = torch.linspace(0, 1, fade)
    win[-fade:] = torch.linspace(1, 0, fade)
    stems = len(config.training.instruments)
    total = mix.shape[1]
    result = torch.zeros((stems, 2, total))
    counter = torch.zeros((1, 1, total))
    chunks = (total + step - 1) // step
    use_amp = device.startswith("cuda")
    started = time.time()
    i = k = 0
    with torch.no_grad():
        while i < total:
            part = mix[:, i:i + C]
            length = part.shape[-1]
            if length < C:
                mode = "reflect" if length > C // 2 + 1 else "constant"
                part = F.pad(part[None], (0, C - length), mode=mode)[0]
            with torch.autocast("cuda", enabled=use_amp):
                x = model(part[None].to(device))[0].float().cpu()
            w = win.clone()
            if i == 0:
                w[:fade] = 1
            if i + C >= total:
                w[-fade:] = 1
            result[..., i:i + length] += x[..., :length] * w[:length]
            counter[..., i:i + length] += w[:length]
            i += step
            k += 1
            spent = time.time() - started
            left = spent / k * (chunks - k)
            mins = int(left // 60)
            msg = "Separating instruments"
            if k >= 1 and chunks - k > 0:
                msg += f" (about {mins + 1} min left)" if mins >= 1 else " (less than a minute left)"
            progress_cb(k / chunks, msg)
    out = (result / counter.clamp(min=1e-8)).numpy()
    if padded:
        out = out[..., border:border + n0]
    return out


def separate(mix_path, stems_dir, progress_cb, log=print):
    import torch
    progress_cb(0.0, "Loading the best-quality splitter (first time downloads about 700 MB)")
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model, config = _load(device)
    wav, sr = audio_io.read(mix_path)
    if sr != 44100:
        raise RuntimeError(f"Expected 44100 Hz audio, got {sr}")
    if wav.shape[0] == 1:
        wav = np.repeat(wav, 2, axis=0)
    mix = torch.from_numpy(wav[:2].copy())
    try:
        out = _demix(model, config, mix, device, progress_cb)
    except RuntimeError as e:
        if device != "cuda":
            raise
        log(f"GPU failed ({e}); continuing on the CPU")
        torch.cuda.empty_cache()
        model.to("cpu")
        out = _demix(model, config, mix, "cpu", progress_cb)
    os.makedirs(stems_dir, exist_ok=True)
    names = list(config.training.instruments)
    for name, src in zip(names, out):
        audio_io.write(os.path.join(stems_dir, name + ".wav"), src.astype(np.float32), sr)
    return names

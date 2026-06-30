"""
ONNX-exportable wrapper for BS-RoFormer (host-STFT).

The original model bakes torch.stft / torch.istft into forward(). For a
portable, contrib-op-free graph we strip those out: the STFT and iSTFT run in
the host application (the C++ runner; matching the demucs-next pattern). The
ONNX graph takes (spec_real, spec_imag) and emits (out_spec_real,
out_spec_imag) per stem with the DC bin already zeroed. It is stem-count
agnostic — the same wrapper exports the 4-stem rhythm model and the 6-stem
variant it was originally derived from.

Complex multiplication is unrolled to (a*c - b*d, a*d + b*c) to avoid
torch.view_as_complex, which has historically been flaky for ONNX export.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import torch
from torch import nn
from einops import rearrange, pack, unpack

# Need a checkout of ZFTurbo/Music-Source-Separation-Training for the
# `BSRoformer` class. Either symlink it as ./Music-Source-Separation-Training
# next to this repo, or set MSST_ROOT to the path of your checkout.
_DEFAULT_MSST = Path(__file__).resolve().parent.parent / "Music-Source-Separation-Training"
MSST_ROOT = Path(os.environ.get("MSST_ROOT") or _DEFAULT_MSST)
if not MSST_ROOT.exists():
    raise FileNotFoundError(
        f"Cannot find Music-Source-Separation-Training at {MSST_ROOT}. "
        "Clone https://github.com/ZFTurbo/Music-Source-Separation-Training and "
        "either symlink it as ./Music-Source-Separation-Training at the repo "
        "root, or set the MSST_ROOT environment variable to its path."
    )
if str(MSST_ROOT) not in sys.path:
    sys.path.insert(0, str(MSST_ROOT))

from models.bs_roformer.bs_roformer import BSRoformer


class BSRoformerONNXWrapper(nn.Module):
    """
    Wraps a BSRoformer so the ONNX graph is everything except STFT/iSTFT.

    Inputs:
        spec_real: [B, 2, 1025, T] real part of STFT (per audio channel)
        spec_imag: [B, 2, 1025, T] imaginary part of STFT

    Outputs:
        out_spec_real: [B, num_stems, 2, 1025, T] real masked spectrogram
        out_spec_imag: [B, num_stems, 2, 1025, T] imaginary masked spectrogram

    DC bin (freq 0) is zeroed before output, matching the original model's
    `self.zero_dc` behavior. Caller does iSTFT in JS.
    """

    def __init__(self, model: BSRoformer) -> None:
        super().__init__()
        self.model = model
        self.num_stems = model.num_stems
        self.audio_channels = model.audio_channels

    def forward(
        self,
        spec_real: torch.Tensor,
        spec_imag: torch.Tensor,
    ) -> tuple[torch.Tensor, torch.Tensor]:
        m = self.model
        B, S, F, T = spec_real.shape
        assert S == m.audio_channels, (
            f"channel dim {S} != model audio_channels {m.audio_channels}"
        )

        # Reconstruct stft_repr in the shape forward() expects after view_as_real:
        # [B, S, F, T, 2]
        stft_repr = torch.stack([spec_real, spec_imag], dim=-1)

        # Save for later masking (stable copy of the input spec).
        # merge stereo into frequency: [B, S, F, T, 2] -> [B, F*S, T, 2]
        stft_for_mask = rearrange(stft_repr, "b s f t c -> b (f s) t c")

        # Band-split input: [B, T, F*S*2]
        x = rearrange(stft_for_mask, "b f t c -> b t (f c)")
        x = m.band_split(x)

        # Axial/hierarchical transformer stack
        for transformer_block in m.layers:
            if len(transformer_block) == 3:
                linear_transformer, time_transformer, freq_transformer = transformer_block
                x, ft_ps = pack([x], "b * d")
                x = linear_transformer(x)
                (x,) = unpack(x, ft_ps, "b * d")
            else:
                time_transformer, freq_transformer = transformer_block

            x = rearrange(x, "b t f d -> b f t d")
            x, ps = pack([x], "* t d")
            x = time_transformer(x)
            (x,) = unpack(x, ps, "* t d")
            x = rearrange(x, "b f t d -> b t f d")
            x, ps = pack([x], "* f d")
            x = freq_transformer(x)
            (x,) = unpack(x, ps, "* f d")

        x = m.final_norm(x)

        # Mask estimators -> [B, num_stems, T, F*S*2]
        mask = torch.stack([fn(x) for fn in m.mask_estimators], dim=1)
        # -> [B, num_stems, F*S, T, 2]
        mask = rearrange(mask, "b n t (f c) -> b n f t c", c=2)

        # Add stem dimension to spectrogram for broadcasted multiplication
        # [B, F*S, T, 2] -> [B, 1, F*S, T, 2]
        spec_b = stft_for_mask.unsqueeze(1)

        # Complex multiply unrolled to real ops (ONNX-friendly).
        spec_r = spec_b[..., 0]
        spec_i = spec_b[..., 1]
        mask_r = mask[..., 0]
        mask_i = mask[..., 1]
        out_r = spec_r * mask_r - spec_i * mask_i
        out_i = spec_r * mask_i + spec_i * mask_r

        # Reshape (F*S) back into (F, S): currently the merged dim is
        # interleaved as (f0_s0, f0_s1, f1_s0, f1_s1, ...). Inverse of
        # 'b s f t c -> b (f s) t c'.
        # [B, num_stems, F*S, T] -> [B, num_stems, F, S, T]
        out_r = rearrange(out_r, "b n (f s) t -> b n s f t", s=m.audio_channels)
        out_i = rearrange(out_i, "b n (f s) t -> b n s f t", s=m.audio_channels)

        if m.zero_dc:
            # Zero DC bin (freq=0). We need a mask of shape broadcastable
            # over F. index_fill works but is awkward to ONNX-export with
            # dynamic shapes — multiply by a zero-DC binary mask instead.
            dc_mask = torch.ones(F, dtype=out_r.dtype, device=out_r.device)
            dc_mask[0] = 0.0
            # broadcast over [B, N, S, F, T]
            dc_mask = dc_mask.view(1, 1, 1, F, 1)
            out_r = out_r * dc_mask
            out_i = out_i * dc_mask

        return out_r, out_i


def build_model_from_yaml(yaml_path: Path, ckpt_path: Path) -> BSRoformer:
    """Load BSRoformer with flash_attn forced off (for portable inference)."""
    import yaml

    with open(yaml_path) as f:
        cfg = yaml.unsafe_load(f)
    model_cfg = dict(cfg["model"])
    model_cfg["flash_attn"] = False  # weights are identical; non-flash path is ONNX-friendly
    # BSRoformer's @beartype signature wants real tuples, not lists.
    for k in ("freqs_per_bands", "multi_stft_resolutions_window_sizes"):
        if isinstance(model_cfg.get(k), list):
            model_cfg[k] = tuple(model_cfg[k])

    model = BSRoformer(**model_cfg)
    state = torch.load(ckpt_path, map_location="cpu", weights_only=False)
    if isinstance(state, dict) and "state_dict" in state:
        state = state["state_dict"]
    missing, unexpected = model.load_state_dict(state, strict=False)
    if missing:
        print(f"[warn] missing keys: {len(missing)} (first 5): {missing[:5]}")
    if unexpected:
        print(f"[warn] unexpected keys: {len(unexpected)} (first 5): {unexpected[:5]}")
    model.eval()
    return model


def compute_stft_for_input(
    audio: torch.Tensor,
    n_fft: int = 2048,
    hop_length: int = 512,
    win_length: int = 2048,
) -> tuple[torch.Tensor, torch.Tensor]:
    """Match the model's STFT exactly: center=True, hann window, no normalization."""
    B, S, t = audio.shape
    audio_flat = audio.reshape(B * S, t)
    window = torch.hann_window(win_length, device=audio.device)
    spec = torch.stft(
        audio_flat,
        n_fft=n_fft,
        hop_length=hop_length,
        win_length=win_length,
        window=window,
        return_complex=True,
        center=True,
        normalized=False,
    )
    # [B*S, F, T] complex
    F = spec.shape[1]
    T = spec.shape[2]
    spec = spec.reshape(B, S, F, T)
    return spec.real.contiguous(), spec.imag.contiguous()


def istft_from_spec(
    spec_real: torch.Tensor,
    spec_imag: torch.Tensor,
    length: int,
    n_fft: int = 2048,
    hop_length: int = 512,
    win_length: int = 2048,
) -> torch.Tensor:
    """Inverse STFT matching the model exactly: center=True, hann window."""
    *prefix, F, T = spec_real.shape
    flat_real = spec_real.reshape(-1, F, T)
    flat_imag = spec_imag.reshape(-1, F, T)
    spec = torch.complex(flat_real, flat_imag)
    window = torch.hann_window(win_length, device=spec_real.device)
    out = torch.istft(
        spec,
        n_fft=n_fft,
        hop_length=hop_length,
        win_length=win_length,
        window=window,
        center=True,
        normalized=False,
        length=length,
        return_complex=False,
    )
    return out.reshape(*prefix, length)

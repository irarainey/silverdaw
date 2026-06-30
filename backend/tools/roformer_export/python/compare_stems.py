"""
Compare a browser-generated stem WAV to a Python-pipeline reference stem
(MP3 or WAV). Reports correlation, RMS diff, and SI-SDR — the production
quality bar is >= 0.99 correlation and >= 18 dB SI-SDR.

Usage:
  python compare_stems.py --browser path/to/browser_drums.wav \
                          --reference path/to/python_drums.mp3
"""

from __future__ import annotations

import argparse

import librosa
import numpy as np
import soundfile as sf


def load_audio(path: str, sr: int = 44100) -> np.ndarray:
    audio, src_sr = sf.read(path, always_2d=True)
    if audio.shape[1] == 1:
        audio = np.repeat(audio, 2, axis=1)
    if src_sr != sr:
        audio = librosa.resample(audio.T, orig_sr=src_sr, target_sr=sr).T
    return audio.astype(np.float32)


def si_sdr(est: np.ndarray, ref: np.ndarray) -> float:
    """Scale-Invariant Signal-to-Distortion Ratio in dB."""
    s = (np.sum(est * ref) / (np.sum(ref ** 2) + 1e-10)) * ref
    return 10 * np.log10(np.sum(s ** 2) / (np.sum((est - s) ** 2) + 1e-10))


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--browser", required=True, help="WAV from the browser pipeline")
    p.add_argument("--reference", required=True, help="MP3/WAV from the reference pipeline")
    args = p.parse_args()

    bro = load_audio(args.browser)
    ref = load_audio(args.reference)
    n = min(bro.shape[0], ref.shape[0])
    bro, ref = bro[:n], ref[:n]
    print(f"aligned length: {n} samples ({n/44100:.2f} s)")

    diff = bro - ref
    print(f"max abs diff: {np.abs(diff).max():.4e}")
    print(f"RMS diff:     {np.sqrt(np.mean(diff**2)):.4e}")
    print(f"ref RMS:      {np.sqrt(np.mean(ref**2)):.4e}")
    for ch in range(2):
        print(f"correlation ch{ch}: {np.corrcoef(bro[:, ch], ref[:, ch])[0, 1]:.4f}")
    print(f"SI-SDR: {si_sdr(bro.flatten(), ref.flatten()):.2f} dB")


if __name__ == "__main__":
    main()

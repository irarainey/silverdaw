"""Full-track 4-stem separation with the CLEAN ZFTurbo BS-Roformer ONNX.

Host STFT/iSTFT (hop 441, n_fft 2048, hann, center) matching the export.
4 s/8 s chunks with 50% Hann OLA. I/O: spec_real/imag [1,2,1025,T] ->
out_spec_real/imag [1,4,2,1025,T]. Stems: [drums, bass, other, vocals].
Writes drums/bass (and other/vocals) WAVs for auditioning.
"""
import sys
from pathlib import Path

import numpy as np
import soundfile as sf
import onnxruntime as ort

HERE = Path(__file__).resolve().parent
ART = HERE / "artifacts"
SR = 44100
N_FFT = 2048
HOP = 441
PAD = N_FFT // 2
BINS = N_FFT // 2 + 1
HANN = (0.5 - 0.5 * np.cos(2 * np.pi * np.arange(N_FFT) / N_FFT)).astype(np.float64)
STEMS = ["drums", "bass", "other", "vocals"]


def reflect_idx(idx, n):
    idx = np.where(idx < 0, -idx, idx)
    idx = np.where(idx >= n, 2 * n - 2 - idx, idx)
    return idx


def stft_chunk(chunk, T):
    real = np.zeros((1, 2, BINS, T), np.float32)
    imag = np.zeros((1, 2, BINS, T), np.float32)
    n = chunk.shape[1]
    base = (np.arange(T)[:, None] * HOP + np.arange(N_FFT)[None, :]) - PAD
    idx = reflect_idx(base, n)
    for ch in range(2):
        spec = np.fft.rfft(chunk[ch][idx] * HANN[None, :], axis=1)
        real[0, ch] = spec.real.T.astype(np.float32)
        imag[0, ch] = spec.imag.T.astype(np.float32)
    return real, imag


def istft_chunk(real, imag, T, chunk_len):
    out = np.zeros((2, chunk_len), np.float32)
    padded = (T - 1) * HOP + N_FFT
    for ch in range(2):
        time = np.fft.irfft((real[ch] + 1j * imag[ch]).T, n=N_FFT, axis=1)
        acc = np.zeros(padded, np.float64)
        env = np.zeros(padded, np.float64)
        for f in range(T):
            b = f * HOP
            acc[b:b + N_FFT] += time[f] * HANN
            env[b:b + N_FFT] += HANN * HANN
        full = (acc / np.maximum(env, 1e-8))[PAD:PAD + chunk_len]
        out[ch] = full[:chunk_len].astype(np.float32)
    return out


def load_stereo(path):
    a, sr = sf.read(path, always_2d=True, dtype="float32")
    a = a.T
    if a.shape[0] == 1:
        a = np.vstack([a[0], a[0]])
    return np.ascontiguousarray(a[:2])


def separate(sess, mix, chunk_len, T):
    samples = mix.shape[1]
    step = chunk_len // 2
    win = (0.5 - 0.5 * np.cos(2 * np.pi * np.arange(chunk_len) / chunk_len))
    acc = np.zeros((4, 2, samples + chunk_len), np.float64)
    cnt = np.zeros(samples + chunk_len, np.float64)
    chunk = np.zeros((2, chunk_len), np.float32)
    off = 0
    nc = 0
    while off < samples:
        clen = min(chunk_len, samples - off)
        chunk[:] = 0.0
        chunk[:, :clen] = mix[:, off:off + clen]
        sr_, si_ = stft_chunk(chunk, T)
        or_, oi_ = sess.run(["out_spec_real", "out_spec_imag"],
                            {"spec_real": sr_, "spec_imag": si_})
        for s in range(4):
            rec = istft_chunk(or_[0, s], oi_[0, s], T, chunk_len)
            for ch in range(2):
                acc[s, ch, off:off + chunk_len] += rec[ch] * win
        cnt[off:off + chunk_len] += win
        nc += 1
        off += step
    cnt = np.maximum(cnt, 1e-8)
    return (acc / cnt[None, None, :])[:, :, :samples].astype(np.float32), nc


def main():
    model = sys.argv[1] if len(sys.argv) > 1 else str(ART / "bs_roformer_4stem_t801_fp16.onnx")
    chunk_len = int(sys.argv[2]) if len(sys.argv) > 2 else 352800  # 8 s
    T = chunk_len // HOP + 1
    print(f"model={Path(model).name}  chunk={chunk_len} (T={T})")
    sess = ort.InferenceSession(model, providers=["CPUExecutionProvider"])

    tracks = [str(HERE.parent.parent / "_mix.wav"),
              str(HERE.parent.parent / "_cs_mix.wav")]
    for tp in tracks:
        name = Path(tp).stem
        mix = load_stereo(tp)
        stems, nc = separate(sess, mix, chunk_len, T)
        rms = lambda x: float(np.sqrt(np.mean(np.square(x))))
        recon = stems.sum(0)
        print(f"\n{name}: {nc} chunks, mix RMS={rms(mix):.4f}, "
              f"sum-null RMS={rms(mix - recon):.5f}")
        for s in range(4):
            print(f"  {STEMS[s]:6s} RMS={rms(stems[s]):.4f}")
            sf.write(str(ART / f"clean_{name}_{STEMS[s]}.wav"), stems[s].T, SR)


if __name__ == "__main__":
    main()

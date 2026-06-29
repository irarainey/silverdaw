// Manifest for the optional 4-stem BS-RoFormer "Rhythm Quality Pack" — a
// higher-quality DRUMS and BASS model used in place of the htdemucs drums/bass
// specialists (vocals stay htdemucs or the vocal pack; `other` stays the
// residual). The model runs once and both drums and bass are extracted.
//
// Weights are an MIT-licensed export of ZFTurbo's 4-stem BS-RoFormer checkpoint
// (`Music-Source-Separation-Training` v1.0.12, trained on MUSDB18-HQ; repo
// licence MIT, architecture lucidrains/BS-RoFormer MIT). The PyTorch graph's
// torch.stft/istft are stripped out so the ONNX core consumes a precomputed
// STFT and returns the masked per-stem spectrogram (the host runs the STFT/iSTFT
// in BsRoformerSpectral). Exported at an 8 s window (T=801, hop 441) — the
// largest chunk that stays within a modest GPU's VRAM — and fp16-quantised.
// Downloaded on first use and integrity-checked by SHA-256.
//
// NOTE: the export is self-hosted; `REPO`/`REVISION` below are a placeholder for
// the publish location and must point at the uploaded `.onnx` before the
// in-app download works. The SHA-256 and size are of the actual exported file,
// so a manually-placed copy is detected as installed without a download.

import type { ModelFile, ModelManifest } from './htdemucsModel'

const REPO = 'silverdaw/bs-roformer-rhythm-onnx'
const REVISION = 'main'

function resolveUrl(fileName: string): string {
  return `https://huggingface.co/${REPO}/resolve/${REVISION}/${fileName}`
}

// The backend opens this single graph file (weights are embedded — no sibling
// `.onnx.data`, unlike the vocal pack).
export const RHYTHM_CORE_FILENAME = 'bs_roformer_4stem_rhythm_fp16.onnx'

// Tagged 'drums' only as a type requirement; the pack produces drums + bass and
// ModelStore keys off fileName/size/sha, not the stem field.
const FILES: readonly ModelFile[] = [
  {
    stem: 'drums',
    fileName: RHYTHM_CORE_FILENAME,
    url: resolveUrl(RHYTHM_CORE_FILENAME),
    sha256: '4bac38e42c085b5d69964e2b7ff161318a1315122c10b025c718b20e94d85d6b',
    sizeBytes: 269457840
  }
]

export const BS_ROFORMER_RHYTHM_MANIFEST: ModelManifest = {
  id: 'bs-roformer-rhythm',
  displayName: 'Rhythm Quality Pack (BS-RoFormer)',
  repo: REPO,
  revision: REVISION,
  license: 'MIT',
  stems: ['drums', 'bass'],
  files: FILES,
  totalBytes: FILES.reduce((sum, f) => sum + f.sizeBytes, 0)
}

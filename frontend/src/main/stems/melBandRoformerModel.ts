// Manifest for the Mel-Band RoFormer "Vocal Quality Pack" — the primary VOCALS
// model, used automatically when installed (htdemucs is the backup; `other`
// stays the residual).
//
// Served from Silverdaw's own re-host
// `huggingface.co/silverdaw/mel-band-roformer-vocals-onnx` (a byte-identical copy
// of the MIT export at `huggingface.co/musetric/vocal-separation-roformer-onnx`;
// Kim Vocal 2 / SYHFT Mel-Band RoFormer, weight license MIT, inherited from
// `SYH99999/MelBandRoformerBigSYHFTV1Fast`). The neural core is a small graph
// (`.onnx`) plus a large external-weights file (`.onnx.data`) that must sit
// beside it; onnxruntime loads the `.data` automatically. Downloaded on first
// use and integrity-checked. SHA-256s are published in the model card.

import type { ModelFile, ModelManifest } from './htdemucsModel'

const REPO = 'silverdaw/mel-band-roformer-vocals-onnx'
const REVISION = 'main'

function resolveUrl(fileName: string): string {
  return `https://huggingface.co/${REPO}/resolve/${REVISION}/${fileName}`
}

// The backend opens this graph file; the `.data` weights load alongside it.
export const ROFORMER_CORE_FILENAME = 'syhft_core_folded_fp16_webgpu.onnx'

// Both files are tagged 'vocals' (the only stem this pack produces); the stem
// field is only a type requirement — ModelStore keys off fileName/size/sha.
const FILES: readonly ModelFile[] = [
  {
    stem: 'vocals',
    fileName: ROFORMER_CORE_FILENAME,
    url: resolveUrl(ROFORMER_CORE_FILENAME),
    sha256: 'dde2bfe8f85d2c12efa24ce4d45cc13e8709b8a72e277a93f130d496d948e918',
    sizeBytes: 5308300
  },
  {
    stem: 'vocals',
    fileName: 'syhft_core_folded_fp16_webgpu.onnx.data',
    url: resolveUrl('syhft_core_folded_fp16_webgpu.onnx.data'),
    sha256: 'b08cfc80905e3560a4dd5d30f641299a47dd96d309ebbe9524d9d6c9d2a0356f',
    sizeBytes: 741190540
  }
]

export const MEL_BAND_ROFORMER_MANIFEST: ModelManifest = {
  id: 'mel-band-roformer-vocals',
  displayName: 'Vocal Quality Pack (Mel-Band RoFormer)',
  repo: REPO,
  revision: REVISION,
  license: 'MIT',
  stems: ['vocals'],
  files: FILES,
  totalBytes: FILES.reduce((sum, f) => sum + f.sizeBytes, 0)
}

// Manifest for the htdemucs fine-tuned 4-stem model (vocals/drums/bass/other).
//
// The weights are the community ONNX export at
// `huggingface.co/StemSplitio/htdemucs-ft-onnx` (MIT-licensed). htdemucs_ft is a
// "bag" of four specialist models — one per source — so 4-stem output is native.
// Files are too large to ship in the installer (~1.2 GB total), so they are
// downloaded on first use and integrity-checked. The revision and per-file
// SHA-256 are pinned (HF LFS `oid` == content SHA-256) for reproducibility.
//
// `StemName` is re-exported from the bridge schema — the single source of truth
// for the stem vocabulary across both processes — so the manifest can't drift.

import type { StemName } from '../../shared/bridge-protocol'

export type { StemName }

export interface ModelFile {
  readonly stem: StemName
  readonly fileName: string
  readonly url: string
  readonly sha256: string
  readonly sizeBytes: number
}

export interface ModelManifest {
  readonly id: string
  readonly displayName: string
  readonly repo: string
  readonly revision: string
  readonly license: string
  readonly stems: readonly StemName[]
  readonly files: readonly ModelFile[]
  readonly totalBytes: number
}

const REPO = 'StemSplitio/htdemucs-ft-onnx'
const REVISION = '8616370ed541bc183dbe15fb0d54d5f49918f47e'

function resolveUrl(fileName: string): string {
  return `https://huggingface.co/${REPO}/resolve/${REVISION}/${fileName}`
}

// fp32 weights — chosen over the fp16 variants for the CPU execution provider,
// where fp16 ops are commonly emulated (slower) rather than accelerated.
const FILES: readonly ModelFile[] = [
  {
    stem: 'vocals',
    fileName: 'htdemucs_ft_vocals.onnx',
    url: resolveUrl('htdemucs_ft_vocals.onnx'),
    sha256: '8c5d5e2da1f27050240bb80236673307ee3b40d4b064066d9350f4d64bfd544d',
    sizeBytes: 316446953
  },
  {
    stem: 'drums',
    fileName: 'htdemucs_ft_drums.onnx',
    url: resolveUrl('htdemucs_ft_drums.onnx'),
    sha256: 'f76b68af36066e38885b369299b5032a861038f9b49da5aa6cf1c31cfa69cf27',
    sizeBytes: 316446953
  },
  {
    stem: 'bass',
    fileName: 'htdemucs_ft_bass.onnx',
    url: resolveUrl('htdemucs_ft_bass.onnx'),
    sha256: '2a74d9283fc2336fcc58d50f87a7080aff57aea372f65cfe3f0211ea1ff16182',
    sizeBytes: 316446953
  },
  {
    stem: 'other',
    fileName: 'htdemucs_ft_other.onnx',
    url: resolveUrl('htdemucs_ft_other.onnx'),
    sha256: '90e11806c1bb558ca9d9c7e909d28a2854f7f217982e90482dbed6442513daad',
    sizeBytes: 316446953
  }
]

export const HTDEMUCS_FT_MANIFEST: ModelManifest = {
  id: 'htdemucs-ft',
  displayName: 'htdemucs fine-tuned (4-stem)',
  repo: REPO,
  revision: REVISION,
  license: 'MIT',
  stems: ['vocals', 'drums', 'bass', 'other'],
  files: FILES,
  totalBytes: FILES.reduce((sum, f) => sum + f.sizeBytes, 0)
}

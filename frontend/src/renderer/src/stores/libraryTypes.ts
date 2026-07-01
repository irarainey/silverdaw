// Library domain types re-exported by `libraryStore` for stable imports.

import type { ClipWarpMode, LibraryItemKind } from '@shared/bridge-protocol'

export interface LibraryClipSource {
  sourceItemId?: string
  sourceClipId?: string
  inMs: number
  durationMs: number
}

/** Input to `libraryStore.addItem`; shared so domain action modules can call it via `this`. */
export interface AddLibraryItemInput {
  kind?: LibraryItemKind
  name?: string
  filePath: string
  fileName: string
  durationMs: number
  sampleRate: number
  channelCount: number
  peaks: Float32Array
  peaksPerSecond?: number
  playbackFilePath?: string
  key?: string
  /** Snapshot rebuilds must not echo `LIBRARY_ADD` back to the backend. */
  fromSnapshot?: boolean
  id?: string
  derivedFrom?: LibraryClipSource
  collapsed?: boolean
  /** Saved-clip warp defaults copied onto new timeline placements. */
  warpEnabled?: boolean
  warpMode?: ClipWarpMode
  tempoRatio?: number
  semitones?: number
  cents?: number
  unresolved?: boolean
  /** Media GUID minted at first import; key into the project's central metadata/covers
   *  store. Carried over to every derived stem/sample so they share the source's cover
   *  art + tags, however many levels down. */
  mediaId?: string
  /** User flag hiding this tile's cover art without deleting the shared media image. */
  coverArtHidden?: boolean
}

export interface LibraryItem {
  readonly id: string
  readonly kind: LibraryItemKind
  name?: string
  /** Mutable because relinking a missing source re-points the item. */
  filePath: string
  fileName: string
  /** Mirrors the backend missing-source flag from PROJECT_STATE. */
  unresolved?: boolean
  durationMs: number
  /** May be 0 for PROJECT_STATE placeholders until WAVEFORM_DATA arrives. */
  sampleRate: number
  channelCount: number
  /** Alternating min/max float pairs; `peaksPerSecond` is the actual bucket rate. */
  peaks: Float32Array
  peaksPerSecond?: number
  /** Shared LOD pyramid for timeline rendering near one peak per pixel. */
  peaksLod?: import('@/lib/peaksLod').PeaksLodLayer[]
  bpm?: number
  /** Beat positions in source-file seconds. */
  beats?: number[]
  /** Ideal beat-grid phase in seconds; falls back to `beats[0]` for older projects. */
  beatAnchorSec?: number
  /** True when the analysed tempo varies enough that BPM is only an average. */
  variableTempo?: boolean
  /** Backend hint for defaulting non-musical sources to the simple audio type. */
  lowConfidence?: boolean
  /** User override; `undefined` means auto via `lowConfidence`. */
  audioType?: 'simple' | 'music'
  key?: string
  /** Backend load path; may point at a renderer-written WAV for renderer-only formats. */
  playbackFilePath: string
  /** Backend decoded-WAV cache path shown in info UI, not sent as `CLIP_ADD.filePath`. */
  decodedCacheFilePath?: string
  /** Tag metadata; cover-art bytes are stripped before entering reactive state. */
  metadata?: AudioMetadata | null
  /** Object URL for embedded cover art; owned and revoked by the library store. */
  coverArtUrl?: string
  derivedFrom?: LibraryClipSource
  /** Source-group disclosure state persisted with the project. */
  collapsed?: boolean
  /** Saved-clip warp defaults copied onto new timeline placements. */
  warpEnabled?: boolean
  warpMode?: ClipWarpMode
  tempoRatio?: number
  semitones?: number
  cents?: number
  /** Media GUID minted at first import; key into the project's central metadata/covers
   *  store, carried over to every derived stem/sample. */
  mediaId?: string
  /** User flag hiding this tile's cover art (tile + info dialog) without deleting the
   *  shared media-store image; persisted per-item in the project. */
  coverArtHidden?: boolean
}

/** Per-file import progress shown while decoding, analysing, or warping. */
export type ImportStage =
  | 'decoding'
  | 'detectingTempo'
  | 'detectingBeats'
  | 'warping'
  | 'done'
  | 'failed'
export interface ImportEntry {
  /** Local-only id; the library item id is unknown until decoding finishes. */
  id: string
  fileName: string
  stage: ImportStage
  /** Filled once the analysis event can match by item id. */
  libraryItemId?: string
}

/** Session-scoped high-resolution peaks for the Clip Editor; one multi-MB entry at a time. */
export interface EditorHiResPeaks {
  libraryItemId: string
  peaksPerSecond: number
  sampleRate: number
  peaks: Float32Array
  /** Per-channel high-res peaks `[left, right]`; empty for mono. */
  channels: Float32Array[]
}

/** Per-library-item stereo peaks plus per-channel LOD pyramids. */
export interface ItemChannelPeaks {
  channels: Float32Array[]
  lod: import('@/lib/peaksLod').PeaksLodLayer[][]
  peaksPerSecond: number
}

/** Library store state. Lives here (neutral module) so domain action modules can
 *  type their `this` against it without importing the store value. */
export interface LibraryState {
  items: LibraryItem[]
  nextItemIndex: number
  importTotal: number
  importDone: number
  imports: ImportEntry[]
  /** HTML5 dragover cannot read non-text `dataTransfer`; store the id here. */
  currentDragItemId: string | null
  /** One multi-MB high-resolution peaks payload for the Clip Editor. */
  editorHiResPeaks: EditorHiResPeaks | null
  /** Stereo peak data kept outside `LibraryItem` so summary paths stay untouched. */
  channelPeaksByItemId: Record<string, ItemChannelPeaks>
}

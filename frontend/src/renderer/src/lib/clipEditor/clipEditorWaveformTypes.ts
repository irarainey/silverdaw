// Shared types for the Clip Editor waveform renderer and its draw passes.

import type { Ref } from 'vue'
import type {
  EditorHiResPeaks,
  ItemChannelPeaks,
  LibraryItem
} from '@/stores/libraryStore'
import type { ClipEnvelopePoint } from '@shared/bridge-protocol'

export interface ClipEditorWaveformDeps {
  sourceItem: () => LibraryItem | null
  sourceDurationMs: () => number
  zoom: () => number
  visibleInMs: () => number
  visibleDurationMs: () => number
  visibleEndMs: () => number
  viewInMs: () => number
  viewEndMs: () => number
  selectionInMs: () => number
  selectionEndMs: () => number
  selectionDurationMs: () => number
  editsExistingClip: () => boolean
  playheadAbsMs: () => number
  volumeShapeAvailable: () => boolean
  volumeEditActive: () => boolean
  volumeShapeDurationMs: () => number
  draftPoints: () => readonly ClipEnvelopePoint[]
  draftEffectiveRatio: () => number
  draftReversed: () => boolean
  /** Draft brake flag — draws the record-stop tail overlay when on. */
  draftBrake: () => boolean
  /** Draft backspin flag — draws the reverse-rewind tail overlay when on. */
  draftBackspin: () => boolean
  /** Brake tail length (s) and curve power from the global effect preference. */
  brakeSeconds: () => number
  brakeCurvePower: () => number
  /** Backspin tail length (s) and curve power from the global effect preference. */
  backspinSeconds: () => number
  backspinCurvePower: () => number
  /** True while Slice mode is active (draws the slice-marker overlay). */
  sliceEditActive: () => boolean
  /** Slice markers in source-absolute ms (ascending). */
  sliceMarkers: () => readonly number[]
  editorHiResPeaks: () => EditorHiResPeaks | null
  channelPeaksByItemId: () => Record<string, ItemChannelPeaks>
  waveformDisplayMode: () => 'summary' | 'stereo'
  /** Last-rendered lane layout, used by pointer hit testing. */
  waveformStereoLanes: Ref<boolean>
  /** CSS-pixel canvas width, kept in sync with the renderer for viewport maths. */
  canvasCssWidth: Ref<number>
}

export interface ClipEditorWaveform {
  /** Schedule a full scene rebuild (content / zoom / selection / volume changes). */
  drawWaveform: () => void
  /** Cheap per-frame update: translate for scroll (or rebuild past overscan) + playhead. */
  applyScroll: () => void
  /** Cheap per-frame playhead reposition with no scene rebuild. */
  updatePlayhead: () => void
  /** Build the Pixi app on the dialog host (call when the editor opens). */
  mountScene: (host: HTMLElement) => Promise<void>
  /** Tear the Pixi app down (call when the editor closes). */
  unmountScene: () => void
  /** The Pixi-managed canvas element for pointer hit-testing. */
  getCanvas: () => HTMLCanvasElement | null
  ensureEditorHiResPeaks: () => void
  resetHiResRequestKey: () => void
}

export interface SceneGeometry {
  W: number
  H: number
  vDur: number
  viewIn: number
  viewEnd: number
  worldPxPerMs: number
  scrollPx: number
  worldW: number
  waveTop: number
  waveH: number
  waveMid: number
}

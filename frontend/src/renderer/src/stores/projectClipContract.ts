// Internal cross-action contract for the clip-domain action modules
// (projectClipActions, projectClipLibraryActions, projectTransitionActions).
// All three are spread into the same Pinia store, so each may invoke any of
// these sibling actions via `this`. Declaring the set once as the modules'
// `this` type lets them live in separate files with no store import cycle.
// If a sibling action's signature changes, update it here too.

import type { ClipWarpMode, TransitionRecipe, ClipEnvelopePoint } from '@shared/bridge-protocol'
import type { LibraryItem } from '@/stores/libraryStore'
import type { ProjectState, Track } from './projectTypes'

export type ProjectClipThis = ProjectState & {
  pushTrackGain(track: Track): void

  addClipToTrack(
    trackId: string,
    audio: {
      libraryItemId: string
      filePath: string
      fileName: string
      durationMs: number
      sampleRate: number
      channelCount: number
      peaks: Float32Array
      peaksPerSecond?: number
      playbackFilePath?: string
      inMs?: number
    },
    startMs?: number
  ): string | null

  applyDropTimeWarp(
    clipId: string,
    src: {
      id?: string
      kind?: LibraryItem['kind']
      bpm?: number
      variableTempo?: boolean
      lowConfidence?: boolean
      audioType?: 'simple' | 'music'
      warpEnabled?: boolean
      warpMode?: ClipWarpMode
      tempoRatio?: number
      semitones?: number
      cents?: number
      derivedFrom?: LibraryItem['derivedFrom']
    }
  ): void

  copySelectedClip(): boolean

  createTransition(
    trackId: string,
    leftClipId: string,
    rightClipId: string,
    recipe?: TransitionRecipe
  ): void

  removeClip(clipId: string): void

  setClipWarp(
    clipId: string,
    patch: {
      warpEnabled?: boolean
      warpMode?: ClipWarpMode
      tempoRatio?: number | null
      semitones?: number
      cents?: number
      pendingAutoWarp?: boolean
      effectiveDurationMs?: number
      effectiveTempoRatio?: number
      effectiveWarpActive?: boolean
    },
    opts?: { localOnly?: boolean }
  ): void

  setClipEnvelope(
    clipId: string,
    points: ClipEnvelopePoint[],
    opts?: { localOnly?: boolean; gestureId?: string; gestureEnd?: boolean }
  ): void

  trimClip(clipId: string, startMs: number, inMs: number, durationMs: number): void

  wouldClipOverlap(trackId: string, startMs: number, durationMs: number): boolean
}

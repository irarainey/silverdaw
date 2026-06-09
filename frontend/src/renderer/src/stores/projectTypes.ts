import { MAX_TRACK_GAIN_LINEAR } from '@/lib/audio/db'
import type {
  ClipEnvelopePoint,
  ClipWarpMode,
  DelayNoteValue,
  TransitionRecipe
} from '@shared/bridge-protocol'

export interface Clip {
  readonly id: string
  /** Host track id. Mutable — updated with CLIP_MOVE so the backend re-parents the clip. */
  trackId: string
  /** Source library item. Single source of truth for the audio file; clips never
   *  carry a path. filePath/fileName/peaks below are cached copies for rendering. */
  libraryItemId: string
  /** Cached source-file path (== library item filePath); refreshed on relink. */
  filePath: string
  /** Cached backend-loadable path; matches CLIP_ADDED/CLIP_ADD_FAILED acks to the clip. */
  playbackFilePath?: string
  fileName: string
  /** Offset from the timeline origin (ms). Mutable so clips can be dragged. */
  startMs: number
  /** Read offset into the source file (trim window's left edge). 0 = untrimmed. */
  inMs: number
  /** Play length from `inMs` onward (ms). */
  durationMs: number
  /** Backend-reported sample rate. May be 0 for placeholder clips until WAVEFORM_DATA arrives. */
  sampleRate: number
  readonly channelCount: number
  /** Alternating min/max pairs. `peaksPerSecond` is the actual bucket rate used. */
  peaks: Float32Array
  peaksPerSecond?: number
  /** Source file missing on disk; rendered greyed-out and listed in the relink toast. */
  unresolved: boolean
  /** Colour-palette override (0..15); inherits the track's colorIndex when undefined. */
  colorIndex?: number
  /** Display-name override; falls back to the library item title/filename when undefined. */
  name?: string
  /** Warp + pitch-shift settings (see ClipSetWarpPayload). `tempoRatio` undefined =
   *  derive from project.bpm/sourceBpm live; a finite value pins the ratio. */
  warpEnabled?: boolean
  warpMode?: ClipWarpMode
  tempoRatio?: number
  semitones?: number
  cents?: number
  /** Volume-shape breakpoints (post-warp ms, linear gain [0,4], sorted). Empty = unity. */
  envelopePoints?: ClipEnvelopePoint[]
  /** Clip dropped before its BPM was detected; cleared by LIBRARY_ITEM_ANALYSIS or a manual warp edit. */
  pendingAutoWarp?: boolean
  /** Backend-authoritative effective timing (rendered footprint); `durationMs` is source-time. */
  effectiveDurationMs?: number
  effectiveTempoRatio?: number
  effectiveWarpActive?: boolean
  /** Locks move/edge-trim gestures (editor still opens). Per-clip; not shared across saved-clip siblings. */
  locked?: boolean
  /** Plays the clip window backwards (non-destructive). Propagated across saved-clip siblings. */
  reversed?: boolean
}

export interface Marker {
  readonly id: string
  positionMs: number
}

/**
 * Clip-to-clip crossfade on one track (§12.1). Backend-authoritative via
 * TRANSITION_* messages. `leftClipId` = earlier (fade-out) clip, `rightClipId` = later (fade-in).
 */
export interface Transition {
  readonly id: string
  leftClipId: string
  rightClipId: string
  recipe: TransitionRecipe
}

export interface Track {
  readonly id: string
  name: string
  clipIds: string[]
  muted: boolean
  soloed: boolean
  /** Linear gain: 0 = silent, 1 = unity. TrackHeaderPanel maps its 0..1 fader piecewise so unity sits mid-bar. */
  volume: number
  /** Index into `TRACK_PALETTE`. Selects the waveform / clip-block colours. */
  colorIndex: number
  /** Visible track length (ms); grows to fit longer imports. Drives the ruler/scroll extent. */
  lengthMs: number
  /** Row height (CSS px), user-resizable. Falls back to the default when absent. */
  heightPx?: number
  /** Tone EQ: 3-band tilt (dB [-15,+15], 0 = flat) + low/high-cut. Suppressed-when-default. */
  toneBassDb?: number
  toneMidDb?: number
  toneTrebleDb?: number
  toneLowCut?: boolean
  toneHighCut?: boolean
  /** Send amounts into the shared Reverb/Delay buses (linear [0,1], 0 = no send). */
  reverbSend?: number
  delaySend?: number
  /** Equal-power pan, signed [-1,1] (0 = centre). Suppressed-when-default. */
  pan?: number
  /** Leveler (soft-knee compressor) amount, linear [0,1] (0 = off). Suppressed-when-default. */
  levelerAmount?: number
  /** Clip-to-clip crossfades on this track (§12.1); hydrated from PROJECT_STATE. */
  transitions?: Transition[]
}

/** Project-shared Reverb. Scalars linear [0,1]; `mix` 0 = inaudible. */
export interface ProjectReverbState {
  size: number
  decay: number
  tone: number
  mix: number
}

/** Project-shared tempo-locked Delay. `noteValue` is a beat division; others linear [0,1]; `mix` 0 = inaudible. */
export interface ProjectDelayState {
  noteValue: DelayNoteValue
  feedback: number
  tone: number
  mix: number
}

/** Default visible length of a new empty track — 10 minutes. */
export const DEFAULT_TRACK_LENGTH_MS = 10 * 60 * 1000

/**
 * Upper bound on a track's linear volume — the linear equivalent of MAX_TRACK_DB
 * (+6 dB ≈ 1.9953). TrackHeaderPanel's taper puts unity near the top of fader
 * travel. Saved projects clamp incoming `gain` to this domain; older files load identically.
 */
export const MAX_TRACK_VOLUME = MAX_TRACK_GAIN_LINEAR

/**
 * Fixed 16-entry palette presented in the track-header colour picker. Each
 * entry bundles three shades of one hue (fill = clip body, border = outline,
 * wave = waveform peaks). Values are 0x-prefixed because PixiJS Graphics
 * consumes that form; hues roughly follow the Tailwind palette.
 */
export interface TrackPaletteEntry {
  readonly id: string
  readonly cssHex: string
  readonly fill: number
  readonly border: number
  readonly wave: number
}
export const TRACK_PALETTE: readonly TrackPaletteEntry[] = [
  { id: 'blue', cssHex: '#3b82f6', fill: 0x1e3a8a, border: 0x3b82f6, wave: 0x93c5fd },
  { id: 'red', cssHex: '#ef4444', fill: 0x7f1d1d, border: 0xef4444, wave: 0xfca5a5 },
  { id: 'orange', cssHex: '#f97316', fill: 0x7c2d12, border: 0xf97316, wave: 0xfdba74 },
  { id: 'amber', cssHex: '#f59e0b', fill: 0x78350f, border: 0xf59e0b, wave: 0xfcd34d },
  { id: 'yellow', cssHex: '#eab308', fill: 0x713f12, border: 0xeab308, wave: 0xfde047 },
  { id: 'lime', cssHex: '#84cc16', fill: 0x365314, border: 0x84cc16, wave: 0xbef264 },
  { id: 'emerald', cssHex: '#10b981', fill: 0x064e3b, border: 0x10b981, wave: 0x6ee7b7 },
  { id: 'teal', cssHex: '#14b8a6', fill: 0x134e4a, border: 0x14b8a6, wave: 0x5eead4 },
  { id: 'cyan', cssHex: '#06b6d4', fill: 0x164e63, border: 0x06b6d4, wave: 0x67e8f9 },
  { id: 'sky', cssHex: '#0ea5e9', fill: 0x0c4a6e, border: 0x0ea5e9, wave: 0x7dd3fc },
  { id: 'indigo', cssHex: '#6366f1', fill: 0x312e81, border: 0x6366f1, wave: 0xa5b4fc },
  { id: 'violet', cssHex: '#8b5cf6', fill: 0x4c1d95, border: 0x8b5cf6, wave: 0xc4b5fd },
  { id: 'fuchsia', cssHex: '#d946ef', fill: 0x701a75, border: 0xd946ef, wave: 0xf0abfc },
  { id: 'pink', cssHex: '#ec4899', fill: 0x831843, border: 0xec4899, wave: 0xf9a8d4 },
  { id: 'rose', cssHex: '#f43f5e', fill: 0x881337, border: 0xf43f5e, wave: 0xfda4af },
  { id: 'zinc', cssHex: '#a1a1aa', fill: 0x3f3f46, border: 0xa1a1aa, wave: 0xd4d4d8 }
] as const

/** Snapshot of a clip's reproducible state, used by Cut / Copy / Paste. */
export interface ClipboardEntry {
  sourceTrackId: string
  /** Source clip's `startMs`; paste lands at the playhead. */
  sourceStartMs: number
  /** Source clip's `durationMs`. */
  sourceDurationMs: number
  libraryItemId: string
  filePath: string
  inMs: number
  durationMs: number
  colorIndex?: number
  name?: string
  /** Warp settings carried across copy/paste to preserve tempo/pitch. */
  warpEnabled?: boolean
  warpMode?: ClipWarpMode
  tempoRatio?: number
  semitones?: number
  cents?: number
  effectiveDurationMs?: number
  effectiveTempoRatio?: number
  effectiveWarpActive?: boolean
}

/** Default name shown in the title bar before a project is named or loaded. */
export const DEFAULT_PROJECT_NAME = 'Untitled'

/** Reactive store state shape for the project store. */
export interface ProjectState {
  tracks: Track[]
  clips: Record<string, Clip>
  markers: Marker[]
  /** Bumped on any clip peaks change — a cheap reactive redraw signal (peaks mutate in place). */
  peaksRevision: number

  // ─── Project file identity ───────────────────────────────────────────────
  /** Absolute path of the loaded `.silverdaw` file; null until first saved. */
  currentFilePath: string | null
  /** User-facing project name. `Untitled` for an unsaved project. */
  projectName: string
  /** Mutated since last load/save/new. Driven by PROJECT_DIRTY; reset on every PROJECT_STATE apply. */
  isDirty: boolean
  /** Stable id bucketing autosave artefacts. Derived from the file path (saved) or a
   *  UUID (untitled); refreshed on PROJECT_STATE reset=true. Null until first snapshot. */
  projectId: string | null
  /** Project id from the recovery manifest while an untitled recovery load is in flight. */
  pendingRecoveredProjectId: string | null
  /** `projectId` before the last Load/New/Save As; lets autosave delete the old bucket safely. */
  previousProjectId: string | null
  /** Engine recovery in flight: suppresses autosave writes and bucket-cleanup so the
   *  reconnect snapshot can't delete the autosave we're restoring from. */
  recoveryInFlight: boolean
  /** Persisted horizontal zoom (px/sec). Null = no preference yet (keep renderer default). */
  viewPxPerSecond: number | null
  /** Persisted horizontal scroll (px); same null semantics as `viewPxPerSecond`. */
  viewScrollX: number | null

  /** Bottom panel shows Track FX (vs Library). Persisted as non-dirty view state. */
  fxPanelOpen: boolean

  /** Which FX rack the bottom panel shows: per-track or project-wide. UI-only (not persisted). */
  fxTab: 'track' | 'project'

  /** Selected clip id (UI-only). Drives the selection outline and Cut/Copy target. */
  selectedClipId: string | null

  /** Selected track id — paste target and Track FX target. Persisted as non-dirty view state. */
  selectedTrackId: string | null

  /** Cut/copy buffer for `pasteClipAtPlayhead`. Renderer-only; cleared on load/new. */
  clipboardClip: ClipboardEntry | null

  /** Source clip id -> last duplicated clip id for repeated duplicate commands. */
  duplicateTailBySource: Record<string, string>

  /** Backend UndoManager availability; drives the Edit > Undo/Redo menu. From EDIT_UNDO_STATE. */
  canUndo: boolean
  canRedo: boolean
  /** Next undo/redo transaction label; null when the matching `can…` flag is false. */
  undoLabel: string | null
  redoLabel: string | null

  /** Per-project preferred output device. Null = no override. On load, bridgeService
   *  switches to it if available, else warns and keeps the user-scope device. */
  audioOutputTypeName: string | null
  audioOutputDeviceName: string | null

  /** Target sample rate (Hz) driving the playback-cache rebuild. Null = adopt user default. 44100/48000 only. */
  targetSampleRate: number | null
  /** Opaque renderer-owned JSON of last-used export-dialog settings; backend round-trips it verbatim. Null = defaults. */
  exportSettingsJson: string | null
  /** Master output volume (0..1 linear), applied to live mix and exports. Persisted. */
  masterVolume: number
  /** Project-shared Reverb; persisted. Defaults all-zero (inaudible). */
  projectReverb: ProjectReverbState
  /** Project-shared tempo-locked Delay. Defaults 1/8-note, zero feedback/tone/mix (inaudible). */
  projectDelay: ProjectDelayState
}

// Backend -> Renderer (inbound) wire-protocol schemas + guards.
// Re-exported through the stable `@shared/bridge-protocol` facade.
//
// FILE-SIZE EXCEPTION (justified): cohesive inbound zod schema graph plus
// matching runtime guards. Keeping them together avoids a fragile import web;
// splitting is deferred to preserve the schema/guard boundary.

import { z } from 'zod'

// ─── Backend → Renderer (inbound) ───────────────────────────────────────────

/** Per-clip warp processor mode; kept local to avoid importing outbound aliases. */
const clipWarpModeSchema = z.enum(['rhythmic', 'tonal', 'complex'])

export const ReadyPayloadSchema = z.object({
  version: z.string()
})
export type ReadyPayload = z.infer<typeof ReadyPayloadSchema>

export const PlayheadUpdatePayloadSchema = z.object({
  positionMs: z.number(),
  isPlaying: z.boolean()
})
export type PlayheadUpdatePayload = z.infer<typeof PlayheadUpdatePayloadSchema>

/** PING reply from the JUCE message thread; echoes `id` to discard stale pongs. */
export const PongPayloadSchema = z.object({
  id: z.number()
})
export type PongPayload = z.infer<typeof PongPayloadSchema>

/** Non-fatal handler failure; `context` carries the offending envelope type. */
export const EngineErrorPayloadSchema = z.object({
  message: z.string(),
  context: z.string().optional()
})
export type EngineErrorPayload = z.infer<typeof EngineErrorPayloadSchema>

export const ClipAckPayloadSchema = z.object({
  trackId: z.string(),
  clipId: z.string(),
  libraryItemId: z.string(),
  ok: z.boolean(),
  error: z.string().optional()
})
export type ClipAckPayload = z.infer<typeof ClipAckPayloadSchema>

/** Ack for `TRACK_ADD`; backend add is idempotent for renderer-created ids. */
export const TrackAddedPayloadSchema = z.object({
  trackId: z.string(),
  ok: z.boolean()
})
export type TrackAddedPayload = z.infer<typeof TrackAddedPayloadSchema>

/** Ack for `TRACK_REMOVE`; negative ack is logged after optimistic removal. */
export const TrackRemovedPayloadSchema = z.object({
  trackId: z.string(),
  ok: z.boolean()
})
export type TrackRemovedPayload = z.infer<typeof TrackRemovedPayloadSchema>

/** Ack for `CLIP_REMOVE`; negative ack is logged after optimistic removal. */
export const ClipRemovedPayloadSchema = z.object({
  clipId: z.string(),
  ok: z.boolean()
})
export type ClipRemovedPayload = z.infer<typeof ClipRemovedPayloadSchema>

/** Ack for `TRACK_GAIN`; echoes the applied gain after backend clamping. */
export const TrackGainAppliedPayloadSchema = z.object({
  trackId: z.string(),
  gain: z.number(),
  ok: z.boolean()
})
export type TrackGainAppliedPayload = z.infer<typeof TrackGainAppliedPayloadSchema>

/** Ack for `TRACK_MUTE` — echoes the muted flag the backend persisted. */
export const TrackMuteAppliedPayloadSchema = z.object({
  trackId: z.string(),
  muted: z.boolean(),
  ok: z.boolean()
})
export type TrackMuteAppliedPayload = z.infer<typeof TrackMuteAppliedPayloadSchema>

/** Ack for `TRACK_SOLO` — echoes the soloed flag the backend persisted. */
export const TrackSoloAppliedPayloadSchema = z.object({
  trackId: z.string(),
  soloed: z.boolean(),
  ok: z.boolean()
})
export type TrackSoloAppliedPayload = z.infer<typeof TrackSoloAppliedPayloadSchema>

/** Ack for `TRACK_SET_SENDS`; delta ack avoids full snapshots during fader streams. */
export const TrackSendsAppliedPayloadSchema = z.object({
  trackId: z.string(),
  reverbSend: z.number(),
  delaySend: z.number(),
  ok: z.boolean()
})
export type TrackSendsAppliedPayload = z.infer<typeof TrackSendsAppliedPayloadSchema>

/** Ack for `TRACK_SET_TONE`; echoes the merged full Tone state. */
export const TrackToneAppliedPayloadSchema = z.object({
  trackId: z.string(),
  bassDb: z.number(),
  midDb: z.number(),
  trebleDb: z.number(),
  filter: z.number(),
  ok: z.boolean()
})
export type TrackToneAppliedPayload = z.infer<typeof TrackToneAppliedPayloadSchema>

/** Ack for `TRACK_SET_LEVELER` — echoes the clamped amount. */
export const TrackLevelerAppliedPayloadSchema = z.object({
  trackId: z.string(),
  amount: z.number(),
  ok: z.boolean()
})
export type TrackLevelerAppliedPayload = z.infer<typeof TrackLevelerAppliedPayloadSchema>

/** Ack for `TRACK_SET_PAN`; delta ack avoids full snapshots during pan drags. */
export const TrackPanAppliedPayloadSchema = z.object({
  trackId: z.string(),
  pan: z.number(),
  ok: z.boolean()
})
export type TrackPanAppliedPayload = z.infer<typeof TrackPanAppliedPayloadSchema>

const ClipEnvelopePointSchema = z.object({
  timeMs: z.number().nonnegative(),
  gain: z.number().min(0).max(4)
})
export type ClipEnvelopePointAck = z.infer<typeof ClipEnvelopePointSchema>

/** Ack for `CLIP_SET_ENVELOPE`; echoes sorted, clamped points. Empty clears. */
export const ClipEnvelopeAppliedPayloadSchema = z.object({
  clipId: z.string(),
  points: z.array(ClipEnvelopePointSchema),
  ok: z.boolean()
})
export type ClipEnvelopeAppliedPayload = z.infer<typeof ClipEnvelopeAppliedPayloadSchema>

/** Ack for `PROJECT_SET_REVERB` — echoes the full clamped reverb state. */
export const ProjectReverbAppliedPayloadSchema = z.object({
  size: z.number().min(0).max(1),
  decay: z.number().min(0).max(1),
  tone: z.number().min(0).max(1),
  mix: z.number().min(0).max(1),
  ok: z.boolean()
})
export type ProjectReverbAppliedPayload = z.infer<typeof ProjectReverbAppliedPayloadSchema>

/** Ack for `PROJECT_SET_DELAY` — echoes the full clamped delay state. */
export const ProjectDelayAppliedPayloadSchema = z.object({
  noteValue: z.enum(['1/4', '1/8', '1/8T', '1/16']),
  feedback: z.number().min(0).max(1),
  tone: z.number().min(0).max(1),
  mix: z.number().min(0).max(1),
  ok: z.boolean()
})
export type ProjectDelayAppliedPayload = z.infer<typeof ProjectDelayAppliedPayloadSchema>

export const ProjectViewStateSavedPayloadSchema = z.object({
  filePath: z.string(),
  ok: z.boolean(),
  error: z.string().optional()
})
export type ProjectViewStateSavedPayload = z.infer<typeof ProjectViewStateSavedPayloadSchema>

/** Ack for invisible autosave; no `PROJECT_STATE` or `PROJECT_DIRTY` follow-up. */
export const ProjectAutosavedPayloadSchema = z.object({
  filePath: z.string(),
  ok: z.boolean(),
  error: z.string().optional()
})
export type ProjectAutosavedPayload = z.infer<typeof ProjectAutosavedPayloadSchema>

/** Backend-authoritative project snapshot; renderer-only metadata stays local. */
export const ProjectStateClipSchema = z.object({
  id: z.string(),
  libraryItemId: z.string(),
  offsetMs: z.number(),
  effectiveDurationMs: z.number().optional(),
  effectiveTempoRatio: z.number().optional(),
  effectiveWarpActive: z.boolean().optional(),
  durationMs: z.number(),
  /** Source-time trim offset; omitted means 0. */
  inMs: z.number().optional(),
  colorIndex: z.number().optional(),
  /** Per-clip lock; not propagated across library-clip siblings. */
  locked: z.boolean().optional(),
  /** Play the clip window backwards; non-destructive. Propagates across library-clip siblings. */
  reversed: z.boolean().optional(),
  name: z.string().optional(),
  /** Source file is missing; engine skips playback. */
  unresolved: z.boolean().optional(),
  /** Optional warp fields default to the no-warp identity for legacy round-trips. */
  warpEnabled: z.boolean().optional(),
  warpMode: clipWarpModeSchema.optional(),
  tempoRatio: z.number().optional(),
  semitones: z.number().optional(),
  cents: z.number().optional(),
  /** Clip awaits source BPM before backend can resolve auto-warp. */
  pendingAutoWarp: z.boolean().optional(),
  // Per-clip volume envelope, stored flat to match the backend ValueTree.
  /** Stored sorted ascending by `timeMs`; empty/absent means unused. */
  envelopePoints: z
    .array(
      z.object({
        timeMs: z.number().nonnegative(),
        gain: z.number().min(0).max(4)
      })
    )
    .optional()
})
export type ProjectStateClip = z.infer<typeof ProjectStateClipSchema>

/** Clip-transition recipe; discriminated union keeps variant handling wire-safe. */
export const TransitionRecipeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('smooth') }),
  z.object({ kind: z.literal('linear') })
])
export type TransitionRecipe = z.infer<typeof TransitionRecipeSchema>

/** Crossfade source of truth; backend derives overlap and deletes invalid transitions. */
export const ProjectStateTransitionSchema = z.object({
  id: z.string(),
  leftClipId: z.string(),
  rightClipId: z.string(),
  recipe: TransitionRecipeSchema
})
export type ProjectStateTransition = z.infer<typeof ProjectStateTransitionSchema>

export const ProjectStateTrackSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  gain: z.number(),
  muted: z.boolean().optional(),
  soloed: z.boolean().optional(),
  heightPx: z.number().optional(),
  /** Persisted palette colour; absent falls back to the renderer's positional default. */
  colorIndex: z.number().optional(),
  // Per-track FX stored flat to match the backend ValueTree.
  sendReverb: z.number().optional(),
  sendDelay: z.number().optional(),
  /** Fixed 3-band EQ, dB in `[-15, +15]`. */
  toneBassDb: z.number().optional(),
  toneMidDb: z.number().optional(),
  toneTrebleDb: z.number().optional(),
  /** Bipolar DJ-style Filter sweep, `[-1, +1]` (0 = off; <0 High Cut, >0 Low Cut). */
  toneFilter: z.number().optional(),
  levelerAmount: z.number().optional(),
  /** Equal-power pan, signed `[-1, 1]` (0 = centre). */
  pan: z.number().optional(),
  clips: z.array(ProjectStateClipSchema),
  transitions: z.array(ProjectStateTransitionSchema).optional()
})
export type ProjectStateTrack = z.infer<typeof ProjectStateTrackSchema>

export const ProjectStateMarkerSchema = z.object({
  id: z.string(),
  positionMs: z.number()
})
export type ProjectStateMarker = z.infer<typeof ProjectStateMarkerSchema>

export type LibraryItemKind = 'source' | 'stem' | 'sample' | 'clip'
const libraryItemKindSchema = z.enum(['source', 'stem', 'sample', 'clip'])

export const ProjectStateLibraryItemSchema = z
  .object({
    id: z.string(),
    filePath: z.string(),
    /** Older projects omit this and are treated as whole source files. */
    kind: libraryItemKindSchema.optional(),
    name: z.string().optional(),
    fileName: z.string().optional(),
    durationMs: z.number().optional(),
    sampleRate: z.number().optional(),
    channelCount: z.number().optional(),
    key: z.string().optional(),
    /** Detected BPM, rounded to 2 d.p. on disk. */
    bpm: z.number().optional(),
    /** Detected beat positions in source seconds. */
    beats: z.array(z.number()).optional(),
    /** Regression-derived beat-grid phase anchor in seconds; may be negative. */
    beatAnchorSec: z.number().optional(),
    /** Decoded PCM cache path reused for clip playback. */
    playbackFilePath: z.string().optional(),
    /** Running tempo fluctuated enough to skip project-BPM seeding. */
    variableTempo: z.boolean().optional(),
    /** Backend auto-classification hint; mirrors `LIBRARY_ITEM_ANALYSIS`. */
    lowConfidence: z.boolean().optional(),
    /** User override; absent means auto via `lowConfidence`. */
    audioType: z.enum(['simple', 'music']).optional(),
    sourceItemId: z.string().optional(),
    sourceClipId: z.string().optional(),
    sourceInMs: z.number().optional(),
    sourceDurationMs: z.number().optional(),
    /** Media GUID minted at first import; key into the project's metadata/covers store. */
    mediaId: z.string().optional(),
    collapsed: z.boolean().optional(),
    unresolved: z.boolean().optional(),
    /** Saved-clip warp defaults are copy-on-drop, not live-linked. */
    warpEnabled: z.boolean().optional(),
    warpMode: clipWarpModeSchema.optional(),
    tempoRatio: z.number().optional(),
    semitones: z.number().optional(),
    cents: z.number().optional()
  })
  // Saved clips must carry window pointers; stems must point at their source.
  .superRefine((item, ctx) => {
    if (item.kind === 'clip') {
      if (typeof item.sourceInMs !== 'number') {
        ctx.addIssue({ code: 'custom', path: ['sourceInMs'], message: 'required when kind === clip' })
      }
      if (typeof item.sourceDurationMs !== 'number') {
        ctx.addIssue({ code: 'custom', path: ['sourceDurationMs'], message: 'required when kind === clip' })
      }
    }
    if (item.kind === 'stem' && (item.sourceItemId === undefined || item.sourceItemId === '')) {
      ctx.addIssue({ code: 'custom', path: ['sourceItemId'], message: 'required when kind === stem' })
    }
  })
export type ProjectStateLibraryItem = z.infer<typeof ProjectStateLibraryItemSchema>

export const ProjectStatePayloadSchema = z.object({
  filePath: z.string().nullable(),
  name: z.string(),
  /** When true, wipe optimistic local state before applying this snapshot. */
  reset: z.boolean().optional(),
  /** Undo/Redo reconcile: replace project contents without resetting UI-only state. */
  softReplace: z.boolean().optional(),
  /** Backend-authoritative unsaved-changes flag; absent only from legacy backends. */
  dirty: z.boolean().optional(),
  viewPxPerSecond: z.number().optional(),
  viewScrollX: z.number().optional(),
  viewSelectedTrack: z.string().optional(),
  viewFxPanelOpen: z.boolean().optional(),
  playheadMs: z.number().optional(),
  bpm: z.number().optional(),
  projectLengthMs: z.number().optional(),
  /** `null`/absent device preference leaves the live user-scope device unchanged. */
  audioOutputTypeName: z.string().nullable().optional(),
  audioOutputDeviceName: z.string().nullable().optional(),
  /** Target sample rate (Hz) for playback-cache rebuilds; absent uses preference fallback. */
  targetSampleRate: z.number().optional(),
  /** Renderer-owned export settings JSON; backend round-trips it opaque. */
  exportSettingsJson: z.string().optional().nullable(),
  masterVolume: z.number().min(0).max(1).optional(),
  /** First bar number shown on the ruler: 1 (default) labels the first bar "1"; 0 or lower for lead-in. */
  barCounterStart: z.number().optional(),
  /** Displayed bar number a mixdown begins from; 1 (default) is the first bar. */
  mixdownStartBar: z.number().optional(),
  /** Monitoring metronome click toggle; absent/false means off (the default). */
  metronomeEnabled: z.boolean().optional(),
  // Project-shared FX bus parameters, stored flat on PROJECT.
  reverbSize: z.number().min(0).max(1).optional(),
  reverbDecay: z.number().min(0).max(1).optional(),
  reverbTone: z.number().min(0).max(1).optional(),
  reverbMix: z.number().min(0).max(1).optional(),
  delayNoteValue: z.enum(['1/4', '1/8', '1/8T', '1/16']).optional(),
  delayFeedback: z.number().min(0).max(1).optional(),
  delayTone: z.number().min(0).max(1).optional(),
  delayMix: z.number().min(0).max(1).optional(),
  markers: z.array(ProjectStateMarkerSchema).optional(),
  /** Persisted library catalogue; cover art/ID3 metadata is re-fetched on load. */
  library: z.array(ProjectStateLibraryItemSchema).optional(),
  tracks: z.array(ProjectStateTrackSchema)
})
export type ProjectStatePayload = z.infer<typeof ProjectStatePayloadSchema>

export const ProjectSavedPayloadSchema = z.object({
  filePath: z.string(),
  ok: z.boolean(),
  error: z.string().optional()
})
export type ProjectSavedPayload = z.infer<typeof ProjectSavedPayloadSchema>

export const ProjectLoadFailedPayloadSchema = z.object({
  filePath: z.string(),
  error: z.string()
})
export type ProjectLoadFailedPayload = z.infer<typeof ProjectLoadFailedPayloadSchema>

export const ProjectRenamedPayloadSchema = z.object({
  name: z.string(),
  ok: z.boolean()
})
export type ProjectRenamedPayload = z.infer<typeof ProjectRenamedPayloadSchema>

export const ProjectDirtyPayloadSchema = z.object({
  dirty: z.boolean()
})
export type ProjectDirtyPayload = z.infer<typeof ProjectDirtyPayloadSchema>

/** Peaks are read from disk, not streamed. Cache: 28-byte header + channel-major min/max float32 pairs. */
export const WaveformReadyPayloadSchema = z.object({
  clipId: z.string(),
  cachePath: z.string(),
  /** Number of (min, max) pairs per lane, not bytes or floats. */
  peakCount: z.number(),
  /** Channel-major lanes: 1 summary or 3 summary + L/R. */
  laneCount: z.number().int().min(1).max(8).optional().default(1),
  peaksPerSecond: z.number(),
  sampleRate: z.number()
})
export type WaveformReadyPayload = z.infer<typeof WaveformReadyPayloadSchema>

/** Clip Editor peaks use the `WAVEFORM_READY` cache layout, keyed by library item. */
export const ClipEditorPeaksReadyPayloadSchema = z.object({
  libraryItemId: z.string(),
  cachePath: z.string(),
  peakCount: z.number(),
  laneCount: z.number().int().min(1).max(8).optional().default(1),
  peaksPerSecond: z.number(),
  sampleRate: z.number()
})
export type ClipEditorPeaksReadyPayload = z.infer<typeof ClipEditorPeaksReadyPayloadSchema>

// SAMPLE_SAVED is discriminated by `ok`: failures are small, successes carry metadata.
const SampleSavedFailureSchema = z.object({
  clipId: z.string().optional(),
  libraryItemId: z.string().optional(),
  itemId: z.string(),
  ok: z.literal(false),
  error: z.string().optional()
})
const SampleSavedSuccessSchema = z.object({
  clipId: z.string().optional(),
  libraryItemId: z.string().optional(),
  itemId: z.string(),
  ok: z.literal(true),
  filePath: z.string(),
  fileName: z.string(),
  name: z.string(),
  durationMs: z.number(),
  sampleRate: z.number(),
  channelCount: z.number(),
  cachePath: z.string(),
  peakCount: z.number(),
  laneCount: z.number().int().min(1).max(8).optional().default(1),
  peaksPerSecond: z.number(),
  // Echoed back so the renderer classifies the new item and (for music)
  // inherits the source's display metadata / cover art.
  audioType: z.enum(['simple', 'music']).optional(),
  sourceItemId: z.string().optional(),
  /** Source window start in ms; shifts the inherited beat grid for a music sample. */
  sourceInMs: z.number().optional(),
  error: z.string().optional()
})
export const SampleSavedPayloadSchema = z.discriminatedUnion('ok', [
  SampleSavedSuccessSchema,
  SampleSavedFailureSchema
])
export type SampleSavedPayload = z.infer<typeof SampleSavedPayloadSchema>

/** BPM/beat detection result; `beats` are source seconds, `variableTempo` skips BPM seeding. */
export const LibraryItemAnalysisPayloadSchema = z.object({
  itemId: z.string(),
  bpm: z.number(),
  /** Regression-derived beat-grid phase anchor in seconds; may be negative. */
  beatAnchorSec: z.number(),
  beats: z.array(z.number()),
  variableTempo: z.boolean(),
  /** Auto-classification hint; user can override via `audioType`. */
  lowConfidence: z.boolean().optional(),
  /** Decoded PCM cache path reused for clip playback. */
  playbackFilePath: z.string().optional()
})
export type LibraryItemAnalysisPayload = z.infer<typeof LibraryItemAnalysisPayloadSchema>

/** Backend-seeded project BPM; renderer applies without echoing `PROJECT_SET_BPM`. */
export const ProjectBpmAppliedPayloadSchema = z.object({
  bpm: z.number()
})
export type ProjectBpmAppliedPayload = z.infer<typeof ProjectBpmAppliedPayloadSchema>

/** Server-side warp update, including late auto-warp after source BPM analysis. */
export const ClipWarpAppliedPayloadSchema = z.object({
  clipId: z.string(),
  warpEnabled: z.boolean().optional(),
  warpMode: clipWarpModeSchema.optional(),
  /** `null` clears the pinned override; absent means "no change". */
  tempoRatio: z.number().nullable().optional(),
  semitones: z.number().optional(),
  cents: z.number().optional(),
  pendingAutoWarp: z.boolean().optional(),
  effectiveDurationMs: z.number().optional(),
  effectiveTempoRatio: z.number().optional(),
  effectiveWarpActive: z.boolean().optional()
})
export type ClipWarpAppliedPayload = z.infer<typeof ClipWarpAppliedPayloadSchema>

export const PreviewStatePayloadSchema = z.object({
  libraryItemId: z.string().optional(),
  isPlaying: z.boolean(),
  isLoaded: z.boolean(),
  durationMs: z.number(),
  /** Monotonic load/unload counter used to discard stale preview state. */
  generation: z.number()
})
export type PreviewStatePayload = z.infer<typeof PreviewStatePayloadSchema>

export const PreviewPositionPayloadSchema = z.object({
  positionMs: z.number(),
  isPlaying: z.boolean(),
  generation: z.number()
})
export type PreviewPositionPayload = z.infer<typeof PreviewPositionPayloadSchema>

export const PreviewEndedPayloadSchema = z.object({
  generation: z.number()
})
export type PreviewEndedPayload = z.infer<typeof PreviewEndedPayloadSchema>

export const AudioDeviceTypeListingSchema = z.object({
  /** JUCE type name used as the `AUDIO_DEVICE_SELECT` discriminator. */
  name: z.string(),
  devices: z.array(z.string())
})
export type AudioDeviceTypeListing = z.infer<typeof AudioDeviceTypeListingSchema>

/** Audio-device snapshot after AUTH, device switch, or JUCE device-list change. */
export const AudioDevicesListPayloadSchema = z.object({
  types: z.array(AudioDeviceTypeListingSchema),
  currentTypeName: z.string().nullable(),
  currentDeviceName: z.string().nullable(),
  currentSampleRate: z.number().optional(),
  currentBufferSize: z.number().optional(),
  /** Effective output latency in ms, subtracted from broadcast playhead. */
  outputLatencyMs: z.number().optional(),
  /** Bluetooth heuristic component in ms; non-zero surfaces a latency hint. */
  heuristicExtraLatencyMs: z.number().optional(),
  /** Saved device was unavailable at startup; cleared on next switch. */
  fellBackToDefault: z.boolean().optional(),
  /** Partial boot snapshot while full device scan is still pending. */
  scanInProgress: z.boolean().optional()
})
export type AudioDevicesListPayload = z.infer<typeof AudioDevicesListPayloadSchema>

/** Ack for `AUDIO_DEVICE_SELECT`; success is followed by `AUDIO_DEVICES_LIST`. */
export const AudioDeviceChangedPayloadSchema = z.object({
  typeName: z.string().nullable(),
  deviceName: z.string().nullable(),
  ok: z.boolean(),
  error: z.string().optional()
})
export type AudioDeviceChangedPayload = z.infer<typeof AudioDeviceChangedPayloadSchema>

/** Backend `juce::UndoManager` head state for Edit menu enablement/labels. */
export const EditUndoStatePayloadSchema = z.object({
  canUndo: z.boolean(),
  canRedo: z.boolean(),
  undoLabel: z.string().optional(),
  redoLabel: z.string().optional()
})
export type EditUndoStatePayload = z.infer<typeof EditUndoStatePayloadSchema>

/** `AUDIO_FILE_PROBE` response; `requestId` matches concurrent probes. */
const AudioFileProbedSuccessSchema = z.object({
  requestId: z.string(),
  ok: z.literal(true),
  filePath: z.string(),
  sampleRate: z.number(),
  channelCount: z.number(),
  durationMs: z.number()
})
const AudioFileProbedFailureSchema = z.object({
  requestId: z.string(),
  ok: z.literal(false),
  filePath: z.string(),
  error: z.string()
})
export const AudioFileProbedPayloadSchema = z.discriminatedUnion('ok', [
  AudioFileProbedSuccessSchema,
  AudioFileProbedFailureSchema
])
export type AudioFileProbedPayload = z.infer<typeof AudioFileProbedPayloadSchema>

/** Mixdown tick; `percent` is 0..100 and monotonic within one render. */
export const MixdownProgressPayloadSchema = z.object({
  percent: z.number(),
  stage: z.enum([
    'prepare',
    'render',
    'finalize',
    'encode',
    'analyze',
    'normalize-pass1',
    'normalize-pass2'
  ])
})
export type MixdownProgressPayload = z.infer<typeof MixdownProgressPayloadSchema>

/** Mixdown success; loudness values are `null` for silent/unmeasurable output. */
export const MixdownDonePayloadSchema = z.object({
  filePath: z.string(),
  durationMs: z.number(),
  loudness: z.optional(z.object({
    integratedLufs: z.union([z.number(), z.null()]),
    truePeakDbtp: z.union([z.number(), z.null()]),
    silent: z.boolean(),
    unmeasurable: z.boolean(),
    gatedBlockCount: z.number(),
    appliedGainDb: z.number(),
    limitedByTruePeak: z.boolean(),
    pass2ClippedSamples: z.number(),
    pass2PostGainPeak: z.number()
  }))
})
export type MixdownDonePayload = z.infer<typeof MixdownDonePayloadSchema>

/** Mixdown failure; `cancelled` dismisses quietly, other codes surface errors. */
export const MixdownFailedPayloadSchema = z.object({
  code: z.enum(['cancelled', 'io', 'decode', 'encode', 'invalid']),
  error: z.string()
})
export type MixdownFailedPayload = z.infer<typeof MixdownFailedPayloadSchema>

/** Audio-thread master peaks drained at ~60 Hz; linear values may exceed 1.0. */
export const MasterLevelPayloadSchema = z.object({
  peakL: z.number().nonnegative(),
  peakR: z.number().nonnegative()
})
export type MasterLevelPayload = z.infer<typeof MasterLevelPayloadSchema>

/** Per-track post-chain peaks; absent tracks are treated as silent. */
export const TrackLevelEntrySchema = z.object({
  id: z.string().min(1),
  peakL: z.number().nonnegative(),
  peakR: z.number().nonnegative()
})
export type TrackLevelEntry = z.infer<typeof TrackLevelEntrySchema>
export const TrackLevelsPayloadSchema = z.object({
  tracks: z.array(TrackLevelEntrySchema)
})
export type TrackLevelsPayload = z.infer<typeof TrackLevelsPayloadSchema>

// ─── Stem separation ────────────────────────────────────────────────────────

/** Canonical 4-stem vocabulary; single source of truth for both bridge ends. */
export const StemNameSchema = z.enum(['vocals', 'drums', 'bass', 'other'])
export type StemName = z.infer<typeof StemNameSchema>

/** Separation tick; `percent` is 0..100 and monotonic within one job. */
export const StemProgressPayloadSchema = z.object({
  jobId: z.string().min(1),
  // Present only for timeline-clip separations; absent for library-source jobs.
  clipId: z.string().min(1).optional(),
  stage: z.enum(['prepare', 'separate', 'cleanup', 'write']),
  percent: z.number(),
  // Optional context for the current step (e.g. the stem name being separated).
  detail: z.string().optional()
})
export type StemProgressPayload = z.infer<typeof StemProgressPayloadSchema>

/** One separated stem written to disk (non-destructive; the original is untouched). */
export const StemFileSchema = z.object({
  stem: StemNameSchema,
  filePath: z.string().min(1)
})
export type StemFile = z.infer<typeof StemFileSchema>

/** Separation success; `stems` are absolute paths the renderer imports as new library items. */
export const StemReadyPayloadSchema = z.object({
  jobId: z.string().min(1),
  clipId: z.string().min(1).optional(),
  sourceName: z.string(),
  stems: z.array(StemFileSchema)
})
export type StemReadyPayload = z.infer<typeof StemReadyPayloadSchema>

/** One stem finished while the job is still running, so its result can be imported
 *  immediately for live feedback. The final STEM_READY backfills any not seen. */
export const StemPartialPayloadSchema = z.object({
  jobId: z.string().min(1),
  clipId: z.string().min(1).optional(),
  sourceName: z.string(),
  stem: StemNameSchema,
  filePath: z.string().min(1)
})
export type StemPartialPayload = z.infer<typeof StemPartialPayloadSchema>

/** Separation failure; `cancelled` dismisses quietly, other codes surface errors. */
export const StemFailedPayloadSchema = z.object({
  jobId: z.string().min(1),
  clipId: z.string().min(1).optional(),
  code: z.enum(['cancelled', 'model', 'decode', 'inference', 'io', 'invalid']),
  error: z.string()
})
export type StemFailedPayload = z.infer<typeof StemFailedPayloadSchema>

export interface BridgeInboundMap {
  READY: ReadyPayload
  PROJECT_STATE: ProjectStatePayload
  PLAYHEAD_UPDATE: PlayheadUpdatePayload
  CLIP_ADDED: ClipAckPayload
  CLIP_ADD_FAILED: ClipAckPayload
  TRACK_ADDED: TrackAddedPayload
  TRACK_REMOVED: TrackRemovedPayload
  CLIP_REMOVED: ClipRemovedPayload
  TRACK_GAIN_APPLIED: TrackGainAppliedPayload
  TRACK_MUTE_APPLIED: TrackMuteAppliedPayload
  TRACK_SOLO_APPLIED: TrackSoloAppliedPayload
  TRACK_SENDS_APPLIED: TrackSendsAppliedPayload
  TRACK_TONE_APPLIED: TrackToneAppliedPayload
  TRACK_LEVELER_APPLIED: TrackLevelerAppliedPayload
  TRACK_PAN_APPLIED: TrackPanAppliedPayload
  CLIP_ENVELOPE_APPLIED: ClipEnvelopeAppliedPayload
  PROJECT_REVERB_APPLIED: ProjectReverbAppliedPayload
  PROJECT_DELAY_APPLIED: ProjectDelayAppliedPayload
  PROJECT_SAVED: ProjectSavedPayload
  PROJECT_VIEW_STATE_SAVED: ProjectViewStateSavedPayload
  PROJECT_AUTOSAVED: ProjectAutosavedPayload
  PROJECT_LOAD_FAILED: ProjectLoadFailedPayload
  PROJECT_RENAMED: ProjectRenamedPayload
  PROJECT_DIRTY: ProjectDirtyPayload
  WAVEFORM_READY: WaveformReadyPayload
  CLIP_EDITOR_PEAKS_READY: ClipEditorPeaksReadyPayload
  SAMPLE_SAVED: SampleSavedPayload
  LIBRARY_ITEM_ANALYSIS: LibraryItemAnalysisPayload
  CLIP_WARP_APPLIED: ClipWarpAppliedPayload
  PROJECT_BPM_APPLIED: ProjectBpmAppliedPayload
  PREVIEW_STATE: PreviewStatePayload
  PREVIEW_POSITION: PreviewPositionPayload
  PREVIEW_ENDED: PreviewEndedPayload
  AUDIO_DEVICES_LIST: AudioDevicesListPayload
  AUDIO_DEVICE_CHANGED: AudioDeviceChangedPayload
  EDIT_UNDO_STATE: EditUndoStatePayload
  AUDIO_FILE_PROBED: AudioFileProbedPayload
  MIXDOWN_PROGRESS: MixdownProgressPayload
  MIXDOWN_DONE: MixdownDonePayload
  MIXDOWN_FAILED: MixdownFailedPayload
  STEM_PROGRESS: StemProgressPayload
  STEM_PARTIAL: StemPartialPayload
  STEM_READY: StemReadyPayload
  STEM_FAILED: StemFailedPayload
  MASTER_LEVEL: MasterLevelPayload
  TRACK_LEVELS: TrackLevelsPayload
  PONG: PongPayload
  ENGINE_ERROR: EngineErrorPayload
}

export type BridgeInboundType = keyof BridgeInboundMap

/** Inbound envelope discriminated on `type` for exhaustive dispatch. */
export type BridgeInboundMessage = {
  [K in BridgeInboundType]: { type: K; payload: BridgeInboundMap[K] }
}[BridgeInboundType]

// ─── Runtime validation ─────────────────────────────────────────────────────

const INBOUND_TYPES: ReadonlySet<BridgeInboundType> = new Set<BridgeInboundType>([
  'READY',
  'PROJECT_STATE',
  'PLAYHEAD_UPDATE',
  'CLIP_ADDED',
  'CLIP_ADD_FAILED',
  'TRACK_ADDED',
  'TRACK_REMOVED',
  'CLIP_REMOVED',
  'TRACK_GAIN_APPLIED',
  'TRACK_MUTE_APPLIED',
  'TRACK_SOLO_APPLIED',
  'TRACK_SENDS_APPLIED',
  'TRACK_TONE_APPLIED',
  'TRACK_LEVELER_APPLIED',
  'TRACK_PAN_APPLIED',
  'CLIP_ENVELOPE_APPLIED',
  'PROJECT_REVERB_APPLIED',
  'PROJECT_DELAY_APPLIED',
  'PROJECT_SAVED',
  'PROJECT_VIEW_STATE_SAVED',
  'PROJECT_AUTOSAVED',
  'PROJECT_LOAD_FAILED',
  'PROJECT_RENAMED',
  'PROJECT_DIRTY',
  'WAVEFORM_READY',
  'CLIP_EDITOR_PEAKS_READY',
  'SAMPLE_SAVED',
  'LIBRARY_ITEM_ANALYSIS',
  'CLIP_WARP_APPLIED',
  'PROJECT_BPM_APPLIED',
  'PREVIEW_STATE',
  'PREVIEW_POSITION',
  'PREVIEW_ENDED',
  'AUDIO_DEVICES_LIST',
  'AUDIO_DEVICE_CHANGED',
  'EDIT_UNDO_STATE',
  'AUDIO_FILE_PROBED',
  'MIXDOWN_PROGRESS',
  'MIXDOWN_DONE',
  'MIXDOWN_FAILED',
  'STEM_PROGRESS',
  'STEM_PARTIAL',
  'STEM_READY',
  'STEM_FAILED',
  'MASTER_LEVEL',
  'TRACK_LEVELS',
  'PONG',
  'ENGINE_ERROR'
])

/** Narrow an unknown string to the inbound type union. */
export function isBridgeInboundType(value: unknown): value is BridgeInboundType {
  return typeof value === 'string' && INBOUND_TYPES.has(value as BridgeInboundType)
}

// Guards delegate to the matching zod schema.

export function isReadyPayload(value: unknown): value is ReadyPayload {
  return ReadyPayloadSchema.safeParse(value).success
}

export function isPlayheadUpdatePayload(value: unknown): value is PlayheadUpdatePayload {
  return PlayheadUpdatePayloadSchema.safeParse(value).success
}

export function isPongPayload(value: unknown): value is PongPayload {
  return PongPayloadSchema.safeParse(value).success
}

export function isEngineErrorPayload(value: unknown): value is EngineErrorPayload {
  return EngineErrorPayloadSchema.safeParse(value).success
}

export function isClipAckPayload(value: unknown): value is ClipAckPayload {
  return ClipAckPayloadSchema.safeParse(value).success
}

export function isTrackAddedPayload(value: unknown): value is TrackAddedPayload {
  return TrackAddedPayloadSchema.safeParse(value).success
}

export function isProjectStatePayload(value: unknown): value is ProjectStatePayload {
  return ProjectStatePayloadSchema.safeParse(value).success
}

export function isProjectSavedPayload(value: unknown): value is ProjectSavedPayload {
  return ProjectSavedPayloadSchema.safeParse(value).success
}

export function isProjectViewStateSavedPayload(value: unknown): value is ProjectViewStateSavedPayload {
  return ProjectViewStateSavedPayloadSchema.safeParse(value).success
}

export function isProjectAutosavedPayload(value: unknown): value is ProjectAutosavedPayload {
  return ProjectAutosavedPayloadSchema.safeParse(value).success
}

export function isProjectLoadFailedPayload(value: unknown): value is ProjectLoadFailedPayload {
  return ProjectLoadFailedPayloadSchema.safeParse(value).success
}

export function isProjectRenamedPayload(value: unknown): value is ProjectRenamedPayload {
  return ProjectRenamedPayloadSchema.safeParse(value).success
}

export function isProjectDirtyPayload(value: unknown): value is ProjectDirtyPayload {
  return ProjectDirtyPayloadSchema.safeParse(value).success
}

export function isWaveformReadyPayload(value: unknown): value is WaveformReadyPayload {
  return WaveformReadyPayloadSchema.safeParse(value).success
}

export function isClipEditorPeaksReadyPayload(value: unknown): value is ClipEditorPeaksReadyPayload {
  return ClipEditorPeaksReadyPayloadSchema.safeParse(value).success
}

export function isSampleSavedPayload(value: unknown): value is SampleSavedPayload {
  return SampleSavedPayloadSchema.safeParse(value).success
}

export function isTrackRemovedPayload(value: unknown): value is TrackRemovedPayload {
  return TrackRemovedPayloadSchema.safeParse(value).success
}

export function isClipRemovedPayload(value: unknown): value is ClipRemovedPayload {
  return ClipRemovedPayloadSchema.safeParse(value).success
}

export function isTrackGainAppliedPayload(value: unknown): value is TrackGainAppliedPayload {
  return TrackGainAppliedPayloadSchema.safeParse(value).success
}

export function isTrackMuteAppliedPayload(value: unknown): value is TrackMuteAppliedPayload {
  return TrackMuteAppliedPayloadSchema.safeParse(value).success
}

export function isTrackSoloAppliedPayload(value: unknown): value is TrackSoloAppliedPayload {
  return TrackSoloAppliedPayloadSchema.safeParse(value).success
}

export function isTrackSendsAppliedPayload(value: unknown): value is TrackSendsAppliedPayload {
  return TrackSendsAppliedPayloadSchema.safeParse(value).success
}

export function isTrackToneAppliedPayload(value: unknown): value is TrackToneAppliedPayload {
  return TrackToneAppliedPayloadSchema.safeParse(value).success
}

export function isTrackLevelerAppliedPayload(value: unknown): value is TrackLevelerAppliedPayload {
  return TrackLevelerAppliedPayloadSchema.safeParse(value).success
}

export function isTrackPanAppliedPayload(value: unknown): value is TrackPanAppliedPayload {
  return TrackPanAppliedPayloadSchema.safeParse(value).success
}

export function isClipEnvelopeAppliedPayload(value: unknown): value is ClipEnvelopeAppliedPayload {
  return ClipEnvelopeAppliedPayloadSchema.safeParse(value).success
}

export function isProjectReverbAppliedPayload(value: unknown): value is ProjectReverbAppliedPayload {
  return ProjectReverbAppliedPayloadSchema.safeParse(value).success
}

export function isProjectDelayAppliedPayload(value: unknown): value is ProjectDelayAppliedPayload {
  return ProjectDelayAppliedPayloadSchema.safeParse(value).success
}

export function isLibraryItemAnalysisPayload(value: unknown): value is LibraryItemAnalysisPayload {
  return LibraryItemAnalysisPayloadSchema.safeParse(value).success
}

export function isProjectBpmAppliedPayload(value: unknown): value is ProjectBpmAppliedPayload {
  return ProjectBpmAppliedPayloadSchema.safeParse(value).success
}

export function isClipWarpAppliedPayload(value: unknown): value is ClipWarpAppliedPayload {
  return ClipWarpAppliedPayloadSchema.safeParse(value).success
}

export function isPreviewStatePayload(value: unknown): value is PreviewStatePayload {
  return PreviewStatePayloadSchema.safeParse(value).success
}

export function isPreviewPositionPayload(value: unknown): value is PreviewPositionPayload {
  return PreviewPositionPayloadSchema.safeParse(value).success
}

export function isPreviewEndedPayload(value: unknown): value is PreviewEndedPayload {
  return PreviewEndedPayloadSchema.safeParse(value).success
}

export function isAudioDevicesListPayload(value: unknown): value is AudioDevicesListPayload {
  return AudioDevicesListPayloadSchema.safeParse(value).success
}

export function isAudioDeviceChangedPayload(value: unknown): value is AudioDeviceChangedPayload {
  return AudioDeviceChangedPayloadSchema.safeParse(value).success
}

export function isEditUndoStatePayload(value: unknown): value is EditUndoStatePayload {
  return EditUndoStatePayloadSchema.safeParse(value).success
}

export function isAudioFileProbedPayload(value: unknown): value is AudioFileProbedPayload {
  return AudioFileProbedPayloadSchema.safeParse(value).success
}

export function isMixdownProgressPayload(value: unknown): value is MixdownProgressPayload {
  return MixdownProgressPayloadSchema.safeParse(value).success
}

export function isMixdownDonePayload(value: unknown): value is MixdownDonePayload {
  return MixdownDonePayloadSchema.safeParse(value).success
}

export function isMixdownFailedPayload(value: unknown): value is MixdownFailedPayload {
  return MixdownFailedPayloadSchema.safeParse(value).success
}

export function isStemProgressPayload(value: unknown): value is StemProgressPayload {
  return StemProgressPayloadSchema.safeParse(value).success
}

export function isStemPartialPayload(value: unknown): value is StemPartialPayload {
  return StemPartialPayloadSchema.safeParse(value).success
}

export function isStemReadyPayload(value: unknown): value is StemReadyPayload {
  return StemReadyPayloadSchema.safeParse(value).success
}

export function isStemFailedPayload(value: unknown): value is StemFailedPayload {
  return StemFailedPayloadSchema.safeParse(value).success
}

export function isMasterLevelPayload(value: unknown): value is MasterLevelPayload {
  return MasterLevelPayloadSchema.safeParse(value).success
}

export function isTrackLevelsPayload(value: unknown): value is TrackLevelsPayload {
  return TrackLevelsPayloadSchema.safeParse(value).success
}

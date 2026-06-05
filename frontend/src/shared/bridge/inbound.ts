// Backend -> Renderer (inbound) wire-protocol schemas + guards.
//
// Part of the bridge protocol catalogue. Inbound payloads are defined as `zod`
// schemas (the single source of truth); the exported TypeScript types are
// derived via `z.infer`. Includes the `BridgeInboundMap`/message unions and the
// `safeParse`-based type guards. Re-exported through the stable
// `@shared/bridge-protocol` facade.
//
// FILE-SIZE EXCEPTION (justified): the inbound schemas form one cohesive zod
// dependency graph (e.g. the composed `ProjectState*` cluster and shared
// private schemas) validated together by `bridge-protocol.test.ts`. The guards
// must import the runtime schema values, so keeping schema + guard together
// avoids a cross-file import web. May be domain-split later if it becomes an
// edit hotspot.

import { z } from 'zod'

// ─── Backend → Renderer (inbound) ───────────────────────────────────────────
//
// Inbound payloads are defined as `zod` schemas. The exported TypeScript
// types are derived via `z.infer<...>` so the schema is the single source
// of truth — there is no separate hand-written interface to drift away
// from the runtime guard. Each guard at the bottom of the file is a
// thin `safeParse(...).success` wrapper over the matching schema.

/** Discriminator for the per-clip warp processor mode. Mirrors the
 *  outbound `ClipWarpMode` union; defined here as its own schema so the
 *  inbound shapes don't import the outbound type alias. */
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

/**
 * Reply to a renderer `PING { id }`. Emitted from the JUCE message thread
 * so its arrival proves the engine command thread is alive. `id` echoes
 * the probe nonce so the renderer can discard stale / out-of-order pongs.
 */
export const PongPayloadSchema = z.object({
  id: z.number()
})
export type PongPayload = z.infer<typeof PongPayloadSchema>

/**
 * Non-fatal engine error. Broadcast when a single message handler throws:
 * the backend catches it, keeps the process alive, and surfaces this so
 * the renderer can log / toast the failure instead of silently losing the
 * command. `context` carries the offending envelope type for diagnostics.
 */
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
  /**
   * Backend-supplied error message. Present iff `ok === false`.
   * Surfaced through `notificationsStore.pushError(...)` in the renderer.
   */
  error: z.string().optional()
})
export type ClipAckPayload = z.infer<typeof ClipAckPayloadSchema>

/**
 * Backend ack for a prior `TRACK_ADD` envelope. `ok === false` means the
 * track id was unknown OR the payload was malformed; rare in practice
 * because the renderer generates the trackId locally and addTrack on
 * the backend is idempotent.
 */
export const TrackAddedPayloadSchema = z.object({
  trackId: z.string(),
  ok: z.boolean()
})
export type TrackAddedPayload = z.infer<typeof TrackAddedPayloadSchema>

/**
 * Backend ack for a prior `TRACK_REMOVE` envelope. `ok === false` means the
 * track id was unknown on the backend (i.e. the renderer's view drifted out
 * of sync). The renderer has already optimistically removed the row, so a
 * negative ack is logged but otherwise non-fatal.
 */
export const TrackRemovedPayloadSchema = z.object({
  trackId: z.string(),
  ok: z.boolean()
})
export type TrackRemovedPayload = z.infer<typeof TrackRemovedPayloadSchema>

/** Backend ack for `CLIP_REMOVE`. `ok=false` means the clip id was
 *  unknown to the project tree. The renderer logs but doesn't re-add
 *  the clip — local optimistic removal already happened. */
export const ClipRemovedPayloadSchema = z.object({
  clipId: z.string(),
  ok: z.boolean()
})
export type ClipRemovedPayload = z.infer<typeof ClipRemovedPayloadSchema>

/**
 * Backend ack for a prior `TRACK_GAIN` envelope, echoing the gain value
 * actually applied (clamped or quantised on the backend if needed) so the
 * renderer can verify the engine state matches local expectations. `ok ===
 * false` means the track id was unknown — gain mismatches are logged as a
 * warning, not surfaced to the user.
 */
export const TrackGainAppliedPayloadSchema = z.object({
  trackId: z.string(),
  /** Linear gain actually applied on the backend. */
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

/**
 * Ack for `TRACK_SET_SENDS` — echoes the clamped send levels the backend
 * persisted. `ok === false` means the track id was unknown.
 *
 * Mirrors the delta-ack pattern used by `TRACK_GAIN_APPLIED` so 60 Hz
 * fader streams don't trigger full `PROJECT_STATE` serialisations. The
 * renderer reconciles its mirror against this payload directly.
 */
export const TrackSendsAppliedPayloadSchema = z.object({
  trackId: z.string(),
  /** Project-Reverb send, 0..1 linear, after backend clamp. */
  reverbSend: z.number(),
  /** Project-Delay send, 0..1 linear, after backend clamp. */
  delaySend: z.number(),
  ok: z.boolean()
})
export type TrackSendsAppliedPayload = z.infer<typeof TrackSendsAppliedPayloadSchema>

/** Ack for `TRACK_SET_TONE`. Echoes the full Tone state after the
 *  backend has merged the partial update with the stored values, so
 *  the renderer doesn't have to track which fields it sent. */
export const TrackToneAppliedPayloadSchema = z.object({
  trackId: z.string(),
  bassDb: z.number(),
  midDb: z.number(),
  trebleDb: z.number(),
  lowCut: z.boolean(),
  highCut: z.boolean(),
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

/** Ack for `TRACK_SET_PAN` — echoes the clamped signed pan in `[-1, 1]`.
 *  `ok === false` means the track id was unknown. Mirrors the delta-ack
 *  pattern used by `TRACK_SENDS_APPLIED` so 60 Hz pan drags don't trigger
 *  full `PROJECT_STATE` serialisations. */
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

/** Ack for `CLIP_SET_ENVELOPE` — echoes the persisted (sorted, clamped)
 *  point array. An empty array indicates the envelope is cleared. */
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

/** Ack for `PROJECT_AUTOSAVE`. Carries no `PROJECT_STATE` or
 *  `PROJECT_DIRTY` follow-up: autosave is deliberately invisible to the
 *  user-facing project lifecycle. */
export const ProjectAutosavedPayloadSchema = z.object({
  filePath: z.string(),
  ok: z.boolean(),
  error: z.string().optional()
})
export type ProjectAutosavedPayload = z.infer<typeof ProjectAutosavedPayloadSchema>

/**
 * Initial backend-authoritative project snapshot sent by the bridge
 * immediately after a successful AUTH handshake. The renderer treats
 * itself as a mirror of this state — see `projectStore.applyProjectStateSnapshot`.
 *
 * Tracks and clips contain only the structural / audio-meaningful fields
 * the backend owns. Render-only metadata (fileName, peaks, sampleRate,
 * channelCount) stays with the renderer's existing optimistic state; on
 * reconnect any clips known only to the backend will appear in the
 * payload but won't render until backend-supplied peaks arrive (Phase 1
 * todo: backend-waveform-data).
 */
export const ProjectStateClipSchema = z.object({
  id: z.string(),
  /** Library item this clip plays from. Source-of-truth for the
   *  underlying audio file; the renderer resolves filePath / fileName /
   *  peaks through the library. */
  libraryItemId: z.string(),
  offsetMs: z.number(),
  /** Backend-authoritative timeline/output duration after warp. */
  effectiveDurationMs: z.number().optional(),
  /** Backend-authoritative tempo ratio used for timing. */
  effectiveTempoRatio: z.number().optional(),
  /** True when tempo warp changes the timeline/output duration. */
  effectiveWarpActive: z.boolean().optional(),
  durationMs: z.number(),
  /** Where in the source file this clip starts reading (trim offset).
   *  Optional: omitted on un-trimmed clips; the renderer falls back to 0. */
  inMs: z.number().optional(),
  /** Per-clip palette index override (0..15). Absent means the clip
   *  inherits the host track's colour. */
  colorIndex: z.number().optional(),
  /** Per-clip lock flag. When true, the timeline UI suppresses move
   *  and trim gestures. Absent/false = unlocked. Per-clip — not
   *  propagated across linked saved-clip siblings. */
  locked: z.boolean().optional(),
  /** User-facing display name override (set via inline rename on the
   *  timeline). Absent means use the library item title / filename. */
  name: z.string().optional(),
  /** True when the library item's source file no longer exists on
   *  disk. Renderer renders the clip greyed-out and surfaces a
   *  "Locate files…" toast; engine playback skips it. */
  unresolved: z.boolean().optional(),
  /** Per-clip warp + pitch settings. All five fields are optional and
   *  default to the no-warp identity (`warpEnabled=false`,
   *  `tempoRatio=1`, `semitones=0`, `cents=0`). Omitted on clips that
   *  have never had warp touched so older project files round-trip
   *  unchanged. See `ClipSetWarpPayload` for the semantics of each
   *  field. */
  warpEnabled: z.boolean().optional(),
  warpMode: clipWarpModeSchema.optional(),
  tempoRatio: z.number().optional(),
  semitones: z.number().optional(),
  cents: z.number().optional(),
  /** Renderer-bookkeeping flag: clip was dropped before its source
   *  BPM was detected. Cleared by the backend's `LIBRARY_ITEM_ANALYSIS`
   *  handler when it auto-flips warp on, or by any explicit
   *  `CLIP_SET_WARP` from the user. */
  pendingAutoWarp: z.boolean().optional(),
  // ─── Phase 5 per-clip volume tailoring. Stored flat on the CLIP node
  //     to match ValueTree storage. `envelopePoints` is a `juce::var`
  //     ARRAY property; an empty array (or absent property) means the
  //     envelope is unused.
  /** Volume-envelope breakpoints. Stored sorted ascending by `timeMs`. */
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

/**
 * Clip-transition recipe — the DSP behaviour applied across the overlap
 * between two adjacent clips. Modelled as a discriminated union on `kind`
 * from day one so future recipes (bass swap, filter fade, delay out, vocal
 * focus) add a variant without breaking the wire contract. v1 ships only
 * the equal-power `smooth` crossfade.
 */
export const TransitionRecipeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('smooth') })
])
export type TransitionRecipe = z.infer<typeof TransitionRecipeSchema>

/**
 * A sanctioned overlap between two adjacent clips on the same track. The
 * transition is the single source of truth for the crossfade; the overlap
 * REGION is derived from the two clips' timeline geometry (never stored)
 * so it can never drift. The backend owns derivation of the per-clip
 * edge-fade gain and auto-deletes the transition when its invariants break
 * (clip removed / moved apart / trimmed shorter than the overlap / a third
 * clip intrudes). `leftClipId` is the earlier clip (fades out); `rightClipId`
 * the later clip (fades in).
 */
export const ProjectStateTransitionSchema = z.object({
  id: z.string(),
  leftClipId: z.string(),
  rightClipId: z.string(),
  recipe: TransitionRecipeSchema
})
export type ProjectStateTransition = z.infer<typeof ProjectStateTransitionSchema>

export const ProjectStateTrackSchema = z.object({
  id: z.string(),
  /** Persisted user-facing track name. Optional for projects saved before this field existed. */
  name: z.string().optional(),
  gain: z.number(),
  /** Persisted muted / soloed flags. Both default to false and are
   *  only present in the JSON when true. Round-trip through save /
   *  load so the user's mute / solo state is restored on reopen. */
  muted: z.boolean().optional(),
  soloed: z.boolean().optional(),
  /** Persisted row height in CSS pixels. Optional for projects saved
   *  before per-track height existed (and for tracks that have never
   *  been resized — the renderer falls back to its default). */
  heightPx: z.number().optional(),
  // ─── Phase 5 per-track FX (all flat to match the backend ValueTree
  //     property layout — ValueTreeJson serialises every property at the
  //     top level of the TRACK node, no nested objects). Each is
  //     suppressed-when-default so legacy projects round-trip unchanged.
  /** Send to the project Reverb bus, 0..1 linear. */
  sendReverb: z.number().optional(),
  /** Send to the project Delay bus, 0..1 linear. */
  sendDelay: z.number().optional(),
  /** Per-track Tone — fixed 3-band EQ, dB in `[-15, +15]`. */
  toneBassDb: z.number().optional(),
  toneMidDb: z.number().optional(),
  toneTrebleDb: z.number().optional(),
  /** Per-track fixed high-pass low-cut filter engage flag. */
  toneLowCut: z.boolean().optional(),
  /** Per-track fixed low-pass high-cut filter engage flag. */
  toneHighCut: z.boolean().optional(),
  /** Per-track Leveler amount, 0..1 (Advanced controls land later). */
  levelerAmount: z.number().optional(),
  /** Per-track equal-power pan, signed `[-1, 1]` (0 = centre). */
  pan: z.number().optional(),
  clips: z.array(ProjectStateClipSchema),
  /** Sanctioned clip-to-clip transitions on this track. Suppressed when
   *  empty so legacy projects round-trip unchanged. */
  transitions: z.array(ProjectStateTransitionSchema).optional()
})
export type ProjectStateTrack = z.infer<typeof ProjectStateTrackSchema>

export const ProjectStateMarkerSchema = z.object({
  id: z.string(),
  positionMs: z.number()
})
export type ProjectStateMarker = z.infer<typeof ProjectStateMarkerSchema>

export type LibraryItemKind = 'audio-file' | 'saved-clip'
const libraryItemKindSchema = z.enum(['audio-file', 'saved-clip'])

export const ProjectStateLibraryItemSchema = z
  .object({
    id: z.string(),
    filePath: z.string(),
    /** Library item kind. Older projects omit this and are treated as whole audio files. */
    kind: libraryItemKindSchema.optional(),
    /** User-facing name. Saved clips use this for their reusable clip name. */
    name: z.string().optional(),
    /** Display file name captured when the item entered the library. */
    fileName: z.string().optional(),
    /** Source duration in milliseconds. Optional for older saved projects. */
    durationMs: z.number().optional(),
    /** Source sample rate. Optional for older saved projects. */
    sampleRate: z.number().optional(),
    /** Source channel count. Optional for older saved projects. */
    channelCount: z.number().optional(),
    /** Detected musical key, e.g. `C minor`. Optional when detection is inconclusive. */
    key: z.string().optional(),
    /** Detected BPM (rounded to 2 d.p. on disk). Absent until the
     *  backend's BPM detection job finishes for this file. */
    bpm: z.number().optional(),
    /** Detected beat positions in seconds from the start of the source
     *  file. Absent for items without BPM detection results yet. */
    beats: z.array(z.number()).optional(),
    /** Regression-derived "ideal beat 0" anchor (seconds; can be
     *  negative). Used with `bpm` to lay out the synthesised marker
     *  grid robustly against per-beat jitter. */
    beatAnchorSec: z.number().optional(),
    /** Cache path the backend has decoded this source into. Future
     *  clips of this file should use this path so the audio engine
     *  reads cheap PCM instead of decoding the original. */
    playbackFilePath: z.string().optional(),
    /** True when BTrack's running tempo estimate fluctuated by more than
     *  ~2 % over the analysis window — the project-BPM seeder skips
     *  these and the library tile shows a "variable" badge. */
    variableTempo: z.boolean().optional(),
    /** Backend's auto-classification hint persisted into the library
     *  ValueTree. Mirrors the field on `LIBRARY_ITEM_ANALYSIS`. */
    lowConfidence: z.boolean().optional(),
    /** User's explicit classification override for the library item.
     *  `'sample'` forces non-musical treatment (hide BPM/key/beats,
     *  skip auto-warp on drop), `'music'` forces musical treatment.
     *  Absent means "auto" — fall back to `lowConfidence`. */
    sampleMode: z.enum(['sample', 'music']).optional(),
    /** Parent source library item for saved clips. */
    sourceItemId: z.string().optional(),
    /** Timeline clip that originally produced this saved clip, when known. */
    sourceClipId: z.string().optional(),
    /** Start of the saved clip window inside the source file. */
    sourceInMs: z.number().optional(),
    /** Duration of the saved clip window inside the source file. */
    sourceDurationMs: z.number().optional(),
    /** Source-group disclosure state. True when the user has collapsed
     *  the source's saved-clip list in the library panel. */
    collapsed: z.boolean().optional(),
    unresolved: z.boolean().optional(),
    /** **Saved-clip default warp settings.** Copied onto a fresh timeline
     *  clip when the saved-clip tile is dragged in (copy-on-drop, not
     *  live link — changing these later does NOT propagate to existing
     *  timeline instances). Only meaningful when `kind === 'saved-clip'`;
     *  ignored on audio-file items. See `ClipSetWarpPayload` for field
     *  semantics. */
    warpEnabled: z.boolean().optional(),
    warpMode: clipWarpModeSchema.optional(),
    tempoRatio: z.number().optional(),
    semitones: z.number().optional(),
    cents: z.number().optional()
  })
  // Saved-clip items must carry their window pointers. The original
  // hand-written guard enforced this via an extra branch; `superRefine`
  // expresses it at runtime without complicating the inferred type
  // (the renderer treats the window fields as optional on the type
  // because audio-file items legitimately omit them).
  .superRefine((item, ctx) => {
    if (item.kind === 'saved-clip') {
      if (typeof item.sourceInMs !== 'number') {
        ctx.addIssue({ code: 'custom', path: ['sourceInMs'], message: 'required when kind === saved-clip' })
      }
      if (typeof item.sourceDurationMs !== 'number') {
        ctx.addIssue({ code: 'custom', path: ['sourceDurationMs'], message: 'required when kind === saved-clip' })
      }
    }
  })
export type ProjectStateLibraryItem = z.infer<typeof ProjectStateLibraryItemSchema>

export const ProjectStatePayloadSchema = z.object({
  /** Absolute path to the current `.silverdaw` file, or `null` for an unsaved project. */
  filePath: z.string().nullable(),
  /** User-facing project name. `Untitled` for a freshly-created project. */
  name: z.string(),
  /**
   * Renderer hint — when true, wipe optimistic local state (tracks, clips,
   * library, selection, transport) before applying this snapshot. Sent on
   * `PROJECT_LOAD` and `PROJECT_NEW`; absent / false on the connect path
   * where the renderer treats the snapshot as additive (see
   * `projectStore.applyProjectStateSnapshot`).
   */
  reset: z.boolean().optional(),
  /**
   * Authoritative-reconcile hint used by Undo/Redo: replace tracks /
   * clips / library / markers wholesale (so things that disappeared
   * actually disappear) but do NOT mark the project clean, rotate the
   * `projectId`, or clear clipboard / selection. The dirty state is
   * communicated separately by the backend via `PROJECT_DIRTY` and the
   * undo / redo handler explicitly resends it after the snapshot.
   */
  softReplace: z.boolean().optional(),
  /**
   * Horizontal zoom level (px-per-second) persisted with the project.
   * Optional: omitted on a snapshot for a project that hasn't yet set a
   * zoom (the renderer keeps its current zoom in that case).
   */
  viewPxPerSecond: z.number().optional(),
  /** Horizontal scroll position (px) persisted with the project. */
  viewScrollX: z.number().optional(),
  /** Id of the selected track persisted with the project (empty string =
   *  none). Restores the timeline selection + Track FX panel target. */
  viewSelectedTrack: z.string().optional(),
  /** Whether the bottom panel shows the Track FX view, persisted with the
   *  project. */
  viewFxPanelOpen: z.boolean().optional(),
  /** Last playhead position (ms) persisted with the project. */
  playheadMs: z.number().optional(),
  /** Project tempo (BPM) persisted with the project. */
  bpm: z.number().optional(),
  /** User-set project length (ms) persisted with the project. */
  projectLengthMs: z.number().optional(),
  /**
   * Per-project preferred audio output device. Both fields are
   * optional and nullable. `null` / absent means "no project-level
   * preference"; the renderer's load-time reconcile then leaves the
   * live device on whatever the user-scope `preferences.json` selected
   * at backend startup.
   */
  audioOutputTypeName: z.string().nullable().optional(),
  audioOutputDeviceName: z.string().nullable().optional(),
  /**
   * Per-project target sample rate (Hz). Drives the playback-cache
   * rebuild so every clip's audio is at this rate on disk. Today
   * only 44 100 and 48 000 are accepted; absent means "fall back to
   * the user-scope `audio.defaultProjectSampleRate` preference, then
   * 44 100".
   */
  targetSampleRate: z.number().optional(),
  /**
   * Opaque JSON blob persisting the last-used export-dialog settings
   * (format, bit depth, tail seconds, loudness preset, file-level
   * tags, …). Renderer owns the schema (`{ version: 1, … }`); the
   * backend just round-trips the string. Absent on fresh projects;
   * empty string clears it.
   */
  exportSettingsJson: z.string().optional().nullable(),
  masterVolume: z.number().min(0).max(1).optional(),
  // ─── Phase 5 project-shared FX bus parameters. All flat on PROJECT.
  //     Each scalar is 0..1 linear and suppressed when at default. The
  //     `delayNoteValue` default is "1/8"; values are restricted to the
  //     tempo-locked beat-division whitelist on both ends of the wire.
  reverbSize: z.number().min(0).max(1).optional(),
  reverbDecay: z.number().min(0).max(1).optional(),
  reverbTone: z.number().min(0).max(1).optional(),
  reverbMix: z.number().min(0).max(1).optional(),
  delayNoteValue: z.enum(['1/4', '1/8', '1/8T', '1/16']).optional(),
  delayFeedback: z.number().min(0).max(1).optional(),
  delayTone: z.number().min(0).max(1).optional(),
  delayMix: z.number().min(0).max(1).optional(),
  /** User-created timeline markers. */
  markers: z.array(ProjectStateMarkerSchema).optional(),
  /**
   * Library catalogue persisted with the project. Each entry is the
   * `(id, filePath)` pair the renderer originally created the item
   * with, plus decoded duration and an optional `unresolved` flag
   * mirroring the clip path — set when the file is no longer on disk.
   * Cover art / ID3 metadata is NOT in here; the renderer re-fetches
   * it on load via the existing `audio:readMetadata` IPC.
   */
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

/** Backend notification that the project's dirty flag has transitioned. */
export const ProjectDirtyPayloadSchema = z.object({
  dirty: z.boolean()
})
export type ProjectDirtyPayload = z.infer<typeof ProjectDirtyPayloadSchema>

/**
 * Backend notification that a fresh on-disk peaks cache file is ready
 * for `clipId`. The renderer reads the file directly via main's
 * `readPeaksCacheFile` IPC — peaks bytes are NOT streamed over the
 * WebSocket (that approach hit recurring IXWebSocket I/O-loop
 * starvation issues with concurrent peak deliveries). The cache file
 * layout is fixed: a 28-byte header followed by `peakCount * laneCount *
 * 2` little-endian float32 peak values laid out channel-major — lane 0
 * is the mono summary, and for stereo files lanes 1/2 are left/right
 * (`laneCount === 3`). `peakCount` is the (min, max) pair count PER LANE.
 */
export const WaveformReadyPayloadSchema = z.object({
  clipId: z.string(),
  /** Absolute path of the cache file under `%APPDATA%/Silverdaw/peaks/`. */
  cachePath: z.string(),
  /** Number of (min, max) pairs PER LANE (NOT bytes, NOT individual floats). */
  peakCount: z.number(),
  /** Number of channel-major lanes: 1 (summary only) or 3 (summary + L/R). */
  laneCount: z.number().int().min(1).max(8).optional().default(1),
  peaksPerSecond: z.number(),
  sampleRate: z.number()
})
export type WaveformReadyPayload = z.infer<typeof WaveformReadyPayloadSchema>

/** Backend notification that a Clip Editor high-resolution peaks job
 *  has completed. Same disk-cache layout as `WAVEFORM_READY`, just
 *  keyed against the library item rather than a specific timeline
 *  clip (because every saved-clip sharing this source can reuse the
 *  same peaks file). */
export const ClipEditorPeaksReadyPayloadSchema = z.object({
  libraryItemId: z.string(),
  cachePath: z.string(),
  peakCount: z.number(),
  laneCount: z.number().int().min(1).max(8).optional().default(1),
  peaksPerSecond: z.number(),
  sampleRate: z.number()
})
export type ClipEditorPeaksReadyPayload = z.infer<typeof ClipEditorPeaksReadyPayloadSchema>

// SAMPLE_SAVED has two shapes depending on `ok`: a failure ack carries
// only `itemId`/`ok`/`error`, while a success ack carries the full
// baked-sample metadata. Modelling this as a discriminated union both
// captures the runtime invariant AND lets `z.infer` express the
// conditional in TypeScript.
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
  error: z.string().optional()
})
export const SampleSavedPayloadSchema = z.discriminatedUnion('ok', [
  SampleSavedSuccessSchema,
  SampleSavedFailureSchema
])
export type SampleSavedPayload = z.infer<typeof SampleSavedPayloadSchema>

/** Backend notification that BPM + beat-position detection has completed
 *  for a library item. `beats` is an array of times (in seconds from
 *  the start of the source file) at which BTrack detected a beat;
 *  `variableTempo` is `true` when the running tempo estimate fluctuated
 *  enough over the analysis window to make a single project-BPM seed
 *  misleading. */
export const LibraryItemAnalysisPayloadSchema = z.object({
  itemId: z.string(),
  bpm: z.number(),
  /** Regression-derived "ideal beat 0" anchor (seconds, may be
   *  negative). Renderer-side beat-marker grid uses this for
   *  phase. */
  beatAnchorSec: z.number(),
  beats: z.array(z.number()),
  variableTempo: z.boolean(),
  /** Backend's auto-classification hint: `true` when the BPM/beat fit
   *  is too loose to plausibly reflect a real groove. Drives the
   *  default sample-vs-music decision in the renderer; the user can
   *  always override via `sampleMode`. */
  lowConfidence: z.boolean().optional(),
  /** Path to the decoded-WAV cache the backend has written for this
   *  source file. Future clip adds should use this path so the
   *  audio engine reads cheap PCM instead of decoding MP3 / WMA on
   *  the read-ahead thread. */
  playbackFilePath: z.string().optional()
})
export type LibraryItemAnalysisPayload = z.infer<typeof LibraryItemAnalysisPayloadSchema>

/** Backend notification that it just seeded the project BPM (e.g. from
 *  the first import on an empty project). The renderer updates its
 *  `projectStore.bpm` mirror without re-broadcasting `PROJECT_SET_BPM`. */
export const ProjectBpmAppliedPayloadSchema = z.object({
  bpm: z.number()
})
export type ProjectBpmAppliedPayload = z.infer<typeof ProjectBpmAppliedPayloadSchema>

/** Backend notification that a clip's warp settings changed
 *  server-side (e.g. late auto-warp once source BPM analysis lands). */
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

/** Broadcast on every preview load/play/pause/stop/unload transition. */
export const PreviewStatePayloadSchema = z.object({
  /** Echoed back from the most recent PREVIEW_LOAD; absent on unload. */
  libraryItemId: z.string().optional(),
  isPlaying: z.boolean(),
  isLoaded: z.boolean(),
  durationMs: z.number(),
  /** Monotonic counter. Increments on every load/unload; the renderer
   *  uses it to discard stale state for a preview the user has already
   *  closed. */
  generation: z.number()
})
export type PreviewStatePayload = z.infer<typeof PreviewStatePayloadSchema>

/** Preview-position tick while the preview transport is playing. */
export const PreviewPositionPayloadSchema = z.object({
  positionMs: z.number(),
  isPlaying: z.boolean(),
  generation: z.number()
})
export type PreviewPositionPayload = z.infer<typeof PreviewPositionPayloadSchema>

/** Broadcast when the preview reaches the end of its selection window. */
export const PreviewEndedPayloadSchema = z.object({
  generation: z.number()
})
export type PreviewEndedPayload = z.infer<typeof PreviewEndedPayloadSchema>

/** One device-type group inside `AudioDevicesListPayload`. */
export const AudioDeviceTypeListingSchema = z.object({
  /** Backend-side type name as JUCE reports it ("Windows Audio",
   *  "DirectSound", "ASIO", …). Used as the discriminator when
   *  picking a device with `AUDIO_DEVICE_SELECT`. */
  name: z.string(),
  /** Output device names available under this type. May be empty
   *  (e.g. ASIO type is present but no ASIO drivers installed). */
  devices: z.array(z.string())
})
export type AudioDeviceTypeListing = z.infer<typeof AudioDeviceTypeListingSchema>

/**
 * Snapshot of available audio output devices plus the currently
 * active selection. Broadcast immediately after AUTH, after every
 * successful device switch, and after JUCE's `audioDeviceListChanged`
 * fires (USB plug / unplug, Windows audio-config reload).
 */
export const AudioDevicesListPayloadSchema = z.object({
  types: z.array(AudioDeviceTypeListingSchema),
  /** Active device type, or null when the backend has no device open. */
  currentTypeName: z.string().nullable(),
  /** Active output device name, or null when the backend has no device
   *  open. Empty string is treated the same as null. */
  currentDeviceName: z.string().nullable(),
  currentSampleRate: z.number().optional(),
  currentBufferSize: z.number().optional(),
  /** Total effective output latency in ms — what the backend will
   *  subtract from the broadcast playhead while playing. Sum of the
   *  driver's own report + the Bluetooth heuristic baseline. Absent
   *  / 0 means "negligible, no compensation applied". */
  outputLatencyMs: z.number().optional(),
  /** Just the Bluetooth-heuristic component, in ms. Non-zero means
   *  "the driver under-reports and we've added a baseline guess for
   *  the radio/headset pipeline". Surfaces a small "BT" hint next to
   *  the latency readout. */
  heuristicExtraLatencyMs: z.number().optional(),
  /** True iff the backend tried to honour a persisted device preference
   *  on startup but the saved device wasn't available — useful for the
   *  renderer to pop a one-shot "your saved device wasn't connected;
   *  using default" toast. Cleared by the backend on the next switch. */
  fellBackToDefault: z.boolean().optional(),
  /** True when this snapshot is the partial pre-scan list broadcast
   *  during boot, while the full device scan is still pending. The
   *  renderer surfaces a small "Scanning audio devices…" hint on the
   *  startup overlay until the follow-up snapshot arrives with the
   *  flag absent / false. */
  scanInProgress: z.boolean().optional()
})
export type AudioDevicesListPayload = z.infer<typeof AudioDevicesListPayloadSchema>

/** Ack for an `AUDIO_DEVICE_SELECT`. On `ok: true` it's followed by a
 *  refreshed `AUDIO_DEVICES_LIST`; on `ok: false` the backend rolled
 *  the device setup back to whatever was active before the request. */
export const AudioDeviceChangedPayloadSchema = z.object({
  typeName: z.string().nullable(),
  deviceName: z.string().nullable(),
  ok: z.boolean(),
  error: z.string().optional()
})
export type AudioDeviceChangedPayload = z.infer<typeof AudioDeviceChangedPayloadSchema>

/**
 * Mirror of the backend's `juce::UndoManager` head state. Broadcast on
 * AUTH-connect right after the first `PROJECT_STATE`, after every
 * project-mutating envelope, and after `EDIT_UNDO` / `EDIT_REDO`. The
 * renderer surfaces the boolean flags on the Edit menu (Undo / Redo
 * grey out when their respective flag is false) and the label fields
 * power optional menu hints like "Undo Move clip".
 */
export const EditUndoStatePayloadSchema = z.object({
  canUndo: z.boolean(),
  canRedo: z.boolean(),
  /** Description of the transaction that would be undone next, or
   *  absent when `canUndo === false`. */
  undoLabel: z.string().optional(),
  /** Description of the transaction that would be redone next, or
   *  absent when `canRedo === false`. */
  redoLabel: z.string().optional()
})
export type EditUndoStatePayload = z.infer<typeof EditUndoStatePayloadSchema>

/**
 * Backend response to a renderer-issued `AUDIO_FILE_PROBE`. Carries
 * the file's true sample rate / channel count / duration (read from
 * the format header by JUCE's `AudioFormatManager`). `ok: false`
 * means the file couldn't be opened (missing, unsupported format,
 * corrupted); `error` carries a short reason. `requestId` echoes
 * the renderer's allocated id so concurrent probes don't collide.
 */
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

/** Progress tick for an in-progress mixdown render. Emitted by the
 *  backend roughly every 50 ms while rendering or encoding. `percent`
 *  is `0..100` and is monotonically non-decreasing across a single
 *  render. `stage` lets the UI surface the current weighted phase. */
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

/** Success ack — mixdown finished and the file is at `filePath`.
 *  When the export ran with a loudness mode other than `off` the
 *  `loudness` block carries the post-render measurement (after gain
 *  has been applied in normalize mode). `integratedLufs` and
 *  `truePeakDbtp` are `null` for silent / unmeasurable programs
 *  because JSON cannot encode -Infinity. */
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

/** Failure ack — `code` lets the UI distinguish intentional cancel
 *  ('cancelled') from real errors so the progress dialog can dismiss
 *  quietly vs. surfacing the error toast. */
export const MixdownFailedPayloadSchema = z.object({
  code: z.enum(['cancelled', 'io', 'decode', 'encode', 'invalid']),
  error: z.string()
})
export type MixdownFailedPayload = z.infer<typeof MixdownFailedPayloadSchema>

/** Per-channel master output peaks, sampled by the backend audio thread
 *  POST master-gain and drained by the broadcaster at ~60 Hz. Each lane
 *  is the maximum sample magnitude observed since the last broadcast
 *  (lock-free "max since last read" atomic on the audio side). Values
 *  are linear scalars and can exceed 1.0 when tracks sum hot — the UI
 *  is responsible for converting to dB and rendering any over-zero
 *  "clip" indicator. The backend gates broadcasts on activity so a
 *  long silent stretch stops emitting; one trailing zero is sent on
 *  the transition to silence so the UI's hold/decay can finish. */
export const MasterLevelPayloadSchema = z.object({
  peakL: z.number().nonnegative(),
  peakR: z.number().nonnegative()
})
export type MasterLevelPayload = z.infer<typeof MasterLevelPayloadSchema>

/** Per-track peak meter. Same lifecycle and gating rules as
 *  `MASTER_LEVEL`: backend taps the post-chain peak in each
 *  `TrackRuntime`, drains them on the broadcaster tick (~60 Hz),
 *  and emits this envelope only when at least one track has
 *  non-trivial signal (with one trailing zero so the renderer's
 *  hold/decay can finish). The renderer fans out the array by
 *  `id` to the matching per-track meter component. Tracks with
 *  no clips (and therefore no runtime) are simply absent from
 *  the array — the renderer treats them as silent. */
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
  MASTER_LEVEL: MasterLevelPayload
  TRACK_LEVELS: TrackLevelsPayload
  PONG: PongPayload
  ENGINE_ERROR: EngineErrorPayload
}

export type BridgeInboundType = keyof BridgeInboundMap

/**
 * Inbound envelope, discriminated on `type`. The dispatcher narrows to one
 * arm per case so the exhaustiveness check fires if a new arm is added to
 * `BridgeInboundMap` without a matching case.
 */
export type BridgeInboundMessage = {
  [K in BridgeInboundType]: { type: K; payload: BridgeInboundMap[K] }
}[BridgeInboundType]

// ─── Runtime validation ─────────────────────────────────────────────────────

/** Every legal inbound envelope `type`. Kept in lockstep with `BridgeInboundMap`. */
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
  'MASTER_LEVEL',
  'TRACK_LEVELS',
  'PONG',
  'ENGINE_ERROR'
])

/** Narrow an unknown string to the inbound type union. */
export function isBridgeInboundType(value: unknown): value is BridgeInboundType {
  return typeof value === 'string' && INBOUND_TYPES.has(value as BridgeInboundType)
}

// Each guard delegates to its matching zod schema. `safeParse(...).success`
// returns a boolean and acts as the type predicate; the schema is the
// single source of truth for what a valid payload looks like.

/** Guard for `ReadyPayload`. */
export function isReadyPayload(value: unknown): value is ReadyPayload {
  return ReadyPayloadSchema.safeParse(value).success
}

/** Guard for `PlayheadUpdatePayload`. */
export function isPlayheadUpdatePayload(value: unknown): value is PlayheadUpdatePayload {
  return PlayheadUpdatePayloadSchema.safeParse(value).success
}

/** Guard for `PongPayload`. */
export function isPongPayload(value: unknown): value is PongPayload {
  return PongPayloadSchema.safeParse(value).success
}

/** Guard for `EngineErrorPayload`. */
export function isEngineErrorPayload(value: unknown): value is EngineErrorPayload {
  return EngineErrorPayloadSchema.safeParse(value).success
}

/** Guard for `ClipAckPayload`. */
export function isClipAckPayload(value: unknown): value is ClipAckPayload {
  return ClipAckPayloadSchema.safeParse(value).success
}

/** Guard for `TrackAddedPayload`. */
export function isTrackAddedPayload(value: unknown): value is TrackAddedPayload {
  return TrackAddedPayloadSchema.safeParse(value).success
}

/** Guard for `ProjectStatePayload`. */
export function isProjectStatePayload(value: unknown): value is ProjectStatePayload {
  return ProjectStatePayloadSchema.safeParse(value).success
}

/** Guard for `ProjectSavedPayload`. */
export function isProjectSavedPayload(value: unknown): value is ProjectSavedPayload {
  return ProjectSavedPayloadSchema.safeParse(value).success
}

/** Guard for `ProjectViewStateSavedPayload`. */
export function isProjectViewStateSavedPayload(value: unknown): value is ProjectViewStateSavedPayload {
  return ProjectViewStateSavedPayloadSchema.safeParse(value).success
}

/** Guard for `ProjectAutosavedPayload`. Shares its shape with the
 *  explicit-save ack; kept as a separate function so callers can
 *  document intent at the call site. */
export function isProjectAutosavedPayload(value: unknown): value is ProjectAutosavedPayload {
  return ProjectAutosavedPayloadSchema.safeParse(value).success
}

/** Guard for `ProjectLoadFailedPayload`. */
export function isProjectLoadFailedPayload(value: unknown): value is ProjectLoadFailedPayload {
  return ProjectLoadFailedPayloadSchema.safeParse(value).success
}

/** Guard for `ProjectRenamedPayload`. */
export function isProjectRenamedPayload(value: unknown): value is ProjectRenamedPayload {
  return ProjectRenamedPayloadSchema.safeParse(value).success
}

/** Guard for `ProjectDirtyPayload`. */
export function isProjectDirtyPayload(value: unknown): value is ProjectDirtyPayload {
  return ProjectDirtyPayloadSchema.safeParse(value).success
}

/** Guard for `WaveformReadyPayload`. */
export function isWaveformReadyPayload(value: unknown): value is WaveformReadyPayload {
  return WaveformReadyPayloadSchema.safeParse(value).success
}

/** Guard for `ClipEditorPeaksReadyPayload`. */
export function isClipEditorPeaksReadyPayload(value: unknown): value is ClipEditorPeaksReadyPayload {
  return ClipEditorPeaksReadyPayloadSchema.safeParse(value).success
}

/** Guard for `SampleSavedPayload`. */
export function isSampleSavedPayload(value: unknown): value is SampleSavedPayload {
  return SampleSavedPayloadSchema.safeParse(value).success
}

/** Guard for `TrackRemovedPayload`. */
export function isTrackRemovedPayload(value: unknown): value is TrackRemovedPayload {
  return TrackRemovedPayloadSchema.safeParse(value).success
}

/** Guard for `ClipRemovedPayload`. */
export function isClipRemovedPayload(value: unknown): value is ClipRemovedPayload {
  return ClipRemovedPayloadSchema.safeParse(value).success
}

/** Guard for `TrackGainAppliedPayload`. */
export function isTrackGainAppliedPayload(value: unknown): value is TrackGainAppliedPayload {
  return TrackGainAppliedPayloadSchema.safeParse(value).success
}

/** Guard for `TrackMuteAppliedPayload`. */
export function isTrackMuteAppliedPayload(value: unknown): value is TrackMuteAppliedPayload {
  return TrackMuteAppliedPayloadSchema.safeParse(value).success
}

/** Guard for `TrackSoloAppliedPayload`. */
export function isTrackSoloAppliedPayload(value: unknown): value is TrackSoloAppliedPayload {
  return TrackSoloAppliedPayloadSchema.safeParse(value).success
}

/** Guard for `TrackSendsAppliedPayload`. */
export function isTrackSendsAppliedPayload(value: unknown): value is TrackSendsAppliedPayload {
  return TrackSendsAppliedPayloadSchema.safeParse(value).success
}

/** Guard for `TrackToneAppliedPayload`. */
export function isTrackToneAppliedPayload(value: unknown): value is TrackToneAppliedPayload {
  return TrackToneAppliedPayloadSchema.safeParse(value).success
}

/** Guard for `TrackLevelerAppliedPayload`. */
export function isTrackLevelerAppliedPayload(value: unknown): value is TrackLevelerAppliedPayload {
  return TrackLevelerAppliedPayloadSchema.safeParse(value).success
}

/** Guard for `TrackPanAppliedPayload`. */
export function isTrackPanAppliedPayload(value: unknown): value is TrackPanAppliedPayload {
  return TrackPanAppliedPayloadSchema.safeParse(value).success
}

/** Guard for `ClipEnvelopeAppliedPayload`. */
export function isClipEnvelopeAppliedPayload(value: unknown): value is ClipEnvelopeAppliedPayload {
  return ClipEnvelopeAppliedPayloadSchema.safeParse(value).success
}

/** Guard for `ProjectReverbAppliedPayload`. */
export function isProjectReverbAppliedPayload(value: unknown): value is ProjectReverbAppliedPayload {
  return ProjectReverbAppliedPayloadSchema.safeParse(value).success
}

/** Guard for `ProjectDelayAppliedPayload`. */
export function isProjectDelayAppliedPayload(value: unknown): value is ProjectDelayAppliedPayload {
  return ProjectDelayAppliedPayloadSchema.safeParse(value).success
}

/** Guard for `LibraryItemAnalysisPayload`. */
export function isLibraryItemAnalysisPayload(value: unknown): value is LibraryItemAnalysisPayload {
  return LibraryItemAnalysisPayloadSchema.safeParse(value).success
}

/** Guard for `ProjectBpmAppliedPayload`. */
export function isProjectBpmAppliedPayload(value: unknown): value is ProjectBpmAppliedPayload {
  return ProjectBpmAppliedPayloadSchema.safeParse(value).success
}

/** Guard for `ClipWarpAppliedPayload`. */
export function isClipWarpAppliedPayload(value: unknown): value is ClipWarpAppliedPayload {
  return ClipWarpAppliedPayloadSchema.safeParse(value).success
}

/** Guard for `PreviewStatePayload`. */
export function isPreviewStatePayload(value: unknown): value is PreviewStatePayload {
  return PreviewStatePayloadSchema.safeParse(value).success
}

/** Guard for `PreviewPositionPayload`. */
export function isPreviewPositionPayload(value: unknown): value is PreviewPositionPayload {
  return PreviewPositionPayloadSchema.safeParse(value).success
}

/** Guard for `PreviewEndedPayload`. */
export function isPreviewEndedPayload(value: unknown): value is PreviewEndedPayload {
  return PreviewEndedPayloadSchema.safeParse(value).success
}

/** Guard for `AudioDevicesListPayload`. */
export function isAudioDevicesListPayload(value: unknown): value is AudioDevicesListPayload {
  return AudioDevicesListPayloadSchema.safeParse(value).success
}

/** Guard for `AudioDeviceChangedPayload`. */
export function isAudioDeviceChangedPayload(value: unknown): value is AudioDeviceChangedPayload {
  return AudioDeviceChangedPayloadSchema.safeParse(value).success
}

/** Guard for `EditUndoStatePayload`. */
export function isEditUndoStatePayload(value: unknown): value is EditUndoStatePayload {
  return EditUndoStatePayloadSchema.safeParse(value).success
}

/** Guard for `AudioFileProbedPayload`. */
export function isAudioFileProbedPayload(value: unknown): value is AudioFileProbedPayload {
  return AudioFileProbedPayloadSchema.safeParse(value).success
}

/** Guard for `MixdownProgressPayload`. */
export function isMixdownProgressPayload(value: unknown): value is MixdownProgressPayload {
  return MixdownProgressPayloadSchema.safeParse(value).success
}

/** Guard for `MixdownDonePayload`. */
export function isMixdownDonePayload(value: unknown): value is MixdownDonePayload {
  return MixdownDonePayloadSchema.safeParse(value).success
}

/** Guard for `MixdownFailedPayload`. */
export function isMixdownFailedPayload(value: unknown): value is MixdownFailedPayload {
  return MixdownFailedPayloadSchema.safeParse(value).success
}

/** Guard for `MasterLevelPayload`. */
export function isMasterLevelPayload(value: unknown): value is MasterLevelPayload {
  return MasterLevelPayloadSchema.safeParse(value).success
}

/** Guard for `TrackLevelsPayload`. */
export function isTrackLevelsPayload(value: unknown): value is TrackLevelsPayload {
  return TrackLevelsPayloadSchema.safeParse(value).success
}

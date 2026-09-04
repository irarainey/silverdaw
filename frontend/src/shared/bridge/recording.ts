// Audio-recording wire-protocol payloads (ADR 0030). Kept out of inbound.ts /
// outbound.ts for the same reason scratch.ts is: the recording session is a
// self-contained lifecycle with its own vocabulary, and the two catalogue files
// index it rather than defining it.
//
// Two things this file deliberately does *not* define:
//
// - A "recording saved" envelope. Committing a recording produces an ordinary
//   library sample, so the existing SAMPLE_SAVED broadcast is the ack, exactly
//   as it is for a baked scratch. The renderer correlates its commit through the
//   `itemId` it generated, the same way SCRATCH_SAVE_AS_SAMPLE does.
// - Any audio data. RECORD_RECORDING_READY names a path on disk; audio never
//   crosses the socket (ADR 0003).

import { z } from 'zod'

export const RECORDING_PROTOCOL_VERSION = 1 as const

/** Hard cap on a single recording. Long enough to be a non-issue, short enough
 *  that a forgotten session cannot fill a disk. Enforced by the writer, not
 *  just asserted here. */
export const MAX_RECORDING_SECONDS = 30 * 60

/** Count-in is one bar or none. Two bars was a choice nobody needed to make. */
export const RecordingCountInBarsSchema = z.union([z.literal(0), z.literal(1)])
export type RecordingCountInBars = z.infer<typeof RecordingCountInBarsSchema>

/** Input gain range for the record dialog's slider, in dB. Never silent: a muted
 *  input is indistinguishable from a device that is delivering nothing. */
export const MIN_RECORDING_INPUT_GAIN_DB = -24
export const MAX_RECORDING_INPUT_GAIN_DB = 24
export const RecordingInputGainDbSchema = z
  .number()
  .min(MIN_RECORDING_INPUT_GAIN_DB)
  .max(MAX_RECORDING_INPUT_GAIN_DB)

/**
 * The record window (ADR 0030). A recording is bounded by time, never by a
 * track. `selection` uses the project's existing timeline range as the window
 * and auto-stops at its end; the backend reads that range from project state
 * rather than having it sent, so there is one source of truth for it.
 */
export const RecordingWindowModeSchema = z.enum(['playhead', 'selection'])
export type RecordingWindowMode = z.infer<typeof RecordingWindowModeSchema>

/**
 * A device presents far more inputs than a performer means to record, so a
 * recording captures one channel or one adjacent pair — never the device's
 * whole channel set.
 */
export const RecordingChannelCountSchema = z.union([z.literal(1), z.literal(2)])
export type RecordingChannelCount = z.infer<typeof RecordingChannelCountSchema>

export const RecordingInputSelectionSchema = z.object({
  /** JUCE `AudioIODeviceType` name; capture may use a different driver type
   *  than playback, which is the whole point of the standalone device. */
  typeName: z.string().min(1),
  deviceName: z.string().min(1)
})
export type RecordingInputSelection = z.infer<typeof RecordingInputSelectionSchema>

// ─── Input enumeration ──────────────────────────────────────────────────────

export const RecordingInputTypeListingSchema = z.object({
  name: z.string().min(1),
  devices: z.array(z.string())
})
export type RecordingInputTypeListing = z.infer<typeof RecordingInputTypeListingSchema>

/**
 * `RECORD_INPUTS_LIST`. Enumeration only — no device is opened to build this,
 * so it cannot reintroduce the capture-open stall the engine's output-only
 * boot deliberately avoids. Channel names arrive later, in the session state,
 * once the chosen device is actually open.
 *
 * No remembered device is echoed here: the input preference is user-scope and
 * lives in Electron main alongside `audioOutput`, so the renderer resolves it
 * and sends it with RECORD_SESSION_OPEN.
 */
export const RecordingInputsListPayloadSchema = z.object({
  types: z.array(RecordingInputTypeListingSchema)
})
export type RecordingInputsListPayload = z.infer<typeof RecordingInputsListPayloadSchema>

// ─── Session lifecycle ──────────────────────────────────────────────────────

/**
 * `RECORD_SESSION_OPEN`. Opening the session opens the capture device lazily;
 * closing it releases the device. Omit `input` to use the remembered preference
 * or the first available device.
 */
export const RecordingSessionOpenPayloadSchema = z.object({
  protocolVersion: z.literal(RECORDING_PROTOCOL_VERSION),
  input: RecordingInputSelectionSchema.optional()
})
export type RecordingSessionOpenPayload = z.infer<typeof RecordingSessionOpenPayloadSchema>

export const RecordingSessionClosePayloadSchema = z.object({
  protocolVersion: z.literal(RECORDING_PROTOCOL_VERSION),
  sessionId: z.string().min(1)
})
export type RecordingSessionClosePayload = z.infer<typeof RecordingSessionClosePayloadSchema>

const RecordingSessionControlBase = {
  protocolVersion: z.literal(RECORDING_PROTOCOL_VERSION),
  sessionId: z.string().min(1)
}

/**
 * `RECORD_SESSION_CONTROL`. `start` covers arm, count-in and roll as one user
 * action; `stop` ends a recording early (the selection window stops itself).
 * `discard` is Record Again: it throws the finished file away and returns to
 * the armed state without ever creating a library item.
 *
 * There is deliberately no monitoring control: software monitoring is out of
 * scope for the first release (ADR 0030), and input metering is always live.
 */
export const RecordingSessionControlPayloadSchema = z.discriminatedUnion('action', [
  z.object({
    ...RecordingSessionControlBase,
    action: z.literal('selectInput'),
    input: RecordingInputSelectionSchema
  }),
  z.object({
    ...RecordingSessionControlBase,
    action: z.literal('selectChannels'),
    firstChannel: z.number().int().nonnegative(),
    channelCount: RecordingChannelCountSchema
  }),
  z.object({
    ...RecordingSessionControlBase,
    action: z.literal('setCountInBars'),
    bars: RecordingCountInBarsSchema
  }),
  z.object({
    ...RecordingSessionControlBase,
    action: z.literal('setInputGain'),
    gainDb: RecordingInputGainDbSchema
  }),
  z.object({
    ...RecordingSessionControlBase,
    action: z.literal('setWindowMode'),
    mode: RecordingWindowModeSchema
  }),
  z.object({ ...RecordingSessionControlBase, action: z.literal('start') }),
  z.object({ ...RecordingSessionControlBase, action: z.literal('stop') }),
  z.object({ ...RecordingSessionControlBase, action: z.literal('discard') })
])
export type RecordingSessionControlPayload = z.infer<typeof RecordingSessionControlPayloadSchema>

/**
 * Why a session is not usable, or why a recording failed. Each value is a
 * distinct thing that happened, because "recording failed" on its own is the
 * message that makes a working feature look broken.
 */
export const RecordingErrorCodeSchema = z.enum([
  /** No capture device exists at all. */
  'noInput',
  /** The device refused to open. */
  'openFailed',
  /** The device opened and delivered nothing but digital silence — the
   *  signature of absent Windows microphone consent. */
  'silentInput',
  /** The device went away mid-session. */
  'deviceLost',
  /** Not enough free space for the recording, checked before rolling. */
  'diskFull',
  /** The WAV could not be written or finalised. */
  'writeFailed',
  /** The recording hit MAX_RECORDING_SECONDS and was stopped. */
  'lengthCap'
])
export type RecordingErrorCode = z.infer<typeof RecordingErrorCodeSchema>

export const RecordingStatusSchema = z.enum([
  'idle',
  'countIn',
  'recording',
  'finalising',
  'review',
  'error'
])
export type RecordingStatus = z.infer<typeof RecordingStatusSchema>

/** The open capture device, as it actually resolved — which may differ from
 *  what was asked for, so the dialog shows the truth rather than the request. */
export const RecordingInputStateSchema = z.object({
  typeName: z.string().min(1),
  deviceName: z.string().min(1),
  channelNames: z.array(z.string()),
  sampleRate: z.number().positive(),
  inputLatencyMs: z.number().nonnegative()
})
export type RecordingInputState = z.infer<typeof RecordingInputStateSchema>

/** `RECORD_SESSION_STATE`. The renderer mirrors this and holds no audio. */
export const RecordingSessionStatePayloadSchema = z.object({
  protocolVersion: z.literal(RECORDING_PROTOCOL_VERSION),
  sessionId: z.string().min(1),
  status: RecordingStatusSchema,
  /** Null while no device is open — including when there is none to open. */
  input: RecordingInputStateSchema.nullable(),
  firstChannel: z.number().int().nonnegative(),
  channelCount: RecordingChannelCountSchema,
  countInBars: RecordingCountInBarsSchema,
  /** Input gain currently applied to the capture, in dB. */
  inputGainDb: RecordingInputGainDbSchema,
  windowMode: RecordingWindowModeSchema,
  /** True when a timeline range exists, so the dialog can offer (and preselect)
   *  the selection window instead of guessing. */
  hasSelection: z.boolean(),
  /** Where the recording starts on the timeline; the anchor kept on the
   *  finished file so a clip can be placed exactly where it was played. */
  anchorMs: z.number().nonnegative(),
  /** End of the record window for `selection`, null for `playhead`. */
  windowEndMs: z.number().nonnegative().nullable(),
  /** Bars left before rolling, while counting in. */
  countInBarsRemaining: RecordingCountInBarsSchema.optional(),
  /** Audio captured so far. */
  recordedMs: z.number().nonnegative(),
  /** Non-zero means the ring overflowed and the recording has holes; the user
   *  is told rather than handed a silently damaged file. */
  droppedSamples: z.number().int().nonnegative(),
  errorCode: RecordingErrorCodeSchema.optional(),
  error: z.string().min(1).optional()
})
export type RecordingSessionStatePayload = z.infer<typeof RecordingSessionStatePayloadSchema>

/** `RECORD_INPUT_LEVEL`. Drained at metering rate, in the MASTER_LEVEL shape.
 *  Always live, even with monitoring off — metering is how a user knows the
 *  input works before committing to a performance. */
export const RecordingInputLevelPayloadSchema = z.object({
  sessionId: z.string().min(1),
  peakL: z.number().nonnegative(),
  peakR: z.number().nonnegative()
})
export type RecordingInputLevelPayload = z.infer<typeof RecordingInputLevelPayloadSchema>

// ─── Finished recording ─────────────────────────────────────────────────────

/**
 * `RECORD_RECORDING_READY`. The finalised file, latency-offset and
 * drift-corrected, sitting on disk and not yet a library item. Nothing is added
 * to the project until the user commits, so an abandoned session leaves the
 * project untouched.
 */
export const RecordingReadyPayloadSchema = z.object({
  protocolVersion: z.literal(RECORDING_PROTOCOL_VERSION),
  sessionId: z.string().min(1),
  /** Identifies this finished recording for commit or discard. */
  recordingId: z.string().min(1),
  /** Path, never audio (ADR 0003). */
  filePath: z.string().min(1),
  suggestedName: z.string().min(1),
  durationMs: z.number().nonnegative(),
  sampleRate: z.number().positive(),
  channelCount: RecordingChannelCountSchema,
  anchorMs: z.number().nonnegative(),
  /** Project tempo at the time of recording; a recording is always musical, so
   *  this is a known value and no BPM detection is run on it. */
  bpm: z.number().positive(),
  beatAnchorSec: z.number(),
  /** Written only when a grid-aligned record window makes the beat count true
   *  by construction (ADR 0024); absent for a hand-stopped recording. */
  musicalBeats: z.number().int().positive().optional(),
  /** Peaks cache for the review waveform. */
  cachePath: z.string().min(1),
  peakCount: z.number().int().nonnegative(),
  peaksPerSecond: z.number().positive(),
  /** What finalise corrected, reported so the numbers are inspectable rather
   *  than folded away invisibly. */
  latencyOffsetMs: z.number(),
  driftPpm: z.number(),
  droppedSamples: z.number().int().nonnegative()
})
export type RecordingReadyPayload = z.infer<typeof RecordingReadyPayloadSchema>

/**
 * `RECORD_RECORDING_COMMIT`. Turns the finished file into a library item, and
 * for `timeline` also places a clip — both bracketed in one undo group by the
 * backend, so a single Undo removes the whole thing. `itemId` is generated by
 * the renderer, matching SCRATCH_SAVE_AS_SAMPLE, so the resulting SAMPLE_SAVED
 * broadcast correlates without a second ack envelope.
 *
 * `trackId` is optional even for `timeline`. The renderer normally resolves the
 * destination itself — it owns track selection and scrolling — but with no track
 * owning a recording the backend applies the same rule for a commit that names
 * none: the selected track when it is empty, otherwise a newly appended one.
 */
export const RecordingCommitPayloadSchema = z.object({
  protocolVersion: z.literal(RECORDING_PROTOCOL_VERSION),
  sessionId: z.string().min(1),
  recordingId: z.string().min(1),
  itemId: z.string().min(1),
  name: z.string().min(1),
  destination: z.enum(['library', 'timeline']),
  trackId: z.string().min(1).optional(),
  /** Client-generated clip id for `timeline`, following CLIP_ADD. */
  clipId: z.string().min(1).optional()
})
export type RecordingCommitPayload = z.infer<typeof RecordingCommitPayloadSchema>

// ─── Guards ─────────────────────────────────────────────────────────────────

export function isRecordingInputsListPayload(
  value: unknown
): value is RecordingInputsListPayload {
  return RecordingInputsListPayloadSchema.safeParse(value).success
}

export function isRecordingSessionStatePayload(
  value: unknown
): value is RecordingSessionStatePayload {
  return RecordingSessionStatePayloadSchema.safeParse(value).success
}

export function isRecordingInputLevelPayload(
  value: unknown
): value is RecordingInputLevelPayload {
  return RecordingInputLevelPayloadSchema.safeParse(value).success
}

export function isRecordingReadyPayload(value: unknown): value is RecordingReadyPayload {
  return RecordingReadyPayloadSchema.safeParse(value).success
}

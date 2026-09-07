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

/** Backing level for the record dialog, 0..1 linear — the same shape the Scratch
 *  Editor's `backingGain` uses, and for the same reason: it is a monitor trim on
 *  what the performer plays along to, so it only ever attenuates. */
export const RecordingBackingGainSchema = z.number().min(0).max(1)

/** Ceiling on a round trip, measured or typed. Beyond this it is not a latency figure, and
 *  accepting it would drag every take badly out of place. */
export const MAX_CALIBRATION_ROUND_TRIP_MS = 600

/**
 * The record window (ADR 0030). A recording is bounded by time, never by a
 * track. `start` and `playhead` both run open-ended until the performer stops,
 * differing only in where they anchor; `selection` uses the project's existing
 * timeline range as the window and auto-stops at its end, and the backend reads
 * that range from project state rather than having it sent, so there is one
 * source of truth for it.
 */
export const RecordingWindowModeSchema = z.enum(['playhead', 'start', 'selection'])
export type RecordingWindowMode = z.infer<typeof RecordingWindowModeSchema>

/**
 * What kind of material a take is, which maps straight onto the library's
 * existing `audioType` rather than inventing a recording-only concept.
 *
 * `music` commits the take with the project's tempo and, where the window makes
 * it true, a beat count — so it warps, snaps and shows beat markers like any
 * other loop. `simple` commits it with neither, because a spoken line, a sound
 * effect or a found recording has no tempo, and drawing beat markers over it
 * would be telling the user something untrue.
 */
export const RecordingModeSchema = z.enum(['music', 'simple'])
export type RecordingMode = z.infer<typeof RecordingModeSchema>

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
  /** The session to close, or '' for "whichever session is open" — the dialog
   *  sends the empty form when it never adopted a session id, so an abandoned
   *  session cannot keep the click, backing, loop or monitor borrowed. */
  sessionId: z.string()
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
 * Software input monitoring is a `setMonitorEnabled` control rather than the
 * non-goal ADR 0030 originally declared (see its Amendment 1): a performer
 * recording a vocal has to hear themselves against the backing. It is opt-in
 * and off by default because a monitored mic in front of speakers feeds back.
 * Input metering is always live, monitoring or not.
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
    action: z.literal('setClickEnabled'),
    enabled: z.boolean()
  }),
  z.object({
    ...RecordingSessionControlBase,
    action: z.literal('setBackingTracks'),
    /** Tracks to play along to. Empty records against silence; the backend
     *  silences the rest in the engine only, never in the project. */
    trackIds: z.array(z.string())
  }),
  z.object({
    ...RecordingSessionControlBase,
    action: z.literal('setBackingGain'),
    /** How loud the backing plays under the performer, 0..1. Monitoring only:
     *  the backend trims the arrangement in the engine, never the project's
     *  master volume, and the trim is gone when the dialog closes. */
    gain: RecordingBackingGainSchema
  }),
  z.object({
    ...RecordingSessionControlBase,
    action: z.literal('setInputGain'),
    gainDb: RecordingInputGainDbSchema
  }),
  z.object({
    ...RecordingSessionControlBase,
    action: z.literal('setRecordingMode'),
    mode: RecordingModeSchema
  }),
  z.object({
    ...RecordingSessionControlBase,
    action: z.literal('setMonitorEnabled'),
    /** Whether the performer hears their own input in the monitor mix. Opt-in:
     *  with speakers rather than headphones this is a feedback loop. */
    enabled: z.boolean()
  }),
  z.object({
    ...RecordingSessionControlBase,
    action: z.literal('setCleanupEnabled'),
    /** Whether the finished take gets the noise-reduction pass at finalise. */
    enabled: z.boolean()
  }),
  z.object({
    ...RecordingSessionControlBase,
    action: z.literal('setWindowMode'),
    mode: RecordingWindowModeSchema
  }),
  z.object({
    ...RecordingSessionControlBase,
    action: z.literal('setCalibration'),
    /** Measured round trip for this machine, or null to fall back to what the drivers
     *  report. Pushed by the renderer because calibration lives in app preferences, not in
     *  the project (ADR 0030, Amendment 17). */
    roundTripMs: z.number().min(0).max(MAX_CALIBRATION_ROUND_TRIP_MS).nullable()
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
  /** The arrangement would not start, so there was nothing to play along to and the
   *  take was abandoned before a single sample was kept. */
  'transportFailed',
  /** Not enough free space for the recording, checked before rolling. */
  'diskFull',
  /** The WAV could not be written or finalised. */
  'writeFailed'
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
  /** Whether the click keeps going through the take. Session-scoped: it starts
   *  from the project's metronome and never writes back to it. */
  clickEnabled: z.boolean(),
  /** Tracks heard as backing while the dialog is open; every track by default,
   *  empty means the take is recorded against silence. */
  backingTrackIds: z.array(z.string()),
  /** How loud that backing plays under the performer, 0..1. Monitoring only and
   *  session-scoped: it never touches the project's master volume. */
  backingGain: RecordingBackingGainSchema,
  /** Input gain currently applied to the capture, in dB. */
  inputGainDb: RecordingInputGainDbSchema,
  /** What the take will be committed as: musical material or a plain sample. */
  recordingMode: RecordingModeSchema,
  /** Whether the performer's own input is in the monitor mix. */
  monitorEnabled: z.boolean(),
  /** Whether monitoring can be offered at all. False when the input and output devices run
   *  at different rates, which the monitor's one-for-one path cannot bridge: it would be
   *  heard at the wrong pitch and glitching. Defaulted so an older backend still parses. */
  monitorAvailable: z.boolean().default(true),
  /** Whether the finished take gets the noise-reduction pass. */
  cleanupEnabled: z.boolean(),
  windowMode: RecordingWindowModeSchema,
  /** True when a timeline range exists, so the dialog can offer (and preselect)
   *  the selection window instead of guessing. */
  hasSelection: z.boolean(),
  /** Where the recording starts on the timeline; the anchor kept on the
   *  finished file so a clip can be placed exactly where it was played. */
  anchorMs: z.number().nonnegative(),
  /** Round trip that will be trimmed off the take's head, in ms: a calibrated measurement
   *  where one exists for the device pair, the drivers' own figures otherwise. The live
   *  waveform is drawn against it — input arriving now is a performance from this long ago,
   *  so without it an on-time take is drawn behind the beat it was played on. */
  latencyMs: z.number().nonnegative().optional().default(0),
  /** End of the record window for `selection`, null for `playhead`. */
  windowEndMs: z.number().nonnegative().nullable(),
  /** Bars left before rolling, while counting in. */
  countInBarsRemaining: RecordingCountInBarsSchema.optional(),
  /** Audio captured so far. */
  recordedMs: z.number().nonnegative(),
  /** Non-zero means the ring overflowed and the recording has holes; the user
   *  is told rather than handed a silently damaged file. */
  droppedSamples: z.number().int().nonnegative(),
  /** An unrecognised code degrades to the generic message rather than taking the whole
   *  snapshot with it: a state the renderer cannot fully name is still far more useful
   *  than no state at all, and `error` carries the backend's own wording as a fallback. */
  errorCode: RecordingErrorCodeSchema.optional().catch(undefined),
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
  /** True when the file is a stereo duplicate of a mono capture rather than the
   *  capture itself, so the review's option shows what the take actually is. */
  stereoDuplicated: z.boolean().optional().default(false),
  anchorMs: z.number().nonnegative(),
  /** Audio kept in front of the anchor so an early attack is not clipped, in ms. The
   *  take's first sample belongs at `anchorMs - preRollMs` on the timeline, which is both
   *  where it is placed and where the review audition has to start from. */
  preRollMs: z.number().nonnegative().optional().default(0),
  /** Whether the take is being committed as musical material. False for a
   *  `simple` recording, which gets no tempo and no beat count. */
  musical: z.boolean(),
  /** Project tempo at the time of recording; for a musical take this is a known
   *  value, so no BPM detection is run on it. */
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
  droppedSamples: z.number().int().nonnegative(),
  /** Capture stopped itself at the maximum recording length. The take is kept in
   *  full up to that point; this only explains why it ended on its own. */
  hitLengthCap: z.boolean().default(false)
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
  clipId: z.string().min(1).optional(),
  /** Separate a stereo take's two channels into two mono items on two tracks — the mixer
   *  case, where one stereo input carried two sources (ADR 0030, Amendment 24). Ignored
   *  for a take that was captured mono, which has nothing to separate. */
  splitChannels: z.boolean().optional().default(false),
  /** With `splitChannels`, put each half back across both channels of its own file, for
   *  the same downstream reasons as Save as Stereo. */
  splitAsStereo: z.boolean().optional().default(false),
  /** Ids for the second half of a split, generated by the renderer like the first so both
   *  items correlate without a second ack envelope. The first is the one the commit is
   *  tracked by. */
  secondItemId: z.string().min(1).optional(),
  secondClipId: z.string().min(1).optional()
})
export type RecordingCommitPayload = z.infer<typeof RecordingCommitPayloadSchema>

/**
 * `RECORD_RECORDING_SET_STEREO`. Switches the finished take between the mono
 * capture and a stereo duplicate of it, before anything has been saved. The
 * backend answers with a fresh `RECORD_RECORDING_READY`, so the review pane
 * reloads the waveform and auditions the file that will actually be kept
 * (ADR 0030, Amendment 9). Ignored for a take that was captured in stereo.
 */
export const RecordingSetStereoPayloadSchema = z.object({
  protocolVersion: z.literal(RECORDING_PROTOCOL_VERSION),
  sessionId: z.string().min(1),
  recordingId: z.string().min(1),
  enabled: z.boolean()
})
export type RecordingSetStereoPayload = z.infer<typeof RecordingSetStereoPayloadSchema>

// ─── Latency calibration ────────────────────────────────────────────────────

/**
 * `RECORD_CALIBRATE_START` / `RECORD_CALIBRATE_CANCEL` / `RECORD_CALIBRATE_STATE`
 * (ADR 0030, Amendment 17).
 *
 * Windows does not report the real recording round trip: a capture endpoint that does its own
 * processing declares no latency at all, and a shared-mode output reports little beyond its
 * buffer, so the head trim built from those figures can be short by most of the true delay.
 * Playing a short run of clicks and listening for them through the microphone is the only way
 * to see the whole path.
 *
 * The measurement is offered, never forced: the user can ignore it, and a take is still trimmed
 * by the drivers' figures. The result is stored in app preferences per input+output device pair
 * rather than in the project — it describes this machine, and a project carrying it would be
 * wrong on anyone else's setup.
 */
export const RecordingCalibrateStartPayloadSchema = z.object({
  protocolVersion: z.literal(RECORDING_PROTOCOL_VERSION),
  sessionId: z.string().min(1)
})
export type RecordingCalibrateStartPayload = z.infer<typeof RecordingCalibrateStartPayloadSchema>

export const RecordingCalibrateCancelPayloadSchema = z.object({
  protocolVersion: z.literal(RECORDING_PROTOCOL_VERSION),
  sessionId: z.string()
})
export type RecordingCalibrateCancelPayload = z.infer<typeof RecordingCalibrateCancelPayloadSchema>

export const RecordingCalibrateStatusSchema = z.enum(['idle', 'measuring', 'measured', 'failed'])
export type RecordingCalibrateStatus = z.infer<typeof RecordingCalibrateStatusSchema>

export const RecordingCalibrateStatePayloadSchema = z.object({
  protocolVersion: z.literal(RECORDING_PROTOCOL_VERSION),
  status: RecordingCalibrateStatusSchema,
  /** Clicks heard so far and in total, so the dialog can show real progress rather than an
   *  indeterminate spinner over a run that takes a couple of seconds. */
  clicksDetected: z.number().int().nonnegative(),
  clicksTotal: z.number().int().nonnegative(),
  /** The measured round trip, present only on `measured`. */
  roundTripMs: z.number().min(0).max(MAX_CALIBRATION_ROUND_TRIP_MS).nullable(),
  /** Why it failed, in terms the user can act on. */
  error: z.string().min(1).optional()
})
export type RecordingCalibrateStatePayload = z.infer<typeof RecordingCalibrateStatePayloadSchema>

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

export function isRecordingCalibrateStatePayload(
  value: unknown
): value is RecordingCalibrateStatePayload {
  return RecordingCalibrateStatePayloadSchema.safeParse(value).success
}

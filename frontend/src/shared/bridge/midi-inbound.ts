import { z } from 'zod'

/** Connected MIDI input device and its enabled/activity state. */
export const MidiInputDeviceSchema = z.object({
  name: z.string(),
  identifier: z.string(),
  connected: z.boolean(),
  enabled: z.boolean(),
  controllerProfile: z.string().nullable(),
  lastActivityMs: z.number().nullable()
})
export type MidiInputDevice = z.infer<typeof MidiInputDeviceSchema>

export const MidiDevicesListPayloadSchema = z.object({
  inputs: z.array(MidiInputDeviceSchema)
})
export type MidiDevicesListPayload = z.infer<typeof MidiDevicesListPayloadSchema>

/** Latest MIDI short message received from an enabled input. */
export const MidiMessagePayloadSchema = z.object({
  deviceIdentifier: z.string(),
  timestampMs: z.number(),
  statusByte: z.number().int().min(0).max(255),
  data1: z.number().int().min(0).max(127).nullable(),
  data2: z.number().int().min(0).max(127).nullable()
})
export type MidiMessagePayload = z.infer<typeof MidiMessagePayloadSchema>

const MidiDeckSchema = z.union([z.literal(1), z.literal(2)])

const MidiButtonControlSchema = z.enum([
  'playPause',
  'previousMarker',
  'nextMarker',
  'shift',
  'syncModifier',
  'jogTouch'
])

const MidiJogControlSchema = z.enum([
  'jogScratch',
  'jogPitchBend',
  'jogSearch',
  'wheelPitchBend',
  'wheelSearch'
])

const MidiTrackAbsoluteControlSchema = z.enum([
  'trackGain',
  'toneBass',
  'toneMid',
  'toneTreble',
  'filter'
])

/** Semantic two-deck control decoded by a recognised backend controller profile. */
// A plain union preserves control-specific fields such as required marker-pad indexes.
export const MidiControlPayloadSchema = z.union([
  z.object({
    deviceIdentifier: z.string(),
    timestampMs: z.number(),
    kind: z.literal('button'),
    control: MidiButtonControlSchema,
    deck: MidiDeckSchema,
    pressed: z.boolean()
  }),
  z.object({
    deviceIdentifier: z.string(),
    timestampMs: z.number(),
    kind: z.literal('button'),
    control: z.literal('browsePress'),
    deck: z.null(),
    pressed: z.boolean()
  }),
  z.object({
    deviceIdentifier: z.string(),
    timestampMs: z.number(),
    kind: z.literal('button'),
    control: z.enum(['markerJump', 'markerToggle']),
    deck: MidiDeckSchema,
    pad: z.number().int().min(1).max(8),
    pressed: z.literal(true)
  }),
  z.object({
    deviceIdentifier: z.string(),
    timestampMs: z.number(),
    kind: z.literal('relative'),
    control: MidiJogControlSchema,
    deck: MidiDeckSchema,
    value: z.number().int()
  }),
  z.object({
    deviceIdentifier: z.string(),
    timestampMs: z.number(),
    kind: z.literal('relative'),
    control: z.enum(['browseTracks', 'timelineZoom']),
    deck: z.null(),
    value: z.number().int()
  }),
  z.object({
    deviceIdentifier: z.string(),
    timestampMs: z.number(),
    kind: z.literal('absolute'),
    control: MidiTrackAbsoluteControlSchema,
    // Physical source deck is telemetry only; renderer actions target the selected track.
    deck: MidiDeckSchema,
    value: z.number().min(0).max(1)
  }),
  z.object({
    deviceIdentifier: z.string(),
    timestampMs: z.number(),
    kind: z.literal('absolute'),
    control: z.enum(['crossfader', 'masterVolume']),
    deck: z.null(),
    value: z.number().min(0).max(1)
  })
])
export type MidiControlPayload = z.infer<typeof MidiControlPayloadSchema>

export const MidiDeckSelectionPayloadSchema = z.object({
  deviceIdentifier: z.string(),
  deck1Enabled: z.boolean(),
  deck2Enabled: z.boolean()
})
export type MidiDeckSelectionPayload = z.infer<typeof MidiDeckSelectionPayloadSchema>

export function isMidiDevicesListPayload(value: unknown): value is MidiDevicesListPayload {
  return MidiDevicesListPayloadSchema.safeParse(value).success
}

export function isMidiMessagePayload(value: unknown): value is MidiMessagePayload {
  return MidiMessagePayloadSchema.safeParse(value).success
}

export function isMidiControlPayload(value: unknown): value is MidiControlPayload {
  return MidiControlPayloadSchema.safeParse(value).success
}

export function isMidiDeckSelectionPayload(value: unknown): value is MidiDeckSelectionPayload {
  return MidiDeckSelectionPayloadSchema.safeParse(value).success
}

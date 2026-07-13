import { z } from 'zod'

export const SCRATCH_PROTOCOL_VERSION = 1 as const
export const SCRATCH_PATTERN_VERSION = 1 as const
export const SCRATCH_CROSSFADER_CURVE_VERSION = 'linear-v1' as const
export const MAX_SCRATCH_PATTERN_POINTS = 100_000
export const MAX_ABSOLUTE_SCRATCH_TURNS = 1_000_000
export const MAX_SCRATCH_EVENT_DELTA_TURNS = 8

const TimeUsSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const AbsoluteTurnsSchema = z
  .number()
  .finite()
  .min(-MAX_ABSOLUTE_SCRATCH_TURNS)
  .max(MAX_ABSOLUTE_SCRATCH_TURNS)

export const ScratchDeckSideSchema = z.union([z.literal(1), z.literal(2)])
export type ScratchDeckSide = z.infer<typeof ScratchDeckSideSchema>

export const ScratchPlatterKeyframeSchema = z.object({
  timeUs: TimeUsSchema,
  turns: AbsoluteTurnsSchema,
  touched: z.boolean()
})
export type ScratchPlatterKeyframe = z.infer<typeof ScratchPlatterKeyframeSchema>

export const ScratchCrossfaderKeyframeSchema = z.object({
  timeUs: TimeUsSchema,
  value: z.number().finite().min(0).max(1)
})
export type ScratchCrossfaderKeyframe = z.infer<typeof ScratchCrossfaderKeyframeSchema>

export const ScratchPatternProvenanceSchema = z.object({
  sourceClipId: z.string().min(1),
  sourceLibraryItemId: z.string().min(1).optional()
})
export type ScratchPatternProvenance = z.infer<typeof ScratchPatternProvenanceSchema>

/**
 * Version 1 stores simplified action keyframes. Once saved, these keyframes are
 * the source of truth for both live replay and offline rendering.
 */
export const ScratchPatternSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    version: z.literal(SCRATCH_PATTERN_VERSION),
    durationUs: TimeUsSchema,
    cropStartUs: TimeUsSchema,
    cropEndUs: TimeUsSchema,
    sourceOffsetTurns: AbsoluteTurnsSchema,
    ownerDeck: ScratchDeckSideSchema,
    crossfaderCurve: z.literal(SCRATCH_CROSSFADER_CURVE_VERSION),
    platter: z.array(ScratchPlatterKeyframeSchema).max(MAX_SCRATCH_PATTERN_POINTS),
    crossfader: z.array(ScratchCrossfaderKeyframeSchema).max(MAX_SCRATCH_PATTERN_POINTS),
    provenance: ScratchPatternProvenanceSchema.optional()
  })
  .superRefine((pattern, context) => {
    if (pattern.cropStartUs > pattern.cropEndUs || pattern.cropEndUs > pattern.durationUs) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cropEndUs'],
        message: 'crop range must be ordered and contained by durationUs'
      })
    }

    for (const [field, points] of [
      ['platter', pattern.platter],
      ['crossfader', pattern.crossfader]
    ] as const) {
      // Lanes must be nonempty.
      if (points.length === 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} lane must not be empty`
        })
        continue
      }
      // First timestamp must be exactly 0.
      if (points[0]!.timeUs !== 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field, 0, 'timeUs'],
          message: `first ${field} keyframe must have timeUs === 0`
        })
      }
      // Last timestamp must be exactly durationUs (for duration > 0).
      // Duration zero: single point at 0.
      if (pattern.durationUs > 0 && points[points.length - 1]!.timeUs !== pattern.durationUs) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field, points.length - 1, 'timeUs'],
          message: `last ${field} keyframe must have timeUs === durationUs`
        })
      }
      if (pattern.durationUs === 0 && points.length !== 1) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} lane must have exactly one point when durationUs is zero`
        })
      }
      // Strictly increasing timestamps.
      let previousTimeUs = -1
      for (let index = 0; index < points.length; index += 1) {
        const timeUs = points[index]?.timeUs ?? 0
        if (timeUs <= previousTimeUs || timeUs > pattern.durationUs) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field, index, 'timeUs'],
            message: 'keyframe times must be strictly increasing and contained by durationUs'
          })
          break
        }
        previousTimeUs = timeUs
      }
    }
  })
export type ScratchPattern = z.infer<typeof ScratchPatternSchema>

export const ScratchSessionOpenPayloadSchema = z.object({
  protocolVersion: z.literal(SCRATCH_PROTOCOL_VERSION),
  clipId: z.string().min(1)
})
export type ScratchSessionOpenPayload = z.infer<typeof ScratchSessionOpenPayloadSchema>

export const ScratchSessionClosePayloadSchema = z.object({
  protocolVersion: z.literal(SCRATCH_PROTOCOL_VERSION),
  sessionId: z.string().min(1)
})
export type ScratchSessionClosePayload = z.infer<typeof ScratchSessionClosePayloadSchema>

const ScratchSessionControlBase = {
  protocolVersion: z.literal(SCRATCH_PROTOCOL_VERSION),
  sessionId: z.string().min(1)
}

export const ScratchSessionControlPayloadSchema = z.discriminatedUnion('action', [
  z.object({ ...ScratchSessionControlBase, action: z.literal('play') }),
  z.object({ ...ScratchSessionControlBase, action: z.literal('pause') }),
  z.object({ ...ScratchSessionControlBase, action: z.literal('recordStart') }),
  z.object({ ...ScratchSessionControlBase, action: z.literal('recordStop') }),
  z.object({
    ...ScratchSessionControlBase,
    action: z.literal('seek'),
    positionUs: TimeUsSchema
  }),
  z.object({
    ...ScratchSessionControlBase,
    action: z.literal('platterMove'),
    deck: ScratchDeckSideSchema,
    deltaTurns: z
      .number()
      .finite()
      .min(-MAX_SCRATCH_EVENT_DELTA_TURNS)
      .max(MAX_SCRATCH_EVENT_DELTA_TURNS)
  }),
  z.object({
    ...ScratchSessionControlBase,
    action: z.literal('platterTouch'),
    deck: ScratchDeckSideSchema,
    touched: z.boolean()
  }),
  z.object({
    ...ScratchSessionControlBase,
    action: z.literal('crossfader'),
    value: z.number().finite().min(0).max(1)
  })
])
export type ScratchSessionControlPayload = z.infer<typeof ScratchSessionControlPayloadSchema>

export const ScratchSessionStatePayloadSchema = z.object({
  protocolVersion: z.literal(SCRATCH_PROTOCOL_VERSION),
  sessionId: z.string().min(1),
  clipId: z.string().min(1),
  status: z.enum(['preparing', 'ready', 'playing', 'recording', 'paused', 'error']),
  preparationProgress: z.number().finite().min(0).max(1).optional(),
  positionUs: TimeUsSchema,
  durationUs: TimeUsSchema,
  platterTurns: AbsoluteTurnsSchema,
  playbackRate: z.number().finite().min(-8).max(8),
  crossfader: z.number().finite().min(0).max(1),
  selectedDeck: ScratchDeckSideSchema.nullable().optional(),
  ownerDeviceIdentifier: z.string().min(1).nullable(),
  ownerDeck: ScratchDeckSideSchema.nullable(),
  touched: z.boolean(),
  error: z.string().min(1).optional()
})
export type ScratchSessionStatePayload = z.infer<typeof ScratchSessionStatePayloadSchema>

export function isScratchSessionStatePayload(value: unknown): value is ScratchSessionStatePayload {
  return ScratchSessionStatePayloadSchema.safeParse(value).success
}

export const ScratchPatternRecordedPayloadSchema = z.object({
  protocolVersion: z.literal(SCRATCH_PROTOCOL_VERSION),
  sessionId: z.string().min(1),
  pattern: ScratchPatternSchema
})
export type ScratchPatternRecordedPayload = z.infer<typeof ScratchPatternRecordedPayloadSchema>

export function isScratchPatternRecordedPayload(
  value: unknown
): value is ScratchPatternRecordedPayload {
  return ScratchPatternRecordedPayloadSchema.safeParse(value).success
}

export const ScratchPatternSavePayloadSchema = z.object({
  protocolVersion: z.literal(SCRATCH_PROTOCOL_VERSION),
  sessionId: z.string().min(1),
  pattern: ScratchPatternSchema
})
export type ScratchPatternSavePayload = z.infer<typeof ScratchPatternSavePayloadSchema>

export const ScratchPatternDeletePayloadSchema = z.object({
  protocolVersion: z.literal(SCRATCH_PROTOCOL_VERSION),
  patternId: z.string().min(1)
})
export type ScratchPatternDeletePayload = z.infer<typeof ScratchPatternDeletePayloadSchema>

export const ScratchPatternRenamePayloadSchema = z.object({
  protocolVersion: z.literal(SCRATCH_PROTOCOL_VERSION),
  patternId: z.string().min(1),
  name: z.string().min(1)
})
export type ScratchPatternRenamePayload = z.infer<typeof ScratchPatternRenamePayloadSchema>

export const ScratchPatternApplyPayloadSchema = z.object({
  protocolVersion: z.literal(SCRATCH_PROTOCOL_VERSION),
  clipId: z.string().min(1),
  patternId: z.string().min(1)
})
export type ScratchPatternApplyPayload = z.infer<typeof ScratchPatternApplyPayloadSchema>

export const ScratchPatternRemovePayloadSchema = z.object({
  protocolVersion: z.literal(SCRATCH_PROTOCOL_VERSION),
  clipId: z.string().min(1)
})
export type ScratchPatternRemovePayload = z.infer<typeof ScratchPatternRemovePayloadSchema>

export const ScratchPatternReplayStartPayloadSchema = z.object({
  protocolVersion: z.literal(SCRATCH_PROTOCOL_VERSION),
  patternId: z.string().min(1)
})
export type ScratchPatternReplayStartPayload = z.infer<typeof ScratchPatternReplayStartPayloadSchema>

export const ScratchPatternReplayStopPayloadSchema = z.object({
  protocolVersion: z.literal(SCRATCH_PROTOCOL_VERSION)
})
export type ScratchPatternReplayStopPayload = z.infer<typeof ScratchPatternReplayStopPayloadSchema>

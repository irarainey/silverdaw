import { z } from 'zod'

export const TrackExportStartSchema = z.object({
  sampleRate: z.union([z.literal(44100), z.literal(48000)]),
  bitDepth: z.union([z.literal(16), z.literal(24), z.literal(32)]),
  tailSeconds: z.number().min(0).max(60),
  includeEffects: z.boolean(),
  // The timeline can show an automatic name even when TRACK.name is unset.
  trackLabels: z.record(z.string(), z.string())
})
export type TrackExportStartPayload = z.infer<typeof TrackExportStartSchema>

export const TrackExportReadySchema = z.object({
  folder: z.string().min(1),
  trackCount: z.number().int().positive()
})

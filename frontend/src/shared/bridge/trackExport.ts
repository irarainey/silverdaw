import { z } from 'zod'
import { ExportFormatSchema, ExportBitrateSchema, ExportBitDepthSchema, exportBitDepths } from './exportFormat'

// A custom destination must be a drive-rooted path or a network share.
export const TrackExportFolderSchema = z.string().regex(/^(?:[a-z]:[\\/]|\\\\(?![?.]\\)[^\\/]+\\[^\\/]+(?:\\|$))/i)

export const TrackExportStartSchema = z.object({
  sampleRate: z.union([z.literal(44100), z.literal(48000)]),
  format: ExportFormatSchema.default('wav'),
  bitDepth: ExportBitDepthSchema.optional(),
  bitrateKbps: ExportBitrateSchema.optional(),
  tailSeconds: z.number().int().min(0).max(60),
  includeEffects: z.boolean(),
  selectionOnly: z.boolean().optional(),
  outputFolder: TrackExportFolderSchema.optional(),
  // Only selected IDs are sent, with their displayed (possibly automatic) timeline names.
  trackLabels: z.record(z.string().min(1), z.string()).refine(labels => Object.keys(labels).length > 0)
}).refine(settings => settings.format === 'mp3'
  ? settings.bitrateKbps !== undefined
  : settings.bitDepth !== undefined && exportBitDepths(settings.format).includes(settings.bitDepth),
{ message: 'Choose a supported bit depth or MP3 bitrate.' })
export type TrackExportStartPayload = z.infer<typeof TrackExportStartSchema>

export const TrackExportReadySchema = z.object({
  folder: z.string().min(1),
  trackCount: z.number().int().positive()
})

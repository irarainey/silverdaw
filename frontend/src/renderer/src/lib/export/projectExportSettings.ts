import { z } from 'zod'
import { ExportFormatSchema, ExportBitrateSchema, ExportBitDepthSchema, TrackExportFolderSchema } from '@shared/bridge-protocol'
import { log } from '@/lib/log'

/** Mixdown's original flat keys and the track export preferences share one project property. */
export function readProjectExportSettings(blob: string | null): Record<string, unknown> {
  if (!blob) return {}
  try {
    const parsed: unknown = JSON.parse(blob)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // Older or malformed settings must not prevent an export.
  }
  log.warn('mixdown', 'Invalid project export settings; using defaults')
  return {}
}

const TrackPreferences = z.object({
  format: ExportFormatSchema.optional(),
  bitDepth: ExportBitDepthSchema.optional(),
  bitrateKbps: ExportBitrateSchema.optional(),
  outputFolder: TrackExportFolderSchema.optional(),
  // Null means all tracks, including any subsequently added to the timeline.
  trackIds: z.array(z.string().min(1)).nullable()
})

export function readTrackExportPreferences(blob: string | null): z.infer<typeof TrackPreferences> {
  const { trackExport } = readProjectExportSettings(blob)
  const parsed = TrackPreferences.safeParse(trackExport)
  if (parsed.success) return parsed.data
  if (trackExport !== undefined) log.warn('mixdown', 'Invalid track export preferences; using defaults')
  return { trackIds: null }
}

export function mergeExportSettings(blob: string | null, settings: object): string {
  return JSON.stringify({ ...readProjectExportSettings(blob), ...settings })
}

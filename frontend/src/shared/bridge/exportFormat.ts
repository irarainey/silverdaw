import { z } from 'zod'

export const ExportFormatSchema = z.enum(['wav', 'flac', 'aiff', 'mp3'])
export type ExportFormat = z.infer<typeof ExportFormatSchema>

export const exportBitrates = [128, 192, 320] as const
export const ExportBitrateSchema = z.literal(exportBitrates)
export const ExportBitDepthSchema = z.literal([16, 24, 32])
export type ExportBitDepth = z.infer<typeof ExportBitDepthSchema>

export function exportBitDepths(format: ExportFormat): readonly ExportBitDepth[] {
  if (format === 'mp3') return []
  return format === 'wav' ? [16, 24, 32] : [16, 24]
}

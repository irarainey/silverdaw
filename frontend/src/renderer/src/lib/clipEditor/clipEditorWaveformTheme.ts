// Clip Editor waveform theme: colours and fixed text style. Matches the previous
// Canvas-2D renderer so the look is unchanged. The colours a waveform shares with
// every other waveform in the app come from the shared palette; the rest are the
// editor's own (selection, slices, the volume envelope).

import {
  WAVEFORM_BEAT_ALPHA,
  WAVEFORM_COLORS,
  waveformColorValue
} from '@/lib/waveform/waveformPalette'

export const RULER_LABEL_STYLE = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 10,
  fill: 0xa1a1aa
} as const

export const COL_RULER_BG = 0x18181b
// Waveform-area background (neutral-950); the ruler band paints over the top.
export const COL_EDITOR_BG = waveformColorValue(WAVEFORM_COLORS.background)
export const COL_RULER_BORDER = 0x27272a
export const COL_RULER_TICK = 0x3f3f46
export const COL_BASELINE = waveformColorValue(WAVEFORM_COLORS.baseline)
export const COL_WAVE = waveformColorValue(WAVEFORM_COLORS.wave)
export const COL_BEAT = waveformColorValue(WAVEFORM_COLORS.beat)
export const COL_BEAT_ALPHA = WAVEFORM_BEAT_ALPHA
export const COL_SELECTION = 0x3b82f6
export const COL_PLAYHEAD = waveformColorValue(WAVEFORM_COLORS.playhead)
export const COL_VOL_UNITY = 0x3f3f46
export const COL_VOL_LINE = 0xa78bfa
export const COL_VOL_ENDPOINT = 0x8b5cf6
export const COL_VOL_MIDPOINT = 0xc4b5fd
export const COL_VOL_MIDPOINT_DIM = 0xc4b5fd
export const COL_VOL_DOT_STROKE = 0x2e1065
export const COL_SLICE = 0x34d399
export const COL_SLICE_HANDLE = 0x6ee7b7

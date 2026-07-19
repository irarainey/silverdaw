// Per-parameter descriptors for track automation: the native value range,
// default, display label and formatting. Shared by the lane renderer (value↔pixel
// mapping) and the store (clamping). Values are stored/sent in native units.

import type { AutomationParamId } from '@shared/bridge-protocol'

export interface AutomationParamDescriptor {
  readonly id: AutomationParamId
  /** Short label for the lane header / parameter picker. */
  readonly label: string
  /** Inclusive native-unit range. */
  readonly min: number
  readonly max: number
  /** Resting value when no curve exists. */
  readonly defaultValue: number
  /** Format a native value for a compact readout. */
  readonly format: (value: number) => string
}

function fmtFilter(value: number): string {
  if (Math.abs(value) < 0.02) return 'Off'
  return value < 0 ? `LPF ${Math.round(-value * 100)}%` : `HPF ${Math.round(value * 100)}%`
}

function fmtPan(value: number): string {
  if (Math.abs(value) < 0.02) return 'C'
  return value < 0 ? `L${Math.round(-value * 100)}` : `R${Math.round(value * 100)}`
}

const fmtDb = (value: number): string => `${value >= 0 ? '+' : ''}${value.toFixed(1)} dB`
const fmtPct = (value: number): string => `${Math.round(value * 100)}%`

export const AUTOMATION_PARAMS: Record<AutomationParamId, AutomationParamDescriptor> = {
  filter: { id: 'filter', label: 'Filter', min: -1, max: 1, defaultValue: 0, format: fmtFilter },
  pan: { id: 'pan', label: 'Pan', min: -1, max: 1, defaultValue: 0, format: fmtPan },
  toneBass: { id: 'toneBass', label: 'Bass', min: -15, max: 15, defaultValue: 0, format: fmtDb },
  toneMid: { id: 'toneMid', label: 'Mid', min: -15, max: 15, defaultValue: 0, format: fmtDb },
  toneTreble: { id: 'toneTreble', label: 'Treble', min: -15, max: 15, defaultValue: 0, format: fmtDb },
  reverbSend: { id: 'reverbSend', label: 'Reverb Send', min: 0, max: 1, defaultValue: 0, format: fmtPct },
  delaySend: { id: 'delaySend', label: 'Delay Send', min: 0, max: 1, defaultValue: 0, format: fmtPct },
  leveler: { id: 'leveler', label: 'Compressor', min: 0, max: 1, defaultValue: 0, format: fmtPct },
  punch: { id: 'punch', label: 'Punch', min: 0, max: 1, defaultValue: 0, format: fmtPct },
  saturationDrive: { id: 'saturationDrive', label: 'Saturation Drive', min: 0, max: 1, defaultValue: 0, format: fmtPct },
  saturationMix: { id: 'saturationMix', label: 'Saturation Mix', min: 0, max: 1, defaultValue: 1, format: fmtPct },
  bitCrusherRate: { id: 'bitCrusherRate', label: 'Crusher Rate', min: 0.01, max: 1, defaultValue: 1, format: fmtPct },
  bitCrusherBits: { id: 'bitCrusherBits', label: 'Crusher Bits', min: 1, max: 16, defaultValue: 16, format: (value) => `${Math.round(value)}-bit` },
  bitCrusherBoost: { id: 'bitCrusherBoost', label: 'Crusher Boost', min: 0, max: 1, defaultValue: 0, format: (value) => `+${Math.round(value * 12)} dB` },
  bitCrusherMix: { id: 'bitCrusherMix', label: 'Crusher Mix', min: 0, max: 1, defaultValue: 0, format: fmtPct },
  level: { id: 'level', label: 'Gain', min: -60, max: 6, defaultValue: 0, format: fmtDb }
}

/** Parameters exposed in the lane picker, in display order. P1 ships Filter; the
 *  remaining params are wired through the backend and enabled in P3. */
export const AUTOMATABLE_PARAM_IDS: readonly AutomationParamId[] = [
  'filter',
  'pan',
  'toneBass',
  'toneMid',
  'toneTreble',
  'reverbSend',
  'delaySend',
  'leveler',
  'punch',
  'saturationDrive',
  'saturationMix',
  'bitCrusherRate',
  'bitCrusherBits',
  'bitCrusherBoost',
  'bitCrusherMix',
  'level'
]

/** All parameters the data model + backend support (used by P3 rollout). */
export const ALL_AUTOMATION_PARAM_IDS: readonly AutomationParamId[] = [
  'filter',
  'pan',
  'toneBass',
  'toneMid',
  'toneTreble',
  'reverbSend',
  'delaySend',
  'leveler',
  'punch',
  'saturationDrive',
  'saturationMix',
  'bitCrusherRate',
  'bitCrusherBits',
  'bitCrusherBoost',
  'bitCrusherMix',
  'level'
]

export function automationDescriptor(paramId: AutomationParamId): AutomationParamDescriptor {
  return AUTOMATION_PARAMS[paramId]
}

/** Map a native value to a 0..1 fraction (0 = bottom of the lane). */
export function valueToFraction(paramId: AutomationParamId, value: number): number {
  const d = AUTOMATION_PARAMS[paramId]
  if (d.max === d.min) return 0
  return Math.min(1, Math.max(0, (value - d.min) / (d.max - d.min)))
}

/** Map a 0..1 fraction back to a native value. */
export function fractionToValue(paramId: AutomationParamId, fraction: number): number {
  const d = AUTOMATION_PARAMS[paramId]
  const f = Math.min(1, Math.max(0, fraction))
  return d.min + f * (d.max - d.min)
}

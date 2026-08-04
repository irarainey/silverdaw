import type { StemStage } from '@/lib/stemSeparationState'

// User-facing progress text for a stem separation. Kept out of the dialog so the
// wording is unit-testable.
export const STAGE_LABELS: Record<StemStage, string> = {
  prepare: 'Preparing audio...',
  'load-model': 'Loading models...',
  separate: 'Separating stems...',
  cleanup: 'Cleaning up stems...',
  write: 'Writing files...'
}

// Friendly labels keep backend stem names out of user-facing text.
export const STEM_LABELS: Record<string, string> = {
  vocals: 'Vocals',
  drums: 'Drums',
  bass: 'Bass',
  other: 'Other',
  // The rhythm quality pack separates drums and bass in a single pass.
  'drums+bass': 'Drums and Bass'
}

// Per-stem verbs for the stages that carry a stem name in `detail`.
const STEM_STAGE_VERBS: Partial<Record<StemStage, string>> = {
  separate: 'Separating',
  cleanup: 'Cleaning up'
}

export function stemStageLabel(stage: StemStage | undefined, detail?: string): string {
  if (!stage) return ''
  if (stage === 'prepare' && detail === 'gpu-fallback') {
    return 'GPU unavailable. Continuing on CPU...'
  }
  // Model loading is not named per stem: a job may load a model the user did not
  // ask for (the rhythm pack works on vocal-removed input), which reads as wrong.
  if (stage === 'load-model') {
    return STAGE_LABELS[stage]
  }
  const verb = STEM_STAGE_VERBS[stage]
  if (verb && detail && STEM_LABELS[detail]) {
    return `${verb} ${STEM_LABELS[detail]}...`
  }
  return STAGE_LABELS[stage]
}

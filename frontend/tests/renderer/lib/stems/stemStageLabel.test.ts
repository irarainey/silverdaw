import { describe, expect, it } from 'vitest'
import { stemStageLabel } from '@/lib/stems/stemStageLabel'

describe('stemStageLabel', () => {
  // A drums-only job still loads the vocal model first (the rhythm pack works on
  // vocal-removed input), so naming the model made the dialog look wrong.
  it('never names a model while loading, whichever stem the job reports', () => {
    expect(stemStageLabel('load-model', 'vocals')).toBe('Loading models...')
    expect(stemStageLabel('load-model', 'drums')).toBe('Loading models...')
    expect(stemStageLabel('load-model', 'drums+bass')).toBe('Loading models...')
    expect(stemStageLabel('load-model', undefined)).toBe('Loading models...')
  })

  it('still names the stem for the stages that genuinely work on one', () => {
    expect(stemStageLabel('separate', 'vocals')).toBe('Separating Vocals...')
    expect(stemStageLabel('separate', 'drums+bass')).toBe('Separating Drums and Bass...')
    expect(stemStageLabel('cleanup', 'bass')).toBe('Cleaning up Bass...')
  })

  it('falls back to the generic stage text without a recognised stem', () => {
    expect(stemStageLabel('separate', undefined)).toBe('Separating stems...')
    expect(stemStageLabel('cleanup', 'mystery')).toBe('Cleaning up stems...')
    expect(stemStageLabel('write', 'vocals')).toBe('Writing files...')
  })

  it('reports the GPU fallback in place of the prepare text', () => {
    expect(stemStageLabel('prepare', 'gpu-fallback')).toBe(
      'GPU unavailable. Continuing on CPU...'
    )
    expect(stemStageLabel('prepare', undefined)).toBe('Preparing audio...')
  })

  it('renders nothing when no job is running', () => {
    expect(stemStageLabel(undefined)).toBe('')
  })
})

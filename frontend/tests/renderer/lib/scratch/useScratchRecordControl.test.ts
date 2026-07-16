import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import {
  useScratchRecordControl
} from '@/lib/scratch/useScratchRecordControl'

function setup(overrides: {
  isRecording?: boolean
  isArmed?: boolean
  canRecord?: boolean
  hasDraft?: boolean
} = {}) {
  const isRecording = ref(overrides.isRecording ?? false)
  const isArmed = ref(overrides.isArmed ?? false)
  const canRecord = ref(overrides.canRecord ?? true)
  const hasDraft = ref(overrides.hasDraft ?? false)
  const armRecording = vi.fn()
  const disarmRecording = vi.fn()
  const stopRecording = vi.fn()
  const discardDraft = vi.fn()

  const control = useScratchRecordControl({
    isRecording,
    isArmed,
    canRecord,
    hasDraft,
    armRecording,
    disarmRecording,
    stopRecording,
    discardDraft
  })

  return { control, isRecording, isArmed, canRecord, hasDraft, armRecording, disarmRecording, stopRecording, discardDraft }
}

describe('useScratchRecordControl', () => {
  it('derives idle/armed/recording phase and matching button text', () => {
    const idle = setup()
    expect(idle.control.recordPhase.value).toBe('idle')
    expect(idle.control.recordButtonLabel.value).toBe('Record')
    expect(idle.control.recordButtonAriaLabel.value).toBe('Arm scratch recording')

    const armed = setup({ isArmed: true })
    expect(armed.control.recordPhase.value).toBe('armed')
    expect(armed.control.recordButtonLabel.value).toBe('Cancel')
    expect(armed.control.recordButtonClass.value).toContain('amber')

    const recording = setup({ isRecording: true })
    expect(recording.control.recordPhase.value).toBe('recording')
    expect(recording.control.recordButtonLabel.value).toBe('Stop')
    expect(recording.control.recordButtonClass.value).toContain('red-600')
  })

  it('idle press with a draft discards it before arming (armed-clear behaviour)', () => {
    const { control, discardDraft, armRecording, disarmRecording, stopRecording } = setup({ hasDraft: true })
    control.onRecordButton()
    expect(discardDraft).toHaveBeenCalledTimes(1)
    expect(armRecording).toHaveBeenCalledTimes(1)
    expect(disarmRecording).not.toHaveBeenCalled()
    expect(stopRecording).not.toHaveBeenCalled()
  })

  it('idle press without a draft arms directly, skipping discard', () => {
    const { control, discardDraft, armRecording } = setup({ hasDraft: false })
    control.onRecordButton()
    expect(discardDraft).not.toHaveBeenCalled()
    expect(armRecording).toHaveBeenCalledTimes(1)
  })

  it('armed press disarms rather than stopping or arming again', () => {
    const { control, disarmRecording, armRecording, stopRecording } = setup({ isArmed: true })
    control.onRecordButton()
    expect(disarmRecording).toHaveBeenCalledTimes(1)
    expect(armRecording).not.toHaveBeenCalled()
    expect(stopRecording).not.toHaveBeenCalled()
  })

  it('recording press stops the recording', () => {
    const { control, stopRecording, disarmRecording, armRecording } = setup({ isRecording: true })
    control.onRecordButton()
    expect(stopRecording).toHaveBeenCalledTimes(1)
    expect(disarmRecording).not.toHaveBeenCalled()
    expect(armRecording).not.toHaveBeenCalled()
  })

  it('ignores the press when idle and recording is not currently allowed', () => {
    const { control, armRecording } = setup({ canRecord: false })
    control.onRecordButton()
    expect(armRecording).not.toHaveBeenCalled()
  })
})

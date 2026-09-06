import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useRecordingSessionStore } from '@/stores/recordingSessionStore'
import type { RecordingInputsListPayload } from '@shared/bridge-protocol'

vi.mock('@/lib/bridgeService', () => ({
  send: vi.fn()
}))

vi.mock('@/lib/log', () => ({
  log: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn()
  }
}))

describe('recordingSessionStore.hasNoInput', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('says nothing yet before the listing arrives', () => {
    const store = useRecordingSessionStore()
    store.inputs = null
    expect(store.hasNoInput).toBe(false)
  })

  it('reports no input when no driver exposes a device', () => {
    const store = useRecordingSessionStore()
    store.inputs = {
      types: [{ name: 'Windows Audio', devices: [] }]
    } as RecordingInputsListPayload
    expect(store.hasNoInput).toBe(true)
  })

  // Windows exposes alias endpoints that stand for "whatever the default is". They are
  // filtered out of the picker, so a machine with only those has nothing to choose: the
  // dialog must say so rather than show an empty, disabled picker with no explanation.
  it('reports no input when the only devices are Windows pseudo endpoints', () => {
    const store = useRecordingSessionStore()
    store.inputs = {
      types: [
        { name: 'Windows Audio', devices: ['Primary Sound Capture Driver'] },
        { name: 'DirectSound', devices: ['Microsoft Sound Mapper'] }
      ]
    } as RecordingInputsListPayload
    expect(store.hasNoInput).toBe(true)
  })

  it('reports an input once a real device is listed alongside the pseudo ones', () => {
    const store = useRecordingSessionStore()
    store.inputs = {
      types: [
        { name: 'Windows Audio', devices: ['Primary Sound Capture Driver', 'Microphone (USB)'] }
      ]
    } as RecordingInputsListPayload
    expect(store.hasNoInput).toBe(false)
  })
})

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useTrackHeaderEditing } from './useTrackHeaderEditing'
import { useProjectStore } from '@/stores/projectStore'

vi.mock('@/lib/bridgeService', () => ({ send: vi.fn() }))
vi.mock('@/lib/log', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }
}))

function seedTrack(id: string, volume: number): void {
  const project = useProjectStore()
  project.tracks = [
    { id, name: id, volume } as unknown as (typeof project.tracks)[number]
  ]
}

describe('useTrackHeaderEditing', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('startRename seeds the editing state with the current name', async () => {
    const e = useTrackHeaderEditing()
    await e.startRename('t1', 'Drums')
    expect(e.editingTrackId.value).toBe('t1')
    expect(e.editingValue.value).toBe('Drums')
  })

  it('commitRename pushes the new name and clears edit state', () => {
    const project = useProjectStore()
    seedTrack('t1', 1)
    const setName = vi.spyOn(project, 'setTrackName').mockImplementation(() => {})
    const e = useTrackHeaderEditing()
    e.editingTrackId.value = 't1'
    e.editingValue.value = 'Bass'
    e.commitRename('t1')
    expect(setName).toHaveBeenCalledWith('t1', 'Bass')
    expect(e.editingTrackId.value).toBeNull()
  })

  it('commitRename ignores a mismatched track id', () => {
    const project = useProjectStore()
    const setName = vi.spyOn(project, 'setTrackName').mockImplementation(() => {})
    const e = useTrackHeaderEditing()
    e.editingTrackId.value = 't1'
    e.commitRename('t2')
    expect(setName).not.toHaveBeenCalled()
  })

  it('onRenameKeydown commits on Enter and cancels on Escape', () => {
    const project = useProjectStore()
    seedTrack('t1', 1)
    const setName = vi.spyOn(project, 'setTrackName').mockImplementation(() => {})
    const e = useTrackHeaderEditing()

    e.editingTrackId.value = 't1'
    e.editingValue.value = 'Lead'
    e.onRenameKeydown({ key: 'Enter', preventDefault: vi.fn() } as unknown as KeyboardEvent, 't1')
    expect(setName).toHaveBeenCalledWith('t1', 'Lead')

    e.editingTrackId.value = 't1'
    e.onRenameKeydown({ key: 'Escape', preventDefault: vi.fn() } as unknown as KeyboardEvent, 't1')
    expect(e.editingTrackId.value).toBeNull()
  })

  it('commitGainEdit parses dB text and clamps to the volume range', () => {
    const project = useProjectStore()
    seedTrack('t1', 1)
    const setVolume = vi.spyOn(project, 'setTrackVolume').mockImplementation(() => {})
    const e = useTrackHeaderEditing()
    e.editingGainTrackId.value = 't1'
    e.editingGainValue.value = '-6'
    e.commitGainEdit('t1')
    expect(setVolume).toHaveBeenCalledOnce()
    const [trackId, linear] = setVolume.mock.calls[0] as [string, number]
    expect(trackId).toBe('t1')
    expect(linear).toBeGreaterThan(0)
    expect(linear).toBeLessThan(1)
    expect(e.editingGainTrackId.value).toBeNull()
  })

  it('commitGainEdit treats -inf as silence (linear 0)', () => {
    const project = useProjectStore()
    seedTrack('t1', 1)
    const setVolume = vi.spyOn(project, 'setTrackVolume').mockImplementation(() => {})
    const e = useTrackHeaderEditing()
    e.editingGainTrackId.value = 't1'
    e.editingGainValue.value = '-inf'
    e.commitGainEdit('t1')
    expect(setVolume).toHaveBeenCalledWith('t1', 0)
  })

  it('commitGainEdit does not emit when the value is unchanged within epsilon', () => {
    const project = useProjectStore()
    seedTrack('t1', 1)
    const setVolume = vi.spyOn(project, 'setTrackVolume').mockImplementation(() => {})
    const e = useTrackHeaderEditing()
    e.editingGainTrackId.value = 't1'
    e.editingGainValue.value = '0' // 0 dB == unity == current volume of 1
    e.commitGainEdit('t1')
    expect(setVolume).not.toHaveBeenCalled()
    expect(e.editingGainTrackId.value).toBeNull()
  })

  it('onGainInput mirrors raw input text into the draft', () => {
    const e = useTrackHeaderEditing()
    e.onGainInput({ target: { value: '+1.5' } } as unknown as Event)
    expect(e.editingGainValue.value).toBe('+1.5')
  })
})

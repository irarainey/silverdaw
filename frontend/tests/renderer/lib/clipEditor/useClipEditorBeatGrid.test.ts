import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useClipEditorBeatGrid } from '@/lib/clipEditor/useClipEditorBeatGrid'
import { useLibraryStore, type LibraryItem } from '@/stores/libraryStore'

const sendMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/bridgeService', () => ({
  send: sendMock
}))
vi.mock('@/lib/log', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }
}))
vi.mock('@/lib/audioDecode', () => ({
  PEAKS_PER_SECOND: 200,
  decodeAudioToPeaks: vi.fn()
}))

function addSource(bpm?: number, beatAnchorSec?: number): LibraryItem {
  const library = useLibraryStore()
  const id = library.addItem({
    filePath: 'C:\\audio\\grid.wav',
    fileName: 'grid.wav',
    durationMs: 4_000,
    sampleRate: 44_100,
    channelCount: 2,
    peaks: new Float32Array([0, 1])
  })
  if (typeof bpm === 'number') library.setItemManualTempo(id, bpm, beatAnchorSec ?? 0)
  return library.byId[id]!
}

describe('useClipEditorBeatGrid', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sendMock.mockClear()
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'uuid-1') })
    vi.stubGlobal('URL', { createObjectURL: vi.fn(), revokeObjectURL: vi.fn() })
  })

  it('reports no grid and rejects align when the source has no tempo', () => {
    const item = addSource()
    const grid = useClipEditorBeatGrid({ sourceItem: () => item })
    expect(grid.hasGrid()).toBe(false)
    grid.toggleAlign()
    expect(grid.alignActive.value).toBe(false)
  })

  it('toggles align mode only when a grid exists', () => {
    const item = addSource(120, 0)
    const grid = useClipEditorBeatGrid({ sourceItem: () => item })
    expect(grid.hasGrid()).toBe(true)
    grid.toggleAlign()
    expect(grid.alignActive.value).toBe(true)
    grid.toggleAlign()
    expect(grid.alignActive.value).toBe(false)
  })

  it('gates canApply on a valid BPM range', () => {
    const item = addSource()
    const grid = useClipEditorBeatGrid({ sourceItem: () => item })
    grid.manualBpmInput.value = null
    expect(grid.canApply()).toBe(false)
    grid.manualBpmInput.value = 10
    expect(grid.canApply()).toBe(false)
    grid.manualBpmInput.value = 400
    expect(grid.canApply()).toBe(false)
    grid.manualBpmInput.value = 128
    expect(grid.canApply()).toBe(true)
  })

  it('applies the typed BPM through the store, keeping the current anchor', () => {
    const item = addSource(120, 0.3)
    const grid = useClipEditorBeatGrid({ sourceItem: () => item })
    sendMock.mockClear()
    grid.manualBpmInput.value = 96
    grid.applyManualBpm()
    expect(sendMock).toHaveBeenCalledWith('LIBRARY_ITEM_SET_MANUAL_TEMPO', {
      itemId: item.id,
      bpm: 96,
      beatAnchorSec: 0.3
    })
  })

  it('previews an anchor locally and commits it with the existing BPM', () => {
    const item = addSource(120, 0)
    const grid = useClipEditorBeatGrid({ sourceItem: () => item })
    sendMock.mockClear()

    grid.previewAnchorSec(0.12)
    expect(item.beatAnchorSec).toBe(0.12)
    expect(sendMock).not.toHaveBeenCalled()

    grid.commitAnchorSec(0.2)
    expect(sendMock).toHaveBeenCalledWith('LIBRARY_ITEM_SET_MANUAL_TEMPO', {
      itemId: item.id,
      bpm: 120,
      beatAnchorSec: 0.2
    })
  })

  it('reports a grid change only after the user pins a BPM or commits an anchor', () => {
    const item = addSource(120, 0)
    const grid = useClipEditorBeatGrid({ sourceItem: () => item })
    expect(grid.hasGridChanged()).toBe(false)

    grid.previewAnchorSec(0.1)
    expect(grid.hasGridChanged()).toBe(false)

    grid.commitAnchorSec(0.2)
    expect(grid.hasGridChanged()).toBe(true)
  })

  it('reports a grid change after applying a manual BPM', () => {
    const item = addSource(120, 0)
    const grid = useClipEditorBeatGrid({ sourceItem: () => item })
    expect(grid.hasGridChanged()).toBe(false)
    grid.manualBpmInput.value = 96
    grid.applyManualBpm()
    expect(grid.hasGridChanged()).toBe(true)
  })

  it('halves and doubles the source BPM, keeping the anchor', () => {
    const item = addSource(120, 0.25)
    const grid = useClipEditorBeatGrid({ sourceItem: () => item })
    sendMock.mockClear()

    grid.halveBpm()
    expect(sendMock).toHaveBeenLastCalledWith('LIBRARY_ITEM_SET_MANUAL_TEMPO', {
      itemId: item.id,
      bpm: 60,
      beatAnchorSec: 0.25
    })
    expect(grid.manualBpmInput.value).toBe(60)

    grid.doubleBpm()
    expect(sendMock).toHaveBeenLastCalledWith('LIBRARY_ITEM_SET_MANUAL_TEMPO', {
      itemId: item.id,
      bpm: 120,
      beatAnchorSec: 0.25
    })
    expect(grid.manualBpmInput.value).toBe(120)
    expect(grid.hasGridChanged()).toBe(true)
  })

  it('clamps an octave change that would leave the valid BPM range', () => {
    const item = addSource(200, 0)
    const grid = useClipEditorBeatGrid({ sourceItem: () => item })
    sendMock.mockClear()
    grid.doubleBpm()
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('nudges the anchor by a millisecond delta on the existing BPM', () => {
    const item = addSource(120, 0.5)
    const grid = useClipEditorBeatGrid({ sourceItem: () => item })
    sendMock.mockClear()
    grid.nudgeAnchorMs(-5)
    expect(sendMock).toHaveBeenCalledWith('LIBRARY_ITEM_SET_MANUAL_TEMPO', {
      itemId: item.id,
      bpm: 120,
      beatAnchorSec: 0.495
    })
    expect(grid.hasGridChanged()).toBe(true)
  })

  it('shifts the anchor by half a beat to flip an off-beat lock', () => {
    const item = addSource(120, 0.5)
    const grid = useClipEditorBeatGrid({ sourceItem: () => item })
    sendMock.mockClear()
    grid.nudgeHalfBeat(1)
    expect(sendMock).toHaveBeenCalledWith('LIBRARY_ITEM_SET_MANUAL_TEMPO', {
      itemId: item.id,
      bpm: 120,
      beatAnchorSec: 0.75
    })
  })

  it('captures the tempo at open as the original and restores it', () => {
    const item = addSource(120, 0.4)
    const grid = useClipEditorBeatGrid({ sourceItem: () => item })
    expect(grid.originalBpm.value).toBe(120)
    // Nothing to restore while the current tempo still matches the original.
    expect(grid.canRestore()).toBe(false)

    grid.manualBpmInput.value = 96
    grid.applyManualBpm()
    expect(item.bpm).toBe(96)
    expect(grid.canRestore()).toBe(true)

    sendMock.mockClear()
    grid.restoreOriginalBpm()
    expect(sendMock).toHaveBeenCalledWith('LIBRARY_ITEM_SET_MANUAL_TEMPO', {
      itemId: item.id,
      bpm: 120,
      beatAnchorSec: 0.4
    })
    expect(grid.manualBpmInput.value).toBe(120)
    expect(grid.canRestore()).toBe(false)
  })

  it('has no original to restore when the source opened without a tempo', () => {
    const item = addSource()
    const grid = useClipEditorBeatGrid({ sourceItem: () => item })
    expect(grid.originalBpm.value).toBeNull()
    expect(grid.canRestore()).toBe(false)
    sendMock.mockClear()
    grid.restoreOriginalBpm()
    expect(sendMock).not.toHaveBeenCalled()
  })
})

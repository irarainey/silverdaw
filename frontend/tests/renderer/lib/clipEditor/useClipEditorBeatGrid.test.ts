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
})

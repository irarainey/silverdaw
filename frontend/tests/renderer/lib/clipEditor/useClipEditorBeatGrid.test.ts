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

  it('seeds the tempo field with the current source BPM', () => {
    const item = addSource(140, 0)
    const grid = useClipEditorBeatGrid({ sourceItem: () => item })
    expect(grid.manualBpmInput.value).toBe('140.00')
  })

  // Edits are drafted locally during a session — no bridge round-trip — and committed
  // once on Save. Every edit assertion below checks the local (bpm, anchor) and that
  // nothing is sent until `commit`.

  it('drafts a valid typed tempo locally and reverts an out-of-range one', () => {
    const item = addSource(120, 0)
    const grid = useClipEditorBeatGrid({ sourceItem: () => item })
    sendMock.mockClear()

    grid.beginTempoEdit()
    grid.manualBpmInput.value = '10'
    grid.commitTempoEdit(true)
    expect(item.bpm).toBe(120)
    expect(grid.manualBpmInput.value).toBe('120.00')
    expect(sendMock).not.toHaveBeenCalled()

    grid.beginTempoEdit()
    grid.manualBpmInput.value = '128'
    grid.commitTempoEdit(true)
    expect(item.bpm).toBe(128)
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('does not draft when the committed tempo is unchanged', () => {
    const item = addSource(120, 0)
    const grid = useClipEditorBeatGrid({ sourceItem: () => item })
    grid.beginTempoEdit()
    grid.commitTempoEdit(true)
    expect(grid.hasGridChanged()).toBe(false)
  })

  it('drafts the typed BPM locally, keeping the current anchor', () => {
    const item = addSource(120, 0.3)
    const grid = useClipEditorBeatGrid({ sourceItem: () => item })
    sendMock.mockClear()
    grid.beginTempoEdit()
    grid.manualBpmInput.value = '96'
    grid.commitTempoEdit(true)
    expect(item.bpm).toBe(96)
    expect(item.beatAnchorSec).toBe(0.3)
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('previews and drafts an anchor locally with the existing BPM', () => {
    const item = addSource(120, 0)
    const grid = useClipEditorBeatGrid({ sourceItem: () => item })
    sendMock.mockClear()

    grid.previewAnchorSec(0.12)
    expect(item.beatAnchorSec).toBe(0.12)

    grid.commitAnchorSec(0.2)
    expect(item.beatAnchorSec).toBe(0.2)
    expect(item.bpm).toBe(120)
    expect(sendMock).not.toHaveBeenCalled()
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

  it('reports a grid change after drafting a manual BPM', () => {
    const item = addSource(120, 0)
    const grid = useClipEditorBeatGrid({ sourceItem: () => item })
    expect(grid.hasGridChanged()).toBe(false)
    grid.beginTempoEdit()
    grid.manualBpmInput.value = '96'
    grid.commitTempoEdit(true)
    expect(grid.hasGridChanged()).toBe(true)
  })

  it('halves and doubles the source BPM locally, keeping the anchor', () => {
    const item = addSource(120, 0.25)
    const grid = useClipEditorBeatGrid({ sourceItem: () => item })
    sendMock.mockClear()

    grid.halveBpm()
    expect(item.bpm).toBe(60)
    expect(item.beatAnchorSec).toBe(0.25)
    expect(grid.manualBpmInput.value).toBe('60.00')

    grid.doubleBpm()
    expect(item.bpm).toBe(120)
    expect(item.beatAnchorSec).toBe(0.25)
    expect(grid.manualBpmInput.value).toBe('120.00')
    expect(grid.hasGridChanged()).toBe(true)
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('clamps an octave change that would leave the valid BPM range', () => {
    const item = addSource(200, 0)
    const grid = useClipEditorBeatGrid({ sourceItem: () => item })
    grid.doubleBpm()
    expect(item.bpm).toBe(200)
    expect(grid.hasGridChanged()).toBe(false)
  })

  it('bumps the BPM locally by whole and fine steps, keeping the anchor and clamping', () => {
    const item = addSource(120, 0.25)
    const grid = useClipEditorBeatGrid({ sourceItem: () => item })
    sendMock.mockClear()

    grid.bumpBpm(1)
    expect(item.bpm).toBe(121)
    expect(item.beatAnchorSec).toBe(0.25)
    expect(grid.manualBpmInput.value).toBe('121.00')

    grid.bumpBpm(-0.01)
    expect(item.bpm).toBeCloseTo(120.99, 6)
    expect(grid.hasGridChanged()).toBe(true)
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('does not bump the BPM past the valid range', () => {
    const item = addSource(300, 0)
    const grid = useClipEditorBeatGrid({ sourceItem: () => item })
    grid.bumpBpm(1)
    expect(item.bpm).toBe(300)
    expect(grid.hasGridChanged()).toBe(false)
  })

  it('nudges the anchor by a millisecond delta on the existing BPM', () => {
    const item = addSource(120, 0.5)
    const grid = useClipEditorBeatGrid({ sourceItem: () => item })
    grid.nudgeAnchorMs(-5)
    expect(item.beatAnchorSec).toBeCloseTo(0.495, 6)
    expect(grid.hasGridChanged()).toBe(true)
  })

  it('shifts the anchor by half a beat to flip an off-beat lock', () => {
    const item = addSource(120, 0.5)
    const grid = useClipEditorBeatGrid({ sourceItem: () => item })
    grid.nudgeHalfBeat(1)
    expect(item.beatAnchorSec).toBe(0.75)
  })

  it('captures the tempo at open as the original and restores it locally', () => {
    const item = addSource(120, 0.4)
    const grid = useClipEditorBeatGrid({ sourceItem: () => item })
    expect(grid.originalBpm.value).toBe(120)
    // Nothing to restore while the current tempo still matches the original.
    expect(grid.canRestore()).toBe(false)

    grid.beginTempoEdit()
    grid.manualBpmInput.value = '96'
    grid.commitTempoEdit(true)
    expect(item.bpm).toBe(96)
    expect(grid.canRestore()).toBe(true)

    sendMock.mockClear()
    grid.restoreOriginalBpm()
    expect(item.bpm).toBe(120)
    expect(grid.manualBpmInput.value).toBe('120.00')
    expect(grid.canRestore()).toBe(false)
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('has no original to restore when the source opened without a tempo', () => {
    const item = addSource()
    const grid = useClipEditorBeatGrid({ sourceItem: () => item })
    expect(grid.originalBpm.value).toBeNull()
    expect(grid.canRestore()).toBe(false)
    grid.restoreOriginalBpm()
    expect(item.bpm).toBeUndefined()
  })

  it('persists the session final grid once on commit', () => {
    const item = addSource(120, 0)
    const grid = useClipEditorBeatGrid({ sourceItem: () => item })
    grid.reset()
    grid.nudgeAnchorMs(20)
    grid.beginTempoEdit()
    grid.manualBpmInput.value = '128'
    grid.commitTempoEdit(true)
    sendMock.mockClear()

    grid.commit()
    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(sendMock).toHaveBeenCalledWith('LIBRARY_ITEM_SET_MANUAL_TEMPO', {
      itemId: item.id,
      bpm: 128,
      beatAnchorSec: 0.02
    })
  })

  it('commit is a no-op without an edit, and only fires once', () => {
    const item = addSource(120, 0)
    const grid = useClipEditorBeatGrid({ sourceItem: () => item })
    grid.reset()
    sendMock.mockClear()

    grid.commit()
    expect(sendMock).not.toHaveBeenCalled()

    grid.commitAnchorSec(0.2)
    grid.commit()
    grid.commit()
    expect(sendMock).toHaveBeenCalledTimes(1)
  })

  it('discards an uncommitted draft back to the grid captured on open', () => {
    const item = addSource(120, 0.4)
    const grid = useClipEditorBeatGrid({ sourceItem: () => item })
    grid.reset()

    grid.beginTempoEdit()
    grid.manualBpmInput.value = '96'
    grid.commitTempoEdit(true)
    grid.commitAnchorSec(0.9)
    expect(item.bpm).toBe(96)
    expect(item.beatAnchorSec).toBe(0.9)

    sendMock.mockClear()
    grid.discardIfUncommitted()
    expect(item.bpm).toBe(120)
    expect(item.beatAnchorSec).toBe(0.4)
    expect(grid.hasGridChanged()).toBe(false)
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('does not roll back once the draft has been committed', () => {
    const item = addSource(120, 0.4)
    const grid = useClipEditorBeatGrid({ sourceItem: () => item })
    grid.reset()

    grid.commitAnchorSec(0.9)
    grid.commit()
    grid.discardIfUncommitted()
    expect(item.beatAnchorSec).toBe(0.9)
  })
})

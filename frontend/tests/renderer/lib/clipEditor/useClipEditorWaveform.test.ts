import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useClipEditorWaveform, type ClipEditorWaveformDeps } from '@/lib/clipEditor/useClipEditorWaveform'
import type { EditorHiResPeaks, ItemChannelPeaks, LibraryItem } from '@/stores/libraryStore'

const sendMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/bridgeService', () => ({
  send: sendMock
}))

/** Minimal source-item stub — only the fields ensureEditorHiResPeaks reads. */
function sourceStub(id: string): LibraryItem {
  return { id } as unknown as LibraryItem
}

interface Harness {
  zoom: { value: number }
  source: { value: LibraryItem | null }
  hiRes: { value: EditorHiResPeaks | null }
}

function makeWaveform(h: Harness): ReturnType<typeof useClipEditorWaveform> {
  const deps: ClipEditorWaveformDeps = {
    getCanvas: () => null,
    sourceItem: () => h.source.value,
    sourceDurationMs: () => 0,
    zoom: () => h.zoom.value,
    visibleInMs: () => 0,
    visibleDurationMs: () => 0,
    visibleEndMs: () => 0,
    viewInMs: () => 0,
    viewEndMs: () => 0,
    selectionInMs: () => 0,
    selectionEndMs: () => 0,
    selectionDurationMs: () => 0,
    editsExistingClip: () => false,
    playheadAbsMs: () => 0,
    volumeShapeAvailable: () => false,
    volumeEditActive: () => false,
    volumeShapeDurationMs: () => 0,
    draftPoints: () => [],
    draftEffectiveRatio: () => 1,
    draftReversed: () => false,
    editorHiResPeaks: () => h.hiRes.value,
    channelPeaksByItemId: () => ({}) as Record<string, ItemChannelPeaks>,
    waveformDisplayMode: () => 'summary',
    waveformStereoLanes: ref(false)
  }
  return useClipEditorWaveform(deps)
}

describe('useClipEditorWaveform — hi-res peaks request', () => {
  let h: Harness

  beforeEach(() => {
    sendMock.mockClear()
    h = {
      zoom: { value: 8 },
      source: { value: sourceStub('item-1') },
      hiRes: { value: null }
    }
  })

  it('does nothing without a source', () => {
    h.source.value = null
    makeWaveform(h).ensureEditorHiResPeaks()
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('does not request below the zoom threshold', () => {
    h.zoom.value = 3
    makeWaveform(h).ensureEditorHiResPeaks()
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('requests once past the threshold and de-dups repeat calls', () => {
    const wf = makeWaveform(h)
    wf.ensureEditorHiResPeaks()
    wf.ensureEditorHiResPeaks()
    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(sendMock).toHaveBeenCalledWith('CLIP_EDITOR_PEAKS_REQUEST', {
      libraryItemId: 'item-1',
      peaksPerSecond: 2000
    })
  })

  it('does not re-request when matching hi-res peaks already exist', () => {
    h.hiRes.value = {
      libraryItemId: 'item-1',
      peaksPerSecond: 2000,
      sampleRate: 44_100,
      peaks: new Float32Array(),
      channels: []
    }
    makeWaveform(h).ensureEditorHiResPeaks()
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('requests again for a different source', () => {
    const wf = makeWaveform(h)
    wf.ensureEditorHiResPeaks()
    h.source.value = sourceStub('item-2')
    wf.ensureEditorHiResPeaks()
    expect(sendMock).toHaveBeenCalledTimes(2)
  })

  it('resetHiResRequestKey allows the same source to be re-requested', () => {
    const wf = makeWaveform(h)
    wf.ensureEditorHiResPeaks()
    wf.ensureEditorHiResPeaks()
    expect(sendMock).toHaveBeenCalledTimes(1)
    wf.resetHiResRequestKey()
    wf.ensureEditorHiResPeaks()
    expect(sendMock).toHaveBeenCalledTimes(2)
  })
})

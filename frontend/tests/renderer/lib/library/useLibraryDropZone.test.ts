import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useLibraryDropZone } from '@/lib/library/useLibraryDropZone'
import { useLibraryStore } from '@/stores/libraryStore'

const importAudioIntoLibraryMock = vi.hoisted(() => vi.fn())
const preflightSampleRatesMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/importAudio', () => ({
  importAudioIntoLibrary: importAudioIntoLibraryMock,
  preflightSampleRates: preflightSampleRatesMock
}))

vi.mock('@/lib/bridgeService', () => ({ send: vi.fn() }))
vi.mock('@/lib/log', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }
}))
vi.mock('@/lib/audio', () => ({ PEAKS_PER_SECOND: 200, decodeAudioToPeaks: vi.fn() }))

function fileDragEvent(types: string[], files: { name: string }[] = []): DragEvent {
  return {
    preventDefault: vi.fn(),
    dataTransfer: {
      types,
      files,
      dropEffect: ''
    }
  } as unknown as DragEvent
}

describe('useLibraryDropZone', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    importAudioIntoLibraryMock.mockReset()
    preflightSampleRatesMock.mockReset()
    ;(globalThis as unknown as { window: unknown }).window = {
      silverdaw: {
        getPathForFile: vi.fn((f: { name: string }) => `C:\\drop\\${f.name}`),
        readAudioFile: vi.fn(async () => ({ filePath: 'x', fileName: 'x' }))
      }
    }
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('ignores drags that carry no filesystem files', () => {
    const zone = useLibraryDropZone()
    const e = fileDragEvent(['text/plain'])
    zone.onPanelDragEnter(e)
    expect(zone.isDragOver.value).toBe(false)
    expect(e.preventDefault).not.toHaveBeenCalled()
  })

  it('highlights on dragenter and clears once nested leaves balance', () => {
    const zone = useLibraryDropZone()
    zone.onPanelDragEnter(fileDragEvent(['Files']))
    zone.onPanelDragEnter(fileDragEvent(['Files']))
    expect(zone.isDragOver.value).toBe(true)
    zone.onPanelDragLeave(fileDragEvent(['Files']))
    expect(zone.isDragOver.value).toBe(true)
    zone.onPanelDragLeave(fileDragEvent(['Files']))
    expect(zone.isDragOver.value).toBe(false)
  })

  it('sets copy dropEffect on dragover', () => {
    const zone = useLibraryDropZone()
    const e = fileDragEvent(['Files'])
    zone.onPanelDragOver(e)
    expect(e.dataTransfer?.dropEffect).toBe('copy')
  })

  it('aborts the whole batch when the sample-rate preflight is cancelled', async () => {
    preflightSampleRatesMock.mockResolvedValue('cancel')
    const zone = useLibraryDropZone()
    await zone.onPanelDrop(fileDragEvent(['Files'], [{ name: 'a.wav' }]))
    expect(preflightSampleRatesMock).toHaveBeenCalledTimes(1)
    expect(importAudioIntoLibraryMock).not.toHaveBeenCalled()
    expect(zone.isDragOver.value).toBe(false)
  })

  it('imports each resolved file after the preflight passes', async () => {
    preflightSampleRatesMock.mockResolvedValue('proceed')
    const library = useLibraryStore()
    const begin = vi.spyOn(library, 'beginImportBatch')
    const zone = useLibraryDropZone()
    await zone.onPanelDrop(fileDragEvent(['Files'], [{ name: 'a.wav' }, { name: 'b.wav' }]))
    expect(begin).toHaveBeenCalledWith(2)
    expect(importAudioIntoLibraryMock).toHaveBeenCalledTimes(2)
  })

  it('skips files that have no resolvable path and still completes the bar', async () => {
    ;(window.silverdaw.getPathForFile as ReturnType<typeof vi.fn>).mockReturnValue('')
    const zone = useLibraryDropZone()
    await zone.onPanelDrop(fileDragEvent(['Files'], [{ name: 'a.wav' }]))
    expect(preflightSampleRatesMock).not.toHaveBeenCalled()
    expect(importAudioIntoLibraryMock).not.toHaveBeenCalled()
  })
})

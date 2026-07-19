import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useLibraryDropZone } from '@/lib/library/useLibraryDropZone'

const importDroppedAudioFilesMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/importAudio', () => ({
  hasDroppedFiles: (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false,
  importDroppedAudioFiles: importDroppedAudioFilesMock
}))

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
    importDroppedAudioFilesMock.mockReset()
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

  it('delegates dropped files to the shared import pipeline', async () => {
    const zone = useLibraryDropZone()
    const file = { name: 'a.wav' }
    await zone.onPanelDrop(fileDragEvent(['Files'], [file]))
    expect(importDroppedAudioFilesMock).toHaveBeenCalledWith([file])
    expect(zone.isDragOver.value).toBe(false)
  })

  it('does not import an empty file drop', async () => {
    const zone = useLibraryDropZone()
    await zone.onPanelDrop(fileDragEvent(['Files']))
    expect(importDroppedAudioFilesMock).toHaveBeenCalledWith([])
  })
})

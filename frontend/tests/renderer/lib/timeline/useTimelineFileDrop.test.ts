import { ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useTimelineFileDrop } from '@/lib/timeline/useTimelineFileDrop'

const importDroppedAudioFilesMock = vi.hoisted(() => vi.fn())
const addTrackMock = vi.hoisted(() => vi.fn())
const addClipFromLibraryMock = vi.hoisted(() => vi.fn())
const runInUndoGroupMock = vi.hoisted(() => vi.fn())

const project = {
  tracks: [] as { id: string }[],
  addTrack: addTrackMock,
  addClipFromLibrary: addClipFromLibraryMock
}

vi.mock('@/lib/importAudio', () => ({
  hasDroppedFiles: (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false,
  importDroppedAudioFiles: importDroppedAudioFilesMock,
  libraryItemToClipPlacement: (item: { id: string }) => ({ id: item.id })
}))

vi.mock('@/lib/undo/undoGroup', () => ({
  runInUndoGroup: runInUndoGroupMock
}))

vi.mock('@/stores/projectStore', () => ({
  useProjectStore: () => project
}))

interface EventHandlers {
  dragenter: (event: DragEvent) => void
  dragover: (event: DragEvent) => void
  dragleave: (event: DragEvent) => void
  drop: (event: DragEvent) => Promise<void>
}

function createHost(): { host: HTMLElement; handlers: Partial<EventHandlers> } {
  const handlers: Partial<EventHandlers> = {}
  const host = {
    addEventListener: (type: keyof EventHandlers, handler: EventHandlers[keyof EventHandlers]) => {
      handlers[type] = handler as never
    },
    removeEventListener: vi.fn(),
    contains: () => false
  } as unknown as HTMLElement
  return { host, handlers }
}

function fileDropEvent(files: { name: string }[]): DragEvent {
  return {
    clientX: 100,
    clientY: 200,
    preventDefault: vi.fn(),
    dataTransfer: {
      types: ['Files'],
      files,
      dropEffect: ''
    }
  } as unknown as DragEvent
}

describe('useTimelineFileDrop', () => {
  beforeEach(() => {
    project.tracks = []
    importDroppedAudioFilesMock.mockReset()
    addTrackMock.mockReset()
    addClipFromLibraryMock.mockReset()
    runInUndoGroupMock.mockReset()
    runInUndoGroupMock.mockImplementation((_label: string, body: () => void) => body())
  })

  it('imports and places one dropped file on its target track', async () => {
    project.tracks = [{ id: 'track-1' }]
    importDroppedAudioFilesMock.mockResolvedValue([{ id: 'library-1' }])
    addClipFromLibraryMock.mockReturnValue('clip-1')
    const { host, handlers } = createHost()
    const startMsForItem = vi.fn(() => 1_000)
    const onPlaced = vi.fn()

    useTimelineFileDrop({
      host: ref(host),
      resolveDropTarget: () => ({ createNewTrack: false, trackIndex: 0, rawMs: 900 }),
      startMsForItem,
      onPlaced
    })

    await handlers.drop!(fileDropEvent([{ name: 'vocal.wav' }]))

    expect(importDroppedAudioFilesMock).toHaveBeenCalledWith([{ name: 'vocal.wav' }])
    expect(addTrackMock).not.toHaveBeenCalled()
    expect(addClipFromLibraryMock).toHaveBeenCalledWith('track-1', { id: 'library-1' }, 1_000)
    expect(onPlaced).toHaveBeenCalledOnce()
  })

  it('creates one track per file for a multi-file drop', async () => {
    project.tracks = [{ id: 'track-1' }]
    importDroppedAudioFilesMock.mockResolvedValue([{ id: 'library-1' }, { id: 'library-2' }])
    addTrackMock.mockReturnValueOnce('track-2').mockReturnValueOnce('track-3')
    addClipFromLibraryMock.mockReturnValue('clip')
    const { host, handlers } = createHost()

    useTimelineFileDrop({
      host: ref(host),
      resolveDropTarget: () => ({ createNewTrack: false, trackIndex: 0, rawMs: 900 }),
      startMsForItem: (rawMs, item) => rawMs + (item.id === 'library-1' ? 0 : 100),
      onPlaced: vi.fn()
    })

    await handlers.drop!(fileDropEvent([{ name: 'drums.wav' }, { name: 'bass.wav' }]))

    expect(runInUndoGroupMock).toHaveBeenCalledWith('Add dropped audio to tracks', expect.any(Function))
    expect(addTrackMock).toHaveBeenCalledTimes(2)
    expect(addClipFromLibraryMock).toHaveBeenNthCalledWith(1, 'track-2', { id: 'library-1' }, 900)
    expect(addClipFromLibraryMock).toHaveBeenNthCalledWith(2, 'track-3', { id: 'library-2' }, 1_000)
  })
})

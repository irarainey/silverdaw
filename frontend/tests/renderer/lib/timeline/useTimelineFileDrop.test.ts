import { ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useTimelineFileDrop } from '@/lib/timeline/useTimelineFileDrop'

const importDroppedAudioFilesMock = vi.hoisted(() => vi.fn())
const importDroppedAudioPathsMock = vi.hoisted(() => vi.fn())
const addTrackMock = vi.hoisted(() => vi.fn())
const addClipFromLibraryMock = vi.hoisted(() => vi.fn())
const runInUndoGroupMock = vi.hoisted(() => vi.fn())

const project = {
  tracks: [] as { id: string }[],
  addTrack: addTrackMock,
  addClipFromLibrary: addClipFromLibraryMock
}

const fileBrowser = {
  draggingPath: null as string | null,
  info: {} as Record<string, { durationMs?: number }>
}

// The ghost is owned by useDropZone; this hook only feeds it.
const previewExternalDropMock = vi.hoisted(() => vi.fn())
const clearExternalDropMock = vi.hoisted(() => vi.fn())
const previewOptions = {
  previewExternalDrop: previewExternalDropMock,
  clearExternalDrop: clearExternalDropMock
}

vi.mock('@/lib/importAudio', () => ({
  hasDroppedFiles: (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false,
  importDroppedAudioFiles: importDroppedAudioFilesMock,
  importDroppedAudioPaths: importDroppedAudioPathsMock,
  libraryItemToClipPlacement: (item: { id: string }) => ({ id: item.id })
}))

vi.mock('@/lib/undo/undoGroup', () => ({
  runInUndoGroup: runInUndoGroupMock
}))

vi.mock('@/stores/projectStore', () => ({
  useProjectStore: () => project
}))

vi.mock('@/stores/fileBrowserStore', () => ({
  useFileBrowserStore: () => fileBrowser,
  MIME_FILE_BROWSER_PATH: 'application/x-silverdaw-file-path'
}))

interface EventHandlers {
  dragenter: (event: DragEvent) => void
  dragover: (event: DragEvent) => void
  dragleave: (event: DragEvent) => void
  drop: (event: DragEvent) => Promise<void>
}

function createHost(): {
  host: HTMLElement
  handlers: Partial<EventHandlers>
  removeEventListener: ReturnType<typeof vi.fn>
} {
  const handlers: Partial<EventHandlers> = {}
  const removeEventListener = vi.fn()
  const host = {
    addEventListener: (type: keyof EventHandlers, handler: EventHandlers[keyof EventHandlers]) => {
      handlers[type] = handler as never
    },
    removeEventListener,
    contains: () => false
  } as unknown as HTMLElement
  return { host, handlers, removeEventListener }
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

function browserRowDropEvent(path: string | null): DragEvent {
  return {
    clientX: 100,
    clientY: 200,
    preventDefault: vi.fn(),
    dataTransfer: {
      types: [],
      files: [],
      dropEffect: '',
      getData: (type: string) =>
        type === 'application/x-silverdaw-file-path' && path ? path : ''
    }
  } as unknown as DragEvent
}

describe('useTimelineFileDrop', () => {
  beforeEach(() => {
    project.tracks = []
    fileBrowser.draggingPath = null
    fileBrowser.info = {}
    previewExternalDropMock.mockReset()
    clearExternalDropMock.mockReset()
    importDroppedAudioFilesMock.mockReset()
    importDroppedAudioPathsMock.mockReset()
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
      ...previewOptions,
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
      ...previewOptions,
      onPlaced: vi.fn()
    })

    await handlers.drop!(fileDropEvent([{ name: 'drums.wav' }, { name: 'bass.wav' }]))

    expect(runInUndoGroupMock).toHaveBeenCalledWith('Add dropped audio to tracks', expect.any(Function))
    expect(addTrackMock).toHaveBeenCalledTimes(2)
    expect(addClipFromLibraryMock).toHaveBeenNthCalledWith(1, 'track-2', { id: 'library-1' }, 900)
    expect(addClipFromLibraryMock).toHaveBeenNthCalledWith(2, 'track-3', { id: 'library-2' }, 1_000)
  })

  it('imports a file-browser row by path and places it on its target track', async () => {
    project.tracks = [{ id: 'track-1' }]
    fileBrowser.draggingPath = 'D:\\music\\vocal.wav'
    importDroppedAudioPathsMock.mockResolvedValue([{ id: 'library-1' }])
    addClipFromLibraryMock.mockReturnValue('clip-1')
    const { host, handlers } = createHost()
    const onPlaced = vi.fn()

    useTimelineFileDrop({
      host: ref(host),
      resolveDropTarget: () => ({ createNewTrack: false, trackIndex: 0, rawMs: 900 }),
      startMsForItem: () => 1_000,
      ...previewOptions,
      onPlaced
    })

    await handlers.drop!(browserRowDropEvent('D:\\music\\vocal.wav'))

    expect(importDroppedAudioPathsMock).toHaveBeenCalledWith(['D:\\music\\vocal.wav'])
    expect(importDroppedAudioFilesMock).not.toHaveBeenCalled()
    expect(addClipFromLibraryMock).toHaveBeenCalledWith('track-1', { id: 'library-1' }, 1_000)
    expect(onPlaced).toHaveBeenCalledOnce()
  })

  it('falls back to the store path when the drop carries no MIME payload', async () => {
    project.tracks = [{ id: 'track-1' }]
    fileBrowser.draggingPath = 'D:\\music\\bass.wav'
    importDroppedAudioPathsMock.mockResolvedValue([{ id: 'library-9' }])
    addClipFromLibraryMock.mockReturnValue('clip-9')
    const { host, handlers } = createHost()

    useTimelineFileDrop({
      host: ref(host),
      resolveDropTarget: () => ({ createNewTrack: false, trackIndex: 0, rawMs: 0 }),
      startMsForItem: () => 0,
      ...previewOptions,
      onPlaced: vi.fn()
    })

    await handlers.drop!(browserRowDropEvent(null))

    expect(importDroppedAudioPathsMock).toHaveBeenCalledWith(['D:\\music\\bass.wav'])
  })

  it('creates a track for a file-browser row dropped below the last track', async () => {
    fileBrowser.draggingPath = 'D:\\music\\pad.wav'
    importDroppedAudioPathsMock.mockResolvedValue([{ id: 'library-2' }])
    addTrackMock.mockReturnValue('track-new')
    addClipFromLibraryMock.mockReturnValue('clip-2')
    const { host, handlers } = createHost()

    useTimelineFileDrop({
      host: ref(host),
      resolveDropTarget: () => ({ createNewTrack: true, rawMs: 500 }),
      startMsForItem: () => 500,
      ...previewOptions,
      onPlaced: vi.fn()
    })

    await handlers.drop!(browserRowDropEvent('D:\\music\\pad.wav'))

    expect(runInUndoGroupMock).toHaveBeenCalledWith('Add dropped audio to tracks', expect.any(Function))
    expect(addTrackMock).toHaveBeenCalledOnce()
    expect(addClipFromLibraryMock).toHaveBeenCalledWith('track-new', { id: 'library-2' }, 500)
  })

  it('drives the shared drop ghost for a file-browser drag that carries no OS files', () => {
    // A dragged file used to get its own dashed overlay instead of the ghost a dragged
    // library item gets, so the same gesture looked like two different features.
    fileBrowser.draggingPath = 'D:\\music\\vocal.wav'
    fileBrowser.info['D:\\music\\vocal.wav'] = { durationMs: 8_000 }
    const { host, handlers } = createHost()
    useTimelineFileDrop({
      host: ref(host),
      resolveDropTarget: vi.fn(),
      startMsForItem: vi.fn(),
      ...previewOptions,
      onPlaced: vi.fn()
    })

    handlers.dragenter!(browserRowDropEvent('D:\\music\\vocal.wav'))

    expect(previewExternalDropMock).toHaveBeenCalledWith(100, 200, 8_000)
  })

  it('previews an unknown length when the drag carries no duration', () => {
    // An Explorer drag hides the file entirely until drop, so there is no length to
    // show; the ghost still has to appear, running to the edge of the view.
    const { host, handlers } = createHost()
    useTimelineFileDrop({
      host: ref(host),
      resolveDropTarget: vi.fn(),
      startMsForItem: vi.fn(),
      ...previewOptions,
      onPlaced: vi.fn()
    })

    handlers.dragover!(fileDropEvent([{ name: 'vocal.wav' }]))

    expect(previewExternalDropMock).toHaveBeenCalledWith(100, 200, null)
  })

  it('ignores a drag that is neither OS files nor a file-browser row', () => {
    const { host, handlers } = createHost()
    useTimelineFileDrop({
      host: ref(host),
      resolveDropTarget: vi.fn(),
      startMsForItem: vi.fn(),
      ...previewOptions,
      onPlaced: vi.fn()
    })

    handlers.dragenter!(browserRowDropEvent(null))

    expect(previewExternalDropMock).not.toHaveBeenCalled()
  })

  it('removes drag listeners from the host when disposed', () => {    const { host, removeEventListener } = createHost()
    const drop = useTimelineFileDrop({
      host: ref(host),
      resolveDropTarget: vi.fn(),
      startMsForItem: vi.fn(),
      ...previewOptions,
      onPlaced: vi.fn()
    })

    drop.dispose()

    expect(removeEventListener).toHaveBeenCalledTimes(4)
    expect(removeEventListener).toHaveBeenCalledWith('dragenter', expect.any(Function))
    expect(removeEventListener).toHaveBeenCalledWith('dragover', expect.any(Function))
    expect(removeEventListener).toHaveBeenCalledWith('dragleave', expect.any(Function))
    expect(removeEventListener).toHaveBeenCalledWith('drop', expect.any(Function))
  })
})

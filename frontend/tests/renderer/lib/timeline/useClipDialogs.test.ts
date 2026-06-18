import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useClipDialogs } from '@/lib/timeline/useClipDialogs'
import { useProjectStore, type Clip } from '@/stores/projectStore'
import { useLibraryStore, type LibraryItem } from '@/stores/libraryStore'

vi.mock('@/lib/bridgeService', () => ({ send: vi.fn() }))
vi.mock('@/lib/log', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }
}))
vi.mock('@/lib/audioDecode', () => ({ PEAKS_PER_SECOND: 200, decodeAudioToPeaks: vi.fn() }))

function makeItem(overrides: Partial<LibraryItem> = {}): LibraryItem {
  return {
    id: 'src',
    kind: 'source',
    fileName: 'src.wav',
    filePath: 'C:\\src.wav',
    playbackFilePath: 'C:\\src.wav',
    durationMs: 5_000,
    sampleRate: 48_000,
    channelCount: 2,
    peaks: new Float32Array(),
    ...overrides
  } as LibraryItem
}

function makeClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'clip-1',
    trackId: 'track-1',
    libraryItemId: 'src',
    filePath: 'C:\\src.wav',
    fileName: 'src.wav',
    startMs: 0,
    inMs: 0,
    durationMs: 1_000,
    sampleRate: 48_000,
    channelCount: 2,
    peaks: new Float32Array(),
    unresolved: false,
    ...overrides
  } as Clip
}

describe('useClipDialogs', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('opens and closes the editor dialog', () => {
    const dialogs = useClipDialogs()
    expect(dialogs.editorClipId.value).toBe(null)
    dialogs.openEditor('clip-1')
    expect(dialogs.editorClipId.value).toBe('clip-1')
    dialogs.closeEditor()
    expect(dialogs.editorClipId.value).toBe(null)
  })

  it('opens and closes the info dialog', () => {
    const dialogs = useClipDialogs()
    dialogs.openInfo('clip-2')
    expect(dialogs.infoClipId.value).toBe('clip-2')
    dialogs.closeInfo()
    expect(dialogs.infoClipId.value).toBe(null)
  })

  it('openWarp sets clip id + panel and opens the dialog', () => {
    const dialogs = useClipDialogs()
    dialogs.openWarp('clip-3', 'pitch')
    expect(dialogs.warpDialogClipId.value).toBe('clip-3')
    expect(dialogs.warpDialogPanel.value).toBe('pitch')
    expect(dialogs.warpDialogOpen.value).toBe(true)
    dialogs.closeWarp()
    expect(dialogs.warpDialogOpen.value).toBe(false)
  })

  it('editorItem resolves to the LibraryItem for the open clip', () => {
    const project = useProjectStore()
    const library = useLibraryStore()
    library.items = [makeItem({ id: 'src' })]
    project.clips = { 'clip-1': makeClip({ id: 'clip-1', libraryItemId: 'src' }) }
    const dialogs = useClipDialogs()
    dialogs.openEditor('clip-1')
    expect(dialogs.editorItem.value?.id).toBe('src')
  })

  it('editorItem is null when the clip exists but its library item is missing', () => {
    const project = useProjectStore()
    const library = useLibraryStore()
    library.items = []
    project.clips = { 'clip-1': makeClip({ id: 'clip-1', libraryItemId: 'missing' }) }
    const dialogs = useClipDialogs()
    dialogs.openEditor('clip-1')
    expect(dialogs.editorItem.value).toBe(null)
  })

  it('infoItem follows the same resolution rules as editorItem', () => {
    const project = useProjectStore()
    const library = useLibraryStore()
    library.items = [makeItem({ id: 'src', fileName: 'foo.wav' })]
    project.clips = { 'clip-9': makeClip({ id: 'clip-9', libraryItemId: 'src' }) }
    const dialogs = useClipDialogs()
    dialogs.openInfo('clip-9')
    expect(dialogs.infoItem.value?.fileName).toBe('foo.wav')
    dialogs.closeInfo()
    expect(dialogs.infoItem.value).toBe(null)
  })
})

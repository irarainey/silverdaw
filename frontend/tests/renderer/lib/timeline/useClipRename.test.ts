import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useClipRename, type ClipRenameDeps } from '@/lib/timeline/useClipRename'
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

const deps: ClipRenameDeps = {
  headerWidth: () => 200,
  pxPerSecond: () => 100,
  scrollX: () => 0,
  scrollY: () => 0
}

function seedProject(clip: Clip): ReturnType<typeof useProjectStore> {
  const project = useProjectStore()
  const library = useLibraryStore()
  library.items = [makeItem({ id: clip.libraryItemId })]
  project.clips = { [clip.id]: clip }
  project.tracks = [{ id: clip.trackId, name: 'Track 1', clipIds: [clip.id] }] as unknown as typeof project.tracks
  return project
}

describe('useClipRename', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('startClipRename seeds the editing state from the clip name', () => {
    seedProject(makeClip({ name: 'My Clip' }))
    const r = useClipRename(deps)
    r.startClipRename('clip-1')
    expect(r.renamingClipId.value).toBe('clip-1')
    expect(r.renameValue.value).toBe('My Clip')
  })

  it('startClipRename ignores an unknown clip id', () => {
    seedProject(makeClip())
    const r = useClipRename(deps)
    r.startClipRename('nope')
    expect(r.renamingClipId.value).toBe(null)
  })

  it('commitClipRename writes through to the project store and clears', () => {
    const project = seedProject(makeClip({ name: 'Old' }))
    const spy = vi.spyOn(project, 'renameClip')
    const r = useClipRename(deps)
    r.startClipRename('clip-1')
    r.renameValue.value = 'New name'
    r.commitClipRename()
    expect(spy).toHaveBeenCalledWith('clip-1', 'New name')
    expect(r.renamingClipId.value).toBe(null)
  })

  it('cancelClipRename clears without writing', () => {
    const project = seedProject(makeClip())
    const spy = vi.spyOn(project, 'renameClip')
    const r = useClipRename(deps)
    r.startClipRename('clip-1')
    r.cancelClipRename()
    expect(spy).not.toHaveBeenCalled()
    expect(r.renamingClipId.value).toBe(null)
  })

  it('renameOverlayStyle is null when no rename is active', () => {
    seedProject(makeClip())
    const r = useClipRename(deps)
    expect(r.renameOverlayStyle.value).toBe(null)
  })

  it('renameOverlayStyle positions the input over the clip header', () => {
    seedProject(makeClip({ startMs: 0 }))
    const r = useClipRename(deps)
    r.startClipRename('clip-1')
    const style = r.renameOverlayStyle.value
    expect(style).not.toBe(null)
    // headerWidth(200) + startMs(0) - scrollX(0).
    expect(style?.left).toBe('200px')
    expect(style?.height).toBe('18px')
  })

  it('Enter commits via the document key handler', () => {
    const project = seedProject(makeClip())
    const spy = vi.spyOn(project, 'renameClip')
    const r = useClipRename(deps)
    r.startClipRename('clip-1')
    r.renameValue.value = 'Renamed'
    const e = { key: 'Enter', preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as KeyboardEvent
    r.onRenameDocumentKeyDown(e)
    expect(spy).toHaveBeenCalledWith('clip-1', 'Renamed')
  })

  it('Escape cancels via the document key handler', () => {
    const project = seedProject(makeClip())
    const spy = vi.spyOn(project, 'renameClip')
    const r = useClipRename(deps)
    r.startClipRename('clip-1')
    const e = { key: 'Escape', preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as KeyboardEvent
    r.onRenameDocumentKeyDown(e)
    expect(spy).not.toHaveBeenCalled()
    expect(r.renamingClipId.value).toBe(null)
  })

  it('pointerdown handler is a no-op when no input element is wired', () => {
    const project = seedProject(makeClip())
    const spy = vi.spyOn(project, 'renameClip')
    const r = useClipRename(deps)
    r.startClipRename('clip-1')
    // No input element wired -> handler returns early without committing.
    const outside = { target: null } as unknown as PointerEvent
    r.onRenameDocumentPointerDown(outside)
    expect(spy).not.toHaveBeenCalled()
  })
})

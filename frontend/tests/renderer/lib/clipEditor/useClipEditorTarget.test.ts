import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useClipEditorTarget } from '@/lib/clipEditor/useClipEditorTarget'
import { useLibraryStore, type LibraryItem } from '@/stores/libraryStore'
import { useProjectStore, type Clip } from '@/stores/projectStore'

vi.mock('@/lib/bridgeService', () => ({
  send: vi.fn()
}))
vi.mock('@/lib/log', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }
}))
vi.mock('@/lib/audioDecode', () => ({
  PEAKS_PER_SECOND: 200,
  decodeAudioToPeaks: vi.fn()
}))

function makeSourceItem(overrides: Partial<LibraryItem> = {}): LibraryItem {
  return {
    id: 'src',
    kind: 'audio-file',
    fileName: 'src.wav',
    filePath: 'C:\\src.wav',
    playbackFilePath: 'C:\\src.wav',
    durationMs: 10_000,
    sampleRate: 48_000,
    channelCount: 2,
    peaks: new Float32Array(),
    bpm: 120,
    key: 'C major',
    ...overrides
  } as LibraryItem
}

function makeSavedClipItem(sourceId: string, overrides: Partial<LibraryItem> = {}): LibraryItem {
  return {
    id: 'saved',
    kind: 'saved-clip',
    fileName: 'src.wav',
    filePath: 'C:\\src.wav',
    playbackFilePath: 'C:\\src.wav',
    durationMs: 2_000,
    sampleRate: 48_000,
    channelCount: 2,
    peaks: new Float32Array(),
    derivedFrom: { sourceItemId: sourceId, sourceClipId: '', inMs: 1_000, durationMs: 2_000 },
    ...overrides
  } as LibraryItem
}

function makeTimelineClip(libraryItemId: string, overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'clip-1',
    trackId: 'track-1',
    libraryItemId,
    filePath: 'C:\\src.wav',
    fileName: 'src.wav',
    startMs: 0,
    inMs: 0,
    durationMs: 2_000,
    sampleRate: 48_000,
    channelCount: 2,
    peaks: new Float32Array(),
    unresolved: false,
    ...overrides
  } as Clip
}

describe('useClipEditorTarget', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('returns null mode when no item or clipId is provided', () => {
    const target = useClipEditorTarget(ref(null), ref(null))
    expect(target.editorMode.value).toBe(null)
    expect(target.editsExistingClip.value).toBe(false)
    expect(target.editsSavedClipLibrary.value).toBe(false)
    expect(target.editsSingleTimelineClip.value).toBe(false)
  })

  it('classifies a source audio-file library item as source-library', () => {
    const lib = useLibraryStore()
    lib.items.push(makeSourceItem())
    const target = useClipEditorTarget(ref(lib.items[0]!), ref(null))
    expect(target.editorMode.value).toBe('source-library')
    expect(target.editsExistingClip.value).toBe(false)
    expect(target.titleText.value).toBe('src.wav')
    expect(target.sourceItem.value?.id).toBe('src')
    expect(target.sourceBpm.value).toBe(120)
    expect(target.sourceKey.value).toBe('C major')
  })

  it('classifies a saved-clip library item as saved-library and points sourceItem at the parent audio-file', () => {
    const lib = useLibraryStore()
    lib.items.push(makeSourceItem())
    lib.items.push(makeSavedClipItem('src'))
    const target = useClipEditorTarget(ref(lib.items[1]!), ref(null))
    expect(target.editorMode.value).toBe('saved-library')
    expect(target.editsExistingClip.value).toBe(true)
    expect(target.editsSavedClipLibrary.value).toBe(true)
    expect(target.editsSingleTimelineClip.value).toBe(false)
    expect(target.sourceItem.value?.id).toBe('src')
    expect(target.sourceBpm.value).toBe(120)
  })

  it('classifies a timeline clip backed by a saved-clip library item as timeline-linked', () => {
    const lib = useLibraryStore()
    const project = useProjectStore()
    lib.items.push(makeSourceItem())
    lib.items.push(makeSavedClipItem('src'))
    const clip = makeTimelineClip('saved')
    project.clips[clip.id] = clip
    const target = useClipEditorTarget(ref(null), ref(clip.id))
    expect(target.editorMode.value).toBe('timeline-linked')
    expect(target.editsExistingClip.value).toBe(true)
    expect(target.editsSavedClipLibrary.value).toBe(true)
    expect(target.editsSingleTimelineClip.value).toBe(false)
    expect(target.sourceItem.value?.id).toBe('src')
  })

  it('classifies a timeline clip backed by an audio-file library item as timeline-unlinked', () => {
    const lib = useLibraryStore()
    const project = useProjectStore()
    lib.items.push(makeSourceItem())
    const clip = makeTimelineClip('src')
    project.clips[clip.id] = clip
    const target = useClipEditorTarget(ref(null), ref(clip.id))
    expect(target.editorMode.value).toBe('timeline-unlinked')
    expect(target.editsExistingClip.value).toBe(true)
    expect(target.editsSavedClipLibrary.value).toBe(false)
    expect(target.editsSingleTimelineClip.value).toBe(true)
    expect(target.sourceItem.value?.id).toBe('src')
  })

  it('uses the timeline clip name as the title when present, falling back to the library item name', () => {
    const lib = useLibraryStore()
    const project = useProjectStore()
    lib.items.push(makeSourceItem({ name: 'My audio' }))
    const named = makeTimelineClip('src', { id: 'c2', name: 'Hot loop' })
    const unnamed = makeTimelineClip('src', { id: 'c3' })
    project.clips[named.id] = named
    project.clips[unnamed.id] = unnamed

    const namedTarget = useClipEditorTarget(ref(null), ref(named.id))
    expect(namedTarget.titleText.value).toBe('Hot loop')

    const unnamedTarget = useClipEditorTarget(ref(null), ref(unnamed.id))
    expect(unnamedTarget.titleText.value).toBe('My audio')
  })
})

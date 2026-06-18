import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useLibraryItemInfoController } from '@/lib/library/useLibraryItemInfoController'
import { useLibraryStore, type LibraryItem } from '@/stores/libraryStore'
import { useProjectStore, type Clip, type Track } from '@/stores/projectStore'
import { ref } from 'vue'

vi.mock('@/lib/bridgeService', () => ({ send: vi.fn() }))
vi.mock('@/lib/log', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }
}))
vi.mock('@/lib/audioDecode', () => ({ PEAKS_PER_SECOND: 200, decodeAudioToPeaks: vi.fn() }))

let counter = 0

function seedSourceWithArtAndTags(): LibraryItem {
  const library = useLibraryStore()
  const id = library.addItem({
    kind: 'source',
    filePath: `C:\\audio\\song-${++counter}.wav`,
    fileName: `song-${counter}.wav`,
    durationMs: 200_000,
    sampleRate: 44_100,
    channelCount: 2,
    peaks: new Float32Array([0, 1])
  })
  library.setItemMetadata(id, {
    artist: 'The Originals',
    album: 'First Album',
    durationMs: 200_000,
    sampleRate: 44_100,
    channelCount: 2,
    coverArt: { data: new ArrayBuffer(8), mimeType: 'image/jpeg' }
  })
  return library.byId[id]!
}

function seedStem(sourceId: string): LibraryItem {
  const library = useLibraryStore()
  const id = library.addItem({
    kind: 'stem',
    name: 'Drums — song-1.wav',
    filePath: `C:\\stems\\job-${counter}\\drums.wav`,
    fileName: 'drums.wav',
    durationMs: 200_000,
    sampleRate: 44_100,
    channelCount: 2,
    peaks: new Float32Array([0, 1]),
    derivedFrom: { sourceItemId: sourceId, sourceClipId: 'c1', inMs: 0, durationMs: 0 }
  })
  return library.byId[id]!
}

describe('useLibraryItemInfoController stem inheritance', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    counter = 0
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => `uuid-${++counter}`) })
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:cover'),
      revokeObjectURL: vi.fn()
    })
  })

  it('labels a stem item and links it to its source', () => {
    const source = seedSourceWithArtAndTags()
    const stem = seedStem(source.id)
    const dialogEl = ref<HTMLDivElement | null>(null)
    const ctrl = useLibraryItemInfoController(
      { open: true, item: stem, clipId: null },
      () => {},
      dialogEl
    )
    expect(ctrl.isStem.value).toBe(true)
    expect(ctrl.typeLabel.value).toBe('Stem')
    expect(ctrl.sourceItem.value?.id).toBe(source.id)
    expect(ctrl.stemSummary.value).toBe('Drums stem of song-1.wav')
  })

  it('borrows the source cover art and tag metadata for a stem', () => {
    const source = seedSourceWithArtAndTags()
    const stem = seedStem(source.id)
    expect(stem.coverArtUrl).toBeUndefined()
    const dialogEl = ref<HTMLDivElement | null>(null)
    const ctrl = useLibraryItemInfoController(
      { open: true, item: stem, clipId: null },
      () => {},
      dialogEl
    )
    expect(ctrl.coverArtUrl.value).toBe(source.coverArtUrl)
    expect(ctrl.headerArtist.value).toBe('The Originals')
    const rows = Object.fromEntries(ctrl.metadataRows.value)
    expect(rows['Artist']).toBe('The Originals')
    expect(rows['Album']).toBe('First Album')
  })

  it('keeps an audio file showing its own metadata and type', () => {
    const source = seedSourceWithArtAndTags()
    const dialogEl = ref<HTMLDivElement | null>(null)
    const ctrl = useLibraryItemInfoController(
      { open: true, item: source, clipId: null },
      () => {},
      dialogEl
    )
    expect(ctrl.isStem.value).toBe(false)
    expect(ctrl.typeLabel.value).toBe('Audio file')
    expect(ctrl.coverArtUrl.value).toBe(source.coverArtUrl)
  })
})

describe('useLibraryItemInfoController usages', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    counter = 0
  })

  function seedLibraryClip(sourceId: string): LibraryItem {
    const library = useLibraryStore()
    const id = library.addItem({
      kind: 'clip',
      name: 'Chorus',
      filePath: `C:\\audio\\song-1.wav`,
      fileName: 'song-1.wav',
      durationMs: 8_000,
      sampleRate: 44_100,
      channelCount: 2,
      peaks: new Float32Array([0, 1]),
      derivedFrom: { sourceItemId: sourceId, sourceClipId: 'c1', inMs: 0, durationMs: 8_000 }
    })
    return library.byId[id]!
  }

  function placeClip(trackId: string, trackName: string, clipId: string, libraryItemId: string): void {
    const project = useProjectStore()
    project.clips[clipId] = {
      id: clipId,
      trackId,
      libraryItemId,
      filePath: 'C:\\audio\\song-1.wav',
      fileName: 'song-1.wav',
      startMs: 0,
      inMs: 0,
      durationMs: 8_000,
      sampleRate: 44_100,
      channelCount: 2,
      peaks: new Float32Array([0, 1]),
      unresolved: false
    } as Clip
    const existing = project.tracks.find((t) => t.id === trackId)
    if (existing) {
      existing.clipIds.push(clipId)
    } else {
      project.tracks.push({
        id: trackId,
        name: trackName,
        clipIds: [clipId],
        muted: false,
        soloed: false,
        volume: 1,
        colorIndex: 0
      } as Track)
    }
  }

  it('counts the source and its saved clips but never its stems', () => {
    const source = seedSourceWithArtAndTags()
    const stem = seedStem(source.id)
    const libraryClip = seedLibraryClip(source.id)

    placeClip('track-a', 'Track A', 'clip-source', source.id)
    placeClip('track-a', 'Track A', 'clip-saved', libraryClip.id)
    placeClip('track-b', 'Track B', 'clip-stem', stem.id)

    const dialogEl = ref<HTMLDivElement | null>(null)
    const ctrl = useLibraryItemInfoController(
      { open: true, item: source, clipId: null },
      () => {},
      dialogEl
    )

    const rows = ctrl.usages.value
    expect(rows.map((r) => r.trackId)).toEqual(['track-a'])
    expect(rows[0]?.clipCount).toBe(2)
  })
})

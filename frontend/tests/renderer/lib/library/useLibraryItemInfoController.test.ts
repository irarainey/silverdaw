import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useLibraryItemInfoController } from '@/lib/library/useLibraryItemInfoController'
import { useLibraryStore, type LibraryItem } from '@/stores/libraryStore'
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
    kind: 'audio-file',
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

import { describe, expect, it } from 'vitest'
import { libraryItemMatchesFilter } from '@/lib/library/libraryFilter'
import type { LibraryItem } from '@/stores/libraryTypes'

function item(overrides: Partial<LibraryItem>): LibraryItem {
  return {
    id: 'item-1',
    kind: 'source',
    filePath: 'C:\\audio\\track.wav',
    fileName: 'track.wav',
    durationMs: 1_000,
    sampleRate: 44_100,
    channelCount: 2,
    peaks: new Float32Array(),
    playbackFilePath: 'C:\\audio\\track.wav',
    ...overrides
  }
}

describe('libraryItemMatchesFilter', () => {
  const source = item({
    id: 'source-1',
    name: 'Night Drive',
    bpm: 128,
    metadata: { artist: 'The Signals' }
  })
  const savedClip = item({
    id: 'clip-1',
    kind: 'clip',
    name: 'Night Drive Intro',
    derivedFrom: { sourceItemId: source.id, inMs: 0, durationMs: 10_000 }
  })
  const itemsById = { [source.id]: source, [savedClip.id]: savedClip }

  it.each([
    ['display name', source, 'night'],
    ['artist case-insensitively', source, 'SIGNALS'],
    ['integer BPM', source, '128'],
    ['formatted BPM', source, '128.00'],
    ['a saved clip title', savedClip, 'intro'],
    ['an inherited artist', savedClip, 'the signals'],
    ['an inherited BPM', savedClip, '128']
  ])('matches %s', (_description, libraryItem, query) => {
    expect(libraryItemMatchesFilter(libraryItem, query, itemsById)).toBe(true)
  })

  it('does not match unrelated text', () => {
    expect(libraryItemMatchesFilter(source, 'ambient', itemsById)).toBe(false)
  })
})

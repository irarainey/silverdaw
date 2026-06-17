import { describe, expect, it } from 'vitest'
import {
  libraryItemIsSample,
  libraryItemIsSampleAsset,
  libraryItemShowsLinkBadge,
  libraryItemTempoUnverified,
  stemPartLabel,
  STEM_NAME_SEPARATOR
} from '@/stores/libraryItemHelpers'

const sampleSource = { sourceItemId: 'origin-1', inMs: 0, durationMs: 8_000 }

describe('libraryItemIsSampleAsset', () => {
  it('returns false for a nullish item', () => {
    expect(libraryItemIsSampleAsset(undefined)).toBe(false)
    expect(libraryItemIsSampleAsset(null)).toBe(false)
  })

  it('flags both music and simple saved samples (audio-file with a source link)', () => {
    expect(libraryItemIsSampleAsset({ kind: 'audio-file', derivedFrom: sampleSource })).toBe(true)
  })

  it('does NOT flag a music-classified original import', () => {
    // The bug: an ordinary musical import is sampleMode "music" but has no source
    // link, so it must never read as a sample.
    expect(libraryItemIsSampleAsset({ kind: 'audio-file', sampleMode: 'music' })).toBe(false)
    expect(libraryItemIsSampleAsset({ kind: 'audio-file' })).toBe(false)
  })

  it('does not flag stems or saved clips (they have their own kind)', () => {
    expect(libraryItemIsSampleAsset({ kind: 'stem', derivedFrom: sampleSource })).toBe(false)
    expect(libraryItemIsSampleAsset({ kind: 'saved-clip', derivedFrom: sampleSource })).toBe(false)
  })
})

describe('libraryItemShowsLinkBadge', () => {
  it('returns false for an undefined item', () => {
    expect(libraryItemShowsLinkBadge(undefined)).toBe(false)
    expect(libraryItemShowsLinkBadge(null)).toBe(false)
  })

  it('flags saved clips as linked', () => {
    expect(libraryItemShowsLinkBadge({ kind: 'saved-clip' })).toBe(true)
  })

  it('flags saved sample assets (audio-file with a source link) as linked', () => {
    expect(libraryItemShowsLinkBadge({ kind: 'audio-file', derivedFrom: sampleSource })).toBe(true)
  })

  it('does not flag a plain or music-classified imported source file', () => {
    expect(libraryItemShowsLinkBadge({ kind: 'audio-file' })).toBe(false)
    expect(libraryItemShowsLinkBadge({ kind: 'audio-file', sampleMode: 'music' })).toBe(false)
    expect(libraryItemShowsLinkBadge({ kind: 'stem' })).toBe(false)
  })
})

describe('libraryItemIsSample', () => {
  it('treats a low-confidence detection as music, not a sample', () => {
    expect(
      libraryItemIsSample(
        { lowConfidence: true } as Parameters<typeof libraryItemIsSample>[0],
        {}
      )
    ).toBe(false)
  })

  it('honours an explicit sample override regardless of confidence', () => {
    expect(libraryItemIsSample({ sampleMode: 'sample' }, {})).toBe(true)
  })

  it('honours an explicit music override regardless of confidence', () => {
    expect(libraryItemIsSample({ sampleMode: 'music' }, {})).toBe(false)
  })

  it('falls back to the source override for a derived item but ignores source confidence', () => {
    const byId = {
      src: { id: 'src', kind: 'audio-file', sampleMode: 'sample', lowConfidence: false }
    } as never
    expect(
      libraryItemIsSample({ derivedFrom: { sourceItemId: 'src' } as never }, byId)
    ).toBe(true)
    const byIdLowConf = {
      src: { id: 'src', kind: 'audio-file', lowConfidence: true }
    } as never
    expect(
      libraryItemIsSample({ derivedFrom: { sourceItemId: 'src' } as never }, byIdLowConf)
    ).toBe(false)
  })
})

describe('libraryItemTempoUnverified', () => {
  it('flags a low-confidence item with no explicit classification', () => {
    expect(libraryItemTempoUnverified({ lowConfidence: true }, {})).toBe(true)
  })

  it('is cleared once the user sets any explicit classification', () => {
    expect(libraryItemTempoUnverified({ sampleMode: 'music', lowConfidence: true }, {})).toBe(false)
    expect(libraryItemTempoUnverified({ sampleMode: 'sample', lowConfidence: true }, {})).toBe(false)
  })

  it('is false for a confident item', () => {
    expect(libraryItemTempoUnverified({ lowConfidence: false }, {})).toBe(false)
  })

  it('inherits the unverified state from an un-overridden source', () => {
    const byId = {
      src: { id: 'src', kind: 'audio-file', lowConfidence: true }
    } as never
    expect(
      libraryItemTempoUnverified({ derivedFrom: { sourceItemId: 'src' } as never }, byId)
    ).toBe(true)
  })
})

describe('stemPartLabel', () => {
  it('extracts the part before the separator from a composite stem name', () => {
    expect(stemPartLabel({ name: `Drums ${STEM_NAME_SEPARATOR} Long Train` })).toBe('Drums')
    expect(stemPartLabel({ name: `Vocals ${STEM_NAME_SEPARATOR} A — B` })).toBe('Vocals')
  })

  it('falls back to the whole name when there is no separator (e.g. renamed)', () => {
    expect(stemPartLabel({ name: 'My Custom Stem' })).toBe('My Custom Stem')
  })

  it('returns "Stem" for an empty or missing name', () => {
    expect(stemPartLabel({ name: '   ' })).toBe('Stem')
    expect(stemPartLabel({})).toBe('Stem')
  })
})

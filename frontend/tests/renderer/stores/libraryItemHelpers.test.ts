import { describe, expect, it } from 'vitest'
import {
  libraryItemIsSample,
  libraryItemTempoUnverified,
  stemPartLabel,
  STEM_NAME_SEPARATOR
} from '@/stores/libraryItemHelpers'

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

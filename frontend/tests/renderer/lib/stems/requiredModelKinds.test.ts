import { describe, expect, it } from 'vitest'
import { requiredModelKinds } from '@/lib/stems/stemSeparationFlow'

describe('requiredModelKinds', () => {
  it('returns only the backup when the user forces it, regardless of selection', () => {
    expect(requiredModelKinds(['vocals', 'drums', 'bass', 'other'], true)).toEqual(['htdemucs'])
    expect(requiredModelKinds(['vocals'], true)).toEqual(['htdemucs'])
  })

  it('downloads both RoFormer packs together for the default four-stem set', () => {
    expect(requiredModelKinds(['vocals', 'drums', 'bass', 'other'], false)).toEqual([
      'vocalPack',
      'rhythmPack'
    ])
  })

  it('still fetches both packs together for a pack-covered partial selection', () => {
    expect(requiredModelKinds(['vocals'], false)).toEqual(['vocalPack', 'rhythmPack'])
    expect(requiredModelKinds(['drums', 'bass'], false)).toEqual(['vocalPack', 'rhythmPack'])
  })

  it('adds the backup when "other" is requested without the full four-stem set', () => {
    expect(requiredModelKinds(['other'], false)).toEqual(['vocalPack', 'rhythmPack', 'htdemucs'])
    expect(requiredModelKinds(['drums', 'bass', 'other'], false)).toEqual([
      'vocalPack',
      'rhythmPack',
      'htdemucs'
    ])
  })

  it('rides the residual for "other" when all four stems are produced (no backup)', () => {
    expect(requiredModelKinds(['vocals', 'drums', 'bass', 'other'], false)).not.toContain(
      'htdemucs'
    )
  })
})

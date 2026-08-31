import { describe, expect, it } from 'vitest'
import {
  describeTempoCorrection,
  describeTempoCorrectionCaveats
} from '@/lib/library/tempoCorrectionReport'
import type { TempoCorrectionAppliedPayload } from '@shared/bridge-protocol'

type Applied = Extract<TempoCorrectionAppliedPayload, { ok: true }>

function applied(overrides: Partial<Applied> = {}): Applied {
  return {
    ok: true,
    itemId: 'src',
    ownerItemId: 'src',
    ownerReason: 'ownBpm',
    appliedBpm: 102.76,
    previousBpm: 98.8,
    musicalLengthDiscarded: false,
    clipsUpdated: 0,
    clipsPinnedExcluded: 0,
    clipsUnwarpedExcluded: 0,
    transitionsRemoved: 0,
    clipsPastProjectLength: 0,
    ...overrides
  }
}

describe('describeTempoCorrection', () => {
  it('states both tempi to two decimals, because the error being fixed is a few percent', () => {
    // Rounding 98.80 and 102.76 to whole numbers would hide exactly the difference
    // the user is correcting, so the summary must never do it.
    const text = describeTempoCorrection(applied(), 'Song')

    expect(text).toContain('"Song"')
    expect(text).toContain('98.80')
    expect(text).toContain('102.76')
  })

  // Seeding the project tempo from the first musical clip is a one-time convenience, so
  // correcting a file leaves the project alone (ADR 0027). The summary must not imply
  // otherwise, or the user will go looking for bar lines that never moved.
  it('says nothing about the project tempo, which a correction never touches', () => {
    const text = describeTempoCorrection(applied(), 'Song')

    expect(text).not.toContain('project tempo')
    expect(text).not.toContain('bar lines')
    expect(text).not.toContain('aligned')
  })

  it('names the ancestor when the correction landed on an inherited tempo', () => {
    // Writing to an item the user did not select is the surprise the report exists to
    // prevent, so the ancestor must be named alongside what was selected.
    const text = describeTempoCorrection(
      applied({ ownerItemId: 'src', ownerReason: 'inheritedBpm' }),
      'Drums',
      'Song'
    )

    expect(text).toContain('"Song", which "Drums" was made from,')
  })

  it('does not name an ancestor when the item owns its own tempo', () => {
    const text = describeTempoCorrection(applied({ ownerReason: 'ownBpm' }), 'Drums', 'Song')

    expect(text).toContain('"Drums"')
    expect(text).not.toContain('was made from')
  })

  it('reports re-warped clips, and stays silent when there were none', () => {
    expect(describeTempoCorrection(applied({ clipsUpdated: 1 }), 'Song')).toContain(
      '1 clip re-warped'
    )
    expect(describeTempoCorrection(applied({ clipsUpdated: 3 }), 'Song')).toContain(
      '3 clips re-warped'
    )
    expect(describeTempoCorrection(applied(), 'Song')).not.toContain('re-warped')
  })
})

describe('describeTempoCorrectionCaveats', () => {
  it('returns nothing when the correction had no side effects to report', () => {
    expect(describeTempoCorrectionCaveats(applied())).toEqual([])
  })

  it('reports a discarded measured bar length', () => {
    const caveats = describeTempoCorrectionCaveats(applied({ musicalLengthDiscarded: true }))

    expect(caveats.some((c) => c.includes('measured bar length'))).toBe(true)
  })

  it('describes excluded clips as the user\'s own earlier choice, not a failure', () => {
    // A pinned clip was pinned deliberately; wording it as an error would tell the user
    // something went wrong when the command did exactly what they had already asked for.
    const caveats = describeTempoCorrectionCaveats(
      applied({ clipsPinnedExcluded: 1, clipsUnwarpedExcluded: 2 })
    )

    const line = caveats.find((c) => c.includes('left as they are'))
    expect(line).toBeDefined()
    expect(line).toContain('3 clips were left as they are')
    expect(line).toContain('1 is pinned')
    expect(line).toContain('2 have warp off')
    expect(line).not.toMatch(/fail|error/i)
  })

  it('reads as English when only one clip, or only one reason, was excluded', () => {
    // Regression: every case went through the both-reasons wording, producing
    // "1 clip was left as they are because 1 is pinned" — a plural pronoun for a single
    // clip, and a count repeated as though it were a second, unrelated number.
    const onePinned = describeTempoCorrectionCaveats(applied({ clipsPinnedExcluded: 1 }))
    expect(onePinned).toContain('1 clip was left as it is because it is pinned.')

    const manyPinned = describeTempoCorrectionCaveats(applied({ clipsPinnedExcluded: 3 }))
    expect(manyPinned).toContain('3 clips were left as they are because they are pinned.')

    const oneUnwarped = describeTempoCorrectionCaveats(applied({ clipsUnwarpedExcluded: 1 }))
    expect(oneUnwarped).toContain('1 clip was left as it is because it has warp off.')

    const manyUnwarped = describeTempoCorrectionCaveats(applied({ clipsUnwarpedExcluded: 2 }))
    expect(manyUnwarped).toContain('2 clips were left as they are because they have warp off.')
  })

  it('reports removed transitions and clips pushed past the project length', () => {
    const caveats = describeTempoCorrectionCaveats(
      applied({ transitionsRemoved: 1, clipsPastProjectLength: 2 })
    )

    expect(caveats.some((c) => c.includes('1 transition no longer had an overlap'))).toBe(true)
    expect(caveats.some((c) => c.includes('2 clips now extend past the project length'))).toBe(
      true
    )
    // An actionable consequence must say what to do next.
    expect(caveats.some((c) => c.includes('Project Properties'))).toBe(true)
  })
})

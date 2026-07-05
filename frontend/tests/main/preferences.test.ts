import { describe, expect, it, vi } from 'vitest'

// preferences.ts imports `electron` at module load; stub it so the pure
// validation helpers can be unit-tested in the node environment.
vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getName: () => 'silverdaw' } }))

import { sanitiseKeepAwakeByDevice, sanitiseStemModelDir, sanitiseStemPrefs, sanitiseUiPrefs, type StemPrefs, type UiPrefs } from '@main/preferences'

const base: UiPrefs = {
  trackHeaderWidth: 175,
  libraryPanelHeight: 180,
  followPlayback: true,
  showLibraryTileImages: true,
  matchProjectTempoOnDrop: true,
  seedProjectTempoFromFirstClip: true,
  cleanupProjectFiles: false,
  defaultProjectSampleRate: 44100,
  skipButtonTarget: 'timelineEnds',
  waveformDisplayMode: 'summary',
  libraryPanelCollapsed: false
}

describe('sanitiseUiPrefs', () => {
  it('returns the base unchanged for a non-object partial', () => {
    expect(sanitiseUiPrefs(undefined, base)).toEqual(base)
    expect(sanitiseUiPrefs(null, base)).toEqual(base)
    expect(sanitiseUiPrefs(42, base)).toEqual(base)
  })

  it('keeps base values for missing fields (partial merge)', () => {
    const result = sanitiseUiPrefs({ followPlayback: false }, base)
    expect(result.followPlayback).toBe(false)
    expect(result.trackHeaderWidth).toBe(175)
    expect(result.defaultProjectSampleRate).toBe(44100)
  })

  it('clamps trackHeaderWidth into range and rounds', () => {
    expect(sanitiseUiPrefs({ trackHeaderWidth: 10 }, base).trackHeaderWidth).toBe(120)
    expect(sanitiseUiPrefs({ trackHeaderWidth: 9999 }, base).trackHeaderWidth).toBe(480)
    expect(sanitiseUiPrefs({ trackHeaderWidth: 200.7 }, base).trackHeaderWidth).toBe(201)
  })

  it('clamps libraryPanelHeight into range', () => {
    expect(sanitiseUiPrefs({ libraryPanelHeight: 0 }, base).libraryPanelHeight).toBe(80)
    expect(sanitiseUiPrefs({ libraryPanelHeight: 100000 }, base).libraryPanelHeight).toBe(2000)
  })

  it('falls back to base for non-numeric / non-finite numeric fields', () => {
    expect(sanitiseUiPrefs({ trackHeaderWidth: 'big' }, base).trackHeaderWidth).toBe(175)
    expect(sanitiseUiPrefs({ libraryPanelHeight: Number.NaN }, base).libraryPanelHeight).toBe(180)
  })

  it('falls back to base for wrong-typed booleans', () => {
    expect(sanitiseUiPrefs({ followPlayback: 'yes' }, base).followPlayback).toBe(true)
    expect(sanitiseUiPrefs({ libraryPanelCollapsed: 1 }, base).libraryPanelCollapsed).toBe(false)
  })

  it('only accepts whitelisted sample rates', () => {
    expect(sanitiseUiPrefs({ defaultProjectSampleRate: 48000 }, base).defaultProjectSampleRate).toBe(48000)
    expect(sanitiseUiPrefs({ defaultProjectSampleRate: 96000 }, base).defaultProjectSampleRate).toBe(44100)
    expect(sanitiseUiPrefs({ defaultProjectSampleRate: '48000' }, base).defaultProjectSampleRate).toBe(44100)
  })

  it('only accepts valid enum values', () => {
    expect(sanitiseUiPrefs({ skipButtonTarget: 'markers' }, base).skipButtonTarget).toBe('markers')
    expect(sanitiseUiPrefs({ skipButtonTarget: 'bogus' }, base).skipButtonTarget).toBe('timelineEnds')
    expect(sanitiseUiPrefs({ waveformDisplayMode: 'stereo' }, base).waveformDisplayMode).toBe('stereo')
    expect(sanitiseUiPrefs({ waveformDisplayMode: 'bogus' }, base).waveformDisplayMode).toBe('summary')
  })

  it('ignores unknown extra keys', () => {
    const result = sanitiseUiPrefs({ hax: true, __proto__: { polluted: true } }, base)
    expect(result).toEqual(base)
    expect((result as unknown as Record<string, unknown>).hax).toBeUndefined()
  })
})

describe('sanitiseStemPrefs', () => {
  const stemBase: StemPrefs = {
    useGpu: false,
    quality: 'balanced',
    useBackupModel: false,
    enhanceVocals: false,
    vocalEnhanceStrength: 'medium',
    enhanceDrums: false,
    drumEnhanceStrength: 'medium',
    enhanceBass: false,
    bassEnhanceStrength: 'medium',
    enhanceOther: false,
    otherEnhanceStrength: 'medium'
  }

  it('keeps the base for a non-object partial', () => {
    expect(sanitiseStemPrefs(undefined, stemBase)).toEqual(stemBase)
    expect(sanitiseStemPrefs(42, stemBase)).toEqual(stemBase)
  })

  it('accepts a valid boolean and falls back for the wrong type', () => {
    expect(sanitiseStemPrefs({ useGpu: true }, stemBase).useGpu).toBe(true)
    expect(sanitiseStemPrefs({ useGpu: 'yes' }, stemBase).useGpu).toBe(false)
    expect(
      sanitiseStemPrefs({ useGpu: true }, { ...stemBase, useGpu: true, quality: 'best' }).useGpu
    ).toBe(true)
  })

  it('accepts a valid quality preset and falls back for an unknown value', () => {
    expect(sanitiseStemPrefs({ quality: 'best' }, stemBase).quality).toBe('best')
    expect(sanitiseStemPrefs({ quality: 'fast' }, stemBase).quality).toBe('fast')
    expect(sanitiseStemPrefs({ quality: 'ultra' }, stemBase).quality).toBe('balanced')
    expect(
      sanitiseStemPrefs({ quality: 99 }, { ...stemBase, quality: 'best' }).quality
    ).toBe('best')
  })

  it('accepts vocal-cleanup settings and falls back for wrong types', () => {
    expect(sanitiseStemPrefs({ enhanceVocals: true }, stemBase).enhanceVocals).toBe(true)
    expect(sanitiseStemPrefs({ enhanceVocals: 'yes' }, stemBase).enhanceVocals).toBe(false)
    expect(
      sanitiseStemPrefs({ vocalEnhanceStrength: 'strong' }, stemBase).vocalEnhanceStrength
    ).toBe('strong')
    expect(
      sanitiseStemPrefs({ vocalEnhanceStrength: 'ultra' }, stemBase).vocalEnhanceStrength
    ).toBe('medium')
  })

  it('accepts drum-cleanup settings and falls back for wrong types', () => {
    expect(sanitiseStemPrefs({ enhanceDrums: true }, stemBase).enhanceDrums).toBe(true)
    expect(sanitiseStemPrefs({ enhanceDrums: 'yes' }, stemBase).enhanceDrums).toBe(false)
    expect(
      sanitiseStemPrefs({ drumEnhanceStrength: 'strong' }, stemBase).drumEnhanceStrength
    ).toBe('strong')
    expect(
      sanitiseStemPrefs({ drumEnhanceStrength: 'ultra' }, stemBase).drumEnhanceStrength
    ).toBe('medium')
  })

  it('accepts bass-cleanup settings and falls back for wrong types', () => {
    expect(sanitiseStemPrefs({ enhanceBass: true }, stemBase).enhanceBass).toBe(true)
    expect(sanitiseStemPrefs({ enhanceBass: 'yes' }, stemBase).enhanceBass).toBe(false)
    expect(
      sanitiseStemPrefs({ bassEnhanceStrength: 'strong' }, stemBase).bassEnhanceStrength
    ).toBe('strong')
    expect(
      sanitiseStemPrefs({ bassEnhanceStrength: 'ultra' }, stemBase).bassEnhanceStrength
    ).toBe('medium')
  })

  it('accepts other-cleanup settings and falls back for wrong types', () => {
    expect(sanitiseStemPrefs({ enhanceOther: true }, stemBase).enhanceOther).toBe(true)
    expect(sanitiseStemPrefs({ enhanceOther: 'yes' }, stemBase).enhanceOther).toBe(false)
    expect(
      sanitiseStemPrefs({ otherEnhanceStrength: 'strong' }, stemBase).otherEnhanceStrength
    ).toBe('strong')
    expect(
      sanitiseStemPrefs({ otherEnhanceStrength: 'ultra' }, stemBase).otherEnhanceStrength
    ).toBe('medium')
  })
})

describe('sanitiseStemModelDir', () => {
  it('returns a trimmed non-empty string', () => {
    expect(sanitiseStemModelDir('  C:/models/htdemucs  ')).toBe('C:/models/htdemucs')
  })

  it('returns undefined for empty / non-string input', () => {
    expect(sanitiseStemModelDir('')).toBeUndefined()
    expect(sanitiseStemModelDir('   ')).toBeUndefined()
    expect(sanitiseStemModelDir(undefined)).toBeUndefined()
    expect(sanitiseStemModelDir(123)).toBeUndefined()
  })
})

describe('sanitiseKeepAwakeByDevice', () => {
  it('keeps only devices explicitly enabled (value === true), keyed by a non-empty name', () => {
    expect(
      sanitiseKeepAwakeByDevice({ 'USB DAC': true, 'Speakers (Realtek)': false })
    ).toEqual({ 'USB DAC': true })
  })

  it('drops false entries (off is the default) and trims device names', () => {
    expect(sanitiseKeepAwakeByDevice({ '  USB DAC  ': true, Onboard: false })).toEqual({
      'USB DAC': true
    })
  })

  it('drops empty names and wrong-typed values, and tolerates non-object input', () => {
    expect(sanitiseKeepAwakeByDevice({ '': true, Good: 'on', Fine: true })).toEqual({
      Fine: true
    })
    expect(sanitiseKeepAwakeByDevice(undefined)).toEqual({})
    expect(sanitiseKeepAwakeByDevice(42)).toEqual({})
    expect(sanitiseKeepAwakeByDevice(null)).toEqual({})
  })
})

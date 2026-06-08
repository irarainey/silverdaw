import { describe, expect, it, vi } from 'vitest'

// preferences.ts imports `electron` at module load; stub it so the pure
// validation helpers can be unit-tested in the node environment.
vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getName: () => 'silverdaw' } }))

import { sanitiseUiPrefs, type UiPrefs } from '@main/preferences'

const base: UiPrefs = {
  trackHeaderWidth: 175,
  libraryPanelHeight: 180,
  followPlayback: true,
  showLibraryTileImages: true,
  matchProjectTempoOnDrop: true,
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

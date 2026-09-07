import { describe, expect, it } from 'vitest'
import {
  createLiveWaveform,
  liveBeatFractions,
  pushLiveColumn,
  readFittedColumns,
  readLiveColumns,
  resetLiveWaveform
} from '@/lib/recording/liveWaveform'

describe('live waveform buffer', () => {
  it('reads back the columns it was given, oldest first', () => {
    const buffer = createLiveWaveform(8)
    pushLiveColumn(buffer, 0.1)
    pushLiveColumn(buffer, 0.2)
    pushLiveColumn(buffer, 0.3)

    expect(readLiveColumns(buffer, 8)).toEqual([
      expect.closeTo(0.1, 5),
      expect.closeTo(0.2, 5),
      expect.closeTo(0.3, 5)
    ])
  })

  it('scrolls once full rather than growing without limit', () => {
    const buffer = createLiveWaveform(3)
    for (const value of [0.1, 0.2, 0.3, 0.4]) pushLiveColumn(buffer, value)

    // The oldest column has been dropped, and the view still reads left to right.
    expect(readLiveColumns(buffer, 3)).toEqual([
      expect.closeTo(0.2, 5),
      expect.closeTo(0.3, 5),
      expect.closeTo(0.4, 5)
    ])
    expect(buffer.count).toBe(4)
  })

  it('returns only the most recent columns when fewer are asked for', () => {
    const buffer = createLiveWaveform(8)
    for (const value of [0.1, 0.2, 0.3, 0.4]) pushLiveColumn(buffer, value)

    expect(readLiveColumns(buffer, 2)).toEqual([expect.closeTo(0.3, 5), expect.closeTo(0.4, 5)])
  })

  it('clamps magnitudes so a hot input cannot draw outside the view', () => {
    const buffer = createLiveWaveform(4)
    pushLiveColumn(buffer, 3)
    pushLiveColumn(buffer, -1)

    expect(readLiveColumns(buffer, 4)).toEqual([1, 0])
  })

  it('empties on reset, so a new take never shows the last one', () => {
    const buffer = createLiveWaveform(4)
    pushLiveColumn(buffer, 0.5)
    resetLiveWaveform(buffer)

    expect(readLiveColumns(buffer, 4)).toEqual([])
    expect(buffer.count).toBe(0)
  })
})

describe('fitted live waveform', () => {
  it('shows the whole take while it still fits the view', () => {
    const buffer = createLiveWaveform(16)
    for (const value of [0.1, 0.2, 0.3]) pushLiveColumn(buffer, value)

    expect(readFittedColumns(buffer, 8)).toEqual([
      expect.closeTo(0.1, 5),
      expect.closeTo(0.2, 5),
      expect.closeTo(0.3, 5)
    ])
  })

  it('summarises a take longer than the view instead of dropping its start', () => {
    const buffer = createLiveWaveform(16)
    for (const value of [0.1, 0.9, 0.2, 0.8]) pushLiveColumn(buffer, value)

    // Two columns for four: each takes the loudest of the pair it covers, and the
    // first column of the take is still on screen.
    expect(readFittedColumns(buffer, 2)).toEqual([
      expect.closeTo(0.9, 5),
      expect.closeTo(0.8, 5)
    ])
  })

  it('fills every column it was asked for', () => {
    const buffer = createLiveWaveform(64)
    for (let index = 0; index < 50; index += 1) pushLiveColumn(buffer, index / 50)

    expect(readFittedColumns(buffer, 7)).toHaveLength(7)
  })

  it('draws nothing at all before the first column arrives', () => {
    expect(readFittedColumns(createLiveWaveform(8), 4)).toEqual([])
  })
})

describe('live beat grid', () => {
  it('places beats across the span, measured from where the view starts', () => {
    // 120 BPM is a 500 ms beat; four seconds of view ends exactly on a beat.
    const lines = liveBeatFractions(0, 4000, 120, 4)

    expect(lines).toHaveLength(9)
    expect(lines[0]).toEqual({ fraction: 0, bar: true })
    expect(lines[lines.length - 1]).toEqual({ fraction: 1, bar: true })
    expect(lines[1]).toEqual({ fraction: expect.closeTo(0.125, 5), bar: false })
  })

  it('marks bar lines every four beats', () => {
    const bars = liveBeatFractions(0, 4000, 120, 4).filter((line) => line.bar)
    expect(bars).toHaveLength(3)
  })

  // A take started from the playhead rarely begins on a beat, and the round trip moves
  // the left edge again. Numbering beats from the view would draw the grid under the
  // wrong audio and call the wrong beats bar lines.
  it('keeps the grid on the project beats when the view starts off them', () => {
    // Half a beat past beat four, so the next whole beat is an eighth of the way in.
    const lines = liveBeatFractions(2250, 4000, 120, 4)

    expect(lines[0]).toEqual({ fraction: expect.closeTo(0.0625, 5), bar: false })
    const bars = lines.filter((line) => line.bar)
    expect(bars).toHaveLength(2)
    expect(bars[0]?.fraction).toBeCloseTo(0.4375, 5)
  })

  it('draws no beats before the start of the timeline', () => {
    const lines = liveBeatFractions(-200, 4000, 120, 4)
    expect(lines[0]).toEqual({ fraction: expect.closeTo(0.05, 5), bar: true })
    expect(lines.every((line) => line.fraction >= 0)).toBe(true)
  })

  it('gives up rather than drawing a grid too fine to read', () => {
    expect(liveBeatFractions(0, 600_000, 240, 4)).toEqual([])
  })

  it('draws nothing without a usable tempo or span', () => {
    expect(liveBeatFractions(0, 0, 120, 4)).toEqual([])
    expect(liveBeatFractions(0, 4000, 0, 4)).toEqual([])
    expect(liveBeatFractions(0, 4000, 120, 0)).toEqual([])
  })
})

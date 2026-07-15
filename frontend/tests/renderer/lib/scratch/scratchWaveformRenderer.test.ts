import { describe, expect, it, vi, beforeAll } from 'vitest'
import { renderScratchWaveform, type ScratchWaveformRenderOptions } from '@/lib/scratch/scratchWaveformRenderer'

beforeAll(() => {
  // This module reads window.devicePixelRatio (always present in the real
  // renderer/Electron context); stub it for the default node test environment.
  vi.stubGlobal('window', { devicePixelRatio: 1 })
})

function makeMockCtx(): CanvasRenderingContext2D {
  return {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    globalAlpha: 1,
    fillRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fillText: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn()
  } as unknown as CanvasRenderingContext2D
}

function baseOptions(overrides: Partial<ScratchWaveformRenderOptions> = {}): ScratchWaveformRenderOptions {
  return {
    width: 400,
    height: 195,
    viewStartMs: 0,
    viewDurationMs: 2000,
    peaks: new Float32Array(),
    peaksPerSecond: 0,
    channelPeaks: [],
    useStereoLanes: false,
    channelPeaksPerSecond: 0,
    sourceDurationMs: 2000,
    preparedDurationMs: 2000,
    inMs: 0,
    reversed: false,
    sourceBpm: undefined,
    beatAnchorSec: undefined,
    positionMs: 0,
    ...overrides
  }
}

describe('renderScratchWaveform', () => {
  it('does nothing for a zero-size canvas', () => {
    const ctx = makeMockCtx()
    renderScratchWaveform(ctx, baseOptions({ width: 0, height: 0 }))
    expect(ctx.fillRect).not.toHaveBeenCalled()
  })

  it('paints the background, ruler, and baseline when there are no peaks yet', () => {
    const ctx = makeMockCtx()
    renderScratchWaveform(ctx, baseOptions())
    // Background + ruler background fills, at minimum.
    expect(ctx.fillRect).toHaveBeenCalledTimes(2)
    expect(ctx.stroke).toHaveBeenCalled()
  })

  it('draws mono waveform columns when peaks are present', () => {
    const ctx = makeMockCtx()
    const peaks = new Float32Array([-0.5, 0.5, -0.6, 0.6])
    renderScratchWaveform(
      ctx,
      baseOptions({ peaks, peaksPerSecond: 2, sourceDurationMs: 1000, preparedDurationMs: 1000, viewDurationMs: 1000 })
    )
    // Background/ruler fills plus per-column waveform fills.
    expect((ctx.fillRect as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(2)
  })

  it('draws two lanes when stereo display is requested and both channels are available', () => {
    const monoCtx = makeMockCtx()
    const stereoCtx = makeMockCtx()
    const options = baseOptions({
      peaks: new Float32Array([-0.5, 0.5, -0.5, 0.5]),
      peaksPerSecond: 2,
      channelPeaks: [new Float32Array([-0.5, 0.5]), new Float32Array([-0.5, 0.5])],
      channelPeaksPerSecond: 2,
      sourceDurationMs: 1000,
      preparedDurationMs: 1000,
      viewDurationMs: 1000
    })
    renderScratchWaveform(monoCtx, options)
    renderScratchWaveform(stereoCtx, { ...options, useStereoLanes: true })

    // Two lanes draw at least as many baseline/waveform fills as one mono lane.
    const monoCalls = (monoCtx.fillRect as ReturnType<typeof vi.fn>).mock.calls.length
    const stereoCalls = (stereoCtx.fillRect as ReturnType<typeof vi.fn>).mock.calls.length
    expect(stereoCalls).toBeGreaterThanOrEqual(monoCalls)
  })

  it('draws the playhead marker only when it falls within the visible window', () => {
    const insideCtx = makeMockCtx()
    renderScratchWaveform(insideCtx, baseOptions({ positionMs: 1000 }))
    expect(insideCtx.fill).toHaveBeenCalled()

    const outsideCtx = makeMockCtx()
    renderScratchWaveform(outsideCtx, baseOptions({ positionMs: 10_000 }))
    expect(outsideCtx.fill).not.toHaveBeenCalled()
  })

  it('skips beat markers when no source bpm/anchor is known', () => {
    const ctx = makeMockCtx()
    renderScratchWaveform(ctx, baseOptions({ sourceBpm: undefined, beatAnchorSec: undefined }))
    // Should not throw and should still paint the baseline/ruler.
    expect(ctx.fillRect).toHaveBeenCalled()
  })
})

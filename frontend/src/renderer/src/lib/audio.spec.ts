import { describe, expect, it } from 'vitest'
import { detectMusicalKey, effectivePeaksPerSecond } from '@/lib/audio'

describe('audio peak helpers', () => {
  it('returns the actual peak rate after integer sample bucketing', () => {
    expect(effectivePeaksPerSecond(44_100, 500)).toBeCloseTo(44_100 / 88, 6)
  })

  it('matches the requested rate when the sample rate divides evenly', () => {
    expect(effectivePeaksPerSecond(48_000, 500)).toBe(500)
  })

  it('clamps to one sample per peak for very high requested rates', () => {
    expect(effectivePeaksPerSecond(8_000, 20_000)).toBe(8_000)
  })
})

describe('audio key detection', () => {
  it('returns the best key for moderately close candidates', () => {
    const sampleRate = 11_025
    const seconds = 8
    const samples = new Float32Array(sampleRate * seconds)
    const notes = [
      { midi: 60, gain: 0.8 },
      { midi: 63, gain: 0.65 },
      { midi: 67, gain: 0.7 },
      { midi: 61, gain: 0.08 }
    ]
    for (let i = 0; i < samples.length; i++) {
      let value = 0
      for (const note of notes) {
        const freq = 440 * 2 ** ((note.midi - 69) / 12)
        value += Math.sin((2 * Math.PI * freq * i) / sampleRate) * note.gain
      }
      samples[i] = value / notes.length
    }

    expect(detectMusicalKey([samples], sampleRate)).toBe('C minor')
  })
})

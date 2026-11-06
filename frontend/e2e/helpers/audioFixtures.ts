// Generates the audio a journey imports.
//
// The fixtures are synthesised rather than committed so the repository stays
// free of binary blobs, every run gets a known-exact signal (duration, rate,
// channel count, amplitude), and a spec can ask for whatever shape it needs —
// including deliberately awkward ones such as an off-device sample rate.
//
// 16-bit PCM WAV is the lowest-common-denominator format: it decodes without a
// codec, so an import journey exercises Silverdaw's own path rather than a
// third-party decoder's.

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeTrackedTempDir } from './tempDirs.ts'

export interface ToneOptions {
  /** File name including the `.wav` extension. */
  fileName?: string
  seconds?: number
  sampleRate?: number
  frequencyHz?: number
  channels?: number
  /**
   * Peak amplitude as a fraction of full scale, clamped to 0–1. Zero writes
   * digital silence, which a journey wants when it must drive the audio device
   * without making a noise on the machine running the suite.
   */
  amplitude?: number
  /** Optional second harmonic, amplitude modulation and edge fades. */
  harmonicGain?: number
  modulationHz?: number
  fadeMs?: number
}

const BYTES_PER_SAMPLE = 2
const FULL_SCALE = 0x7fff

/**
 * Writes a sine-tone WAV into a fresh temporary directory and returns its path.
 * A short, quiet tone keeps import, peak generation, and analysis fast while
 * still being real audio the engine must decode and summarise.
 */
export function createToneWav(options: ToneOptions = {}): string {
  const dir = makeTrackedTempDir('audio')
  const filePath = join(dir, options.fileName ?? 'tone.wav')
  writeToneWav(filePath, options)
  return filePath
}

/** Writes the same deterministic signal into a caller-owned fixture directory. */
export function writeToneWav(filePath: string, options: ToneOptions = {}): void {
  const {
    seconds = 2,
    sampleRate = 44_100,
    frequencyHz = 440,
    channels = 2,
    amplitude = 0.5,
    harmonicGain = 0,
    modulationHz = 0,
    fadeMs = 0
  } = options

  const peak = Math.min(Math.max(amplitude, 0), 1)

  const frameCount = Math.floor(seconds * sampleRate)
  const harmonic = Math.min(Math.max(harmonicGain, 0), 1)
  const fadeFrames = Math.max(0, (fadeMs * sampleRate) / 1000)
  const dataBytes = frameCount * channels * BYTES_PER_SAMPLE
  const buffer = Buffer.alloc(44 + dataBytes)

  // RIFF/WAVE header.
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataBytes, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16) // PCM chunk size
  buffer.writeUInt16LE(1, 20) // PCM format
  buffer.writeUInt16LE(channels, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * channels * BYTES_PER_SAMPLE, 28) // byte rate
  buffer.writeUInt16LE(channels * BYTES_PER_SAMPLE, 32) // block align
  buffer.writeUInt16LE(8 * BYTES_PER_SAMPLE, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataBytes, 40)

  // The default leaves headroom, so a journey that adds gain cannot clip and
  // turn an assertion about levels into a false negative.
  for (let frame = 0; frame < frameCount; frame++) {
    const phase = (2 * Math.PI * frequencyHz * frame) / sampleRate
    const carrier =
      harmonic > 0
        ? (Math.sin(phase) + harmonic * Math.sin(2 * phase)) / (1 + harmonic)
        : Math.sin(phase)
    const modulation =
      modulationHz > 0
        ? 0.55 + 0.45 * Math.cos((2 * Math.PI * modulationHz * frame) / sampleRate)
        : 1
    const fade =
      fadeFrames > 0 ? Math.min(1, frame / fadeFrames, (frameCount - 1 - frame) / fadeFrames) : 1
    const value = Math.round(carrier * modulation * fade * FULL_SCALE * peak)
    for (let channel = 0; channel < channels; channel++) {
      buffer.writeInt16LE(value, 44 + (frame * channels + channel) * BYTES_PER_SAMPLE)
    }
  }

  writeFileSync(filePath, buffer)
}

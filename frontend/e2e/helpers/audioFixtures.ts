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

import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export interface ToneOptions {
  /** File name including the `.wav` extension. */
  fileName?: string
  seconds?: number
  sampleRate?: number
  frequencyHz?: number
  channels?: number
}

const BYTES_PER_SAMPLE = 2
const FULL_SCALE = 0x7fff

/**
 * Writes a sine-tone WAV into a fresh temporary directory and returns its path.
 * A short, quiet tone keeps import, peak generation, and analysis fast while
 * still being real audio the engine must decode and summarise.
 */
export function createToneWav(options: ToneOptions = {}): string {
  const {
    fileName = 'tone.wav',
    seconds = 2,
    sampleRate = 44_100,
    frequencyHz = 440,
    channels = 2
  } = options

  const frameCount = Math.floor(seconds * sampleRate)
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

  // Half scale leaves headroom, so a journey that adds gain cannot clip and
  // turn an assertion about levels into a false negative.
  for (let frame = 0; frame < frameCount; frame++) {
    const value = Math.round(Math.sin((2 * Math.PI * frequencyHz * frame) / sampleRate) * FULL_SCALE * 0.5)
    for (let channel = 0; channel < channels; channel++) {
      buffer.writeInt16LE(value, 44 + (frame * channels + channel) * BYTES_PER_SAMPLE)
    }
  }

  const dir = mkdtempSync(join(tmpdir(), 'silverdaw-e2e-audio-'))
  const filePath = join(dir, fileName)
  writeFileSync(filePath, buffer)
  return filePath
}

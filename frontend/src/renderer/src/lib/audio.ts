// Audio decoding and peak-array generation for waveform rendering.
//
// Until the JUCE backend is wired up, the renderer decodes audio via the
// Web Audio API and computes peaks itself. Peaks are stored at a fixed
// resolution (`PEAKS_PER_SECOND`) so the timeline can downsample further
// at draw time without re-decoding the file.

export const PEAKS_PER_SECOND = 200

const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'] as const
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88] as const
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17] as const
const KEY_MIN_CONFIDENCE_GAP = 0.012

/** Lazily-instantiated `AudioContext` reused across decodes. */
let audioContext: AudioContext | null = null
function getAudioContext(): AudioContext {
  if (!audioContext) audioContext = new AudioContext()
  return audioContext
}

/**
 * Decodes a raw audio buffer (any browser-supported format) into a peaks
 * array suitable for waveform rendering, plus its duration and channel count.
 *
 * The decoded planar PCM (`channels`) is also returned so callers can
 * forward it to the main process for re-encoding as WAV (used when the
 * JUCE backend can't decode the original format natively).
 */
export async function decodeAudioToPeaks(data: ArrayBuffer): Promise<{
  durationMs: number
  sampleRate: number
  channelCount: number
  /** Alternating min, max pairs at `PEAKS_PER_SECOND` resolution. */
  peaks: Float32Array
  /** Planar PCM, one Float32Array per channel. */
  channels: Float32Array[]
}> {
  // `decodeAudioData` consumes the ArrayBuffer; clone first so the caller
  // can retain a copy if needed.
  const ctx = getAudioContext()
  const audioBuffer = await ctx.decodeAudioData(data.slice(0))

  // `getChannelData` returns a view into the AudioBuffer's internal
  // storage. We copy into standalone Float32Arrays so the data survives
  // the AudioBuffer going out of scope and can be transferred over IPC.
  const channels: Float32Array[] = []
  for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
    const src = audioBuffer.getChannelData(c)
    const copy = new Float32Array(src.length)
    copy.set(src)
    channels.push(copy)
  }

  const peaks = computePeaks(audioBuffer, PEAKS_PER_SECOND)

  return {
    durationMs: audioBuffer.duration * 1000,
    sampleRate: audioBuffer.sampleRate,
    channelCount: audioBuffer.numberOfChannels,
    peaks,
    channels
  }
}

/**
 * Estimate the musical key from decoded PCM using a lightweight chroma
 * profile pass. This is intentionally approximate: it is used as helpful
 * library metadata, not as an editing constraint.
 */
export function detectMusicalKey(channels: readonly Float32Array[], sampleRate: number): string | undefined {
  if (channels.length === 0 || sampleRate <= 0) return undefined

  const mono = downmixForKeyDetection(channels, sampleRate)
  if (mono.samples.length < 2048) return undefined

  const chroma = estimateChroma(mono.samples, mono.sampleRate)
  const totalEnergy = chroma.reduce((sum, value) => sum + value, 0)
  if (totalEnergy <= 0) return undefined

  const normalised = chroma.map((value) => value / totalEnergy)
  const candidates: { key: string; score: number }[] = []
  for (let root = 0; root < 12; root++) {
    candidates.push({
      key: `${NOTE_NAMES[root]} major`,
      score: correlation(normalised, rotatedProfile(MAJOR_PROFILE, root))
    })
    candidates.push({
      key: `${NOTE_NAMES[root]} minor`,
      score: correlation(normalised, rotatedProfile(MINOR_PROFILE, root))
    })
  }
  candidates.sort((a, b) => b.score - a.score)
  const best = candidates[0]
  const second = candidates[1]
  if (!best || !second || best.score - second.score < KEY_MIN_CONFIDENCE_GAP) return undefined
  return best.key
}

function downmixForKeyDetection(
  channels: readonly Float32Array[],
  sourceSampleRate: number
): { samples: Float32Array; sampleRate: number } {
  const targetSampleRate = 11025
  const maxSeconds = 120
  const stride = Math.max(1, Math.floor(sourceSampleRate / targetSampleRate))
  const outputSampleRate = sourceSampleRate / stride
  const sourceLength = Math.min(...channels.map((channel) => channel.length))
  const sampleCount = Math.min(Math.floor(sourceLength / stride), Math.floor(outputSampleRate * maxSeconds))
  const out = new Float32Array(sampleCount)
  for (let i = 0; i < sampleCount; i++) {
    const sourceIndex = i * stride
    let sum = 0
    for (const channel of channels) sum += channel[sourceIndex] ?? 0
    out[i] = sum / channels.length
  }
  return { samples: out, sampleRate: outputSampleRate }
}

function estimateChroma(samples: Float32Array, sampleRate: number): number[] {
  const chroma = new Array<number>(12).fill(0)
  const windowSize = 4096
  const hopSize = 4096
  const startMidi = 36
  const endMidi = 83
  for (let start = 0; start + windowSize <= samples.length; start += hopSize) {
    for (let midi = startMidi; midi <= endMidi; midi++) {
      const freq = 440 * 2 ** ((midi - 69) / 12)
      const magnitude = goertzelMagnitude(samples, start, windowSize, sampleRate, freq)
      const pitchClass = midi % 12
      chroma[pitchClass] = chroma[pitchClass]! + magnitude
    }
  }
  return chroma
}

function goertzelMagnitude(
  samples: Float32Array,
  start: number,
  length: number,
  sampleRate: number,
  frequency: number
): number {
  const omega = (2 * Math.PI * frequency) / sampleRate
  const coeff = 2 * Math.cos(omega)
  let s0 = 0
  let s1 = 0
  let s2 = 0
  for (let i = 0; i < length; i++) {
    const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (length - 1))
    s0 = samples[start + i]! * window + coeff * s1 - s2
    s2 = s1
    s1 = s0
  }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2))
}

function rotatedProfile(profile: readonly number[], root: number): number[] {
  const out = new Array<number>(12)
  for (let i = 0; i < 12; i++) out[(i + root) % 12] = profile[i]!
  return out
}

function correlation(a: readonly number[], b: readonly number[]): number {
  const meanA = a.reduce((sum, value) => sum + value, 0) / a.length
  const meanB = b.reduce((sum, value) => sum + value, 0) / b.length
  let num = 0
  let denA = 0
  let denB = 0
  for (let i = 0; i < a.length; i++) {
    const da = a[i]! - meanA
    const db = b[i]! - meanB
    num += da * db
    denA += da * da
    denB += db * db
  }
  const den = Math.sqrt(denA * denB)
  return den > 0 ? num / den : 0
}

/**
 * Reduces an `AudioBuffer` to a min/max peak pair per bucket, where each
 * bucket spans `sampleRate / peaksPerSecond` samples. Channels are mixed
 * down to mono by averaging.
 */
function computePeaks(buffer: AudioBuffer, peaksPerSecond: number): Float32Array {
  const { sampleRate, length, numberOfChannels } = buffer
  const samplesPerPeak = Math.max(1, Math.floor(sampleRate / peaksPerSecond))
  const peakCount = Math.ceil(length / samplesPerPeak)
  const out = new Float32Array(peakCount * 2)

  // Pre-fetch channel data to avoid the per-iteration getChannelData call cost.
  const channels: Float32Array[] = []
  for (let c = 0; c < numberOfChannels; c++) channels.push(buffer.getChannelData(c))

  for (let p = 0; p < peakCount; p++) {
    const start = p * samplesPerPeak
    const end = Math.min(start + samplesPerPeak, length)
    let min = 0
    let max = 0
    for (let i = start; i < end; i++) {
      // Average across channels for a mono peak.
      let sum = 0
      for (let c = 0; c < numberOfChannels; c++) sum += channels[c]![i]!
      const v = sum / numberOfChannels
      if (v < min) min = v
      else if (v > max) max = v
    }
    out[p * 2] = min
    out[p * 2 + 1] = max
  }

  return out
}

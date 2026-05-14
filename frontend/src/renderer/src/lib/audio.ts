// Audio decoding and peak-array generation for waveform rendering.
//
// Until the JUCE backend is wired up, the renderer decodes audio via the
// Web Audio API and computes peaks itself. Peaks are stored at a fixed
// resolution (`PEAKS_PER_SECOND`) so the timeline can downsample further
// at draw time without re-decoding the file.

export const PEAKS_PER_SECOND = 200

/** Lazily-instantiated `AudioContext` reused across decodes. */
let audioContext: AudioContext | null = null
function getAudioContext(): AudioContext {
  if (!audioContext) audioContext = new AudioContext()
  return audioContext
}

/**
 * Decodes a raw audio buffer (any browser-supported format) into a peaks
 * array suitable for waveform rendering, plus its duration and channel count.
 */
export async function decodeAudioToPeaks(data: ArrayBuffer): Promise<{
  durationMs: number
  sampleRate: number
  channelCount: number
  /** Alternating min, max pairs at `PEAKS_PER_SECOND` resolution. */
  peaks: Float32Array
}> {
  // `decodeAudioData` consumes the ArrayBuffer; clone first so the caller
  // can retain a copy if needed.
  const ctx = getAudioContext()
  const audioBuffer = await ctx.decodeAudioData(data.slice(0))

  const peaks = computePeaks(audioBuffer, PEAKS_PER_SECOND)

  return {
    durationMs: audioBuffer.duration * 1000,
    sampleRate: audioBuffer.sampleRate,
    channelCount: audioBuffer.numberOfChannels,
    peaks
  }
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
      for (let c = 0; c < numberOfChannels; c++) sum += channels[c][i]
      const v = sum / numberOfChannels
      if (v < min) min = v
      else if (v > max) max = v
    }
    out[p * 2] = min
    out[p * 2 + 1] = max
  }

  return out
}

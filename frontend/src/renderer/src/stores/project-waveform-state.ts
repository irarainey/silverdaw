import type { WaveformReadyPayload } from '@shared/bridge-protocol'
import type { LibraryState } from './libraryTypes'
import type { Clip } from './projectTypes'
import { filePathKey } from './projectHelpers'

// Shared completeness contract for reusing waveform state on live clip creation.

function peakRatesMatch(left: number | undefined, right: number): boolean {
  return typeof left === 'number' && Math.abs(left - right) < 1e-6
}

export function clipHasCompleteWaveformData(
  clip: Clip,
  library: LibraryState,
  expected?: Pick<WaveformReadyPayload, 'peakCount' | 'laneCount' | 'peaksPerSecond' | 'sampleRate'>
): boolean {
  const clipPeaksPerSecond = clip.peaksPerSecond
  if (
    clip.peaks.length < 2 ||
    !(clip.sampleRate > 0) ||
    !(typeof clipPeaksPerSecond === 'number' && clipPeaksPerSecond > 0)
  ) {
    return false
  }
  if (
    expected &&
    (clip.peaks.length !== expected.peakCount * 2 ||
      !peakRatesMatch(clip.peaksPerSecond, expected.peaksPerSecond) ||
      clip.sampleRate !== expected.sampleRate)
  ) {
    return false
  }

  const needsStereo = expected ? expected.laneCount === 3 : clip.channelCount === 2
  if (expected && expected.laneCount !== 1 && expected.laneCount !== 3) return false
  if (!needsStereo) return true

  const sourcePath = filePathKey(clip.filePath)
  return library.items.some((item) => {
    if (filePathKey(item.filePath) !== sourcePath) return false
    const channelEntry = library.channelPeaksByItemId[item.id]
    return (
      channelEntry !== undefined &&
      peakRatesMatch(channelEntry.peaksPerSecond, clipPeaksPerSecond) &&
      channelEntry.channels.length === 2 &&
      channelEntry.channels.every((channel) => channel.length === clip.peaks.length)
    )
  })
}

export function waveformReusePayload(
  clip: Clip,
  library: LibraryState
): { requestWaveform?: false } {
  return clipHasCompleteWaveformData(clip, library) ? { requestWaveform: false } : {}
}

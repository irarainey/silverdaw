import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadPeaksFromCache, parsePeaksCacheBuffer } from '@/lib/bridge/peaksCache'
import { useLibraryStore } from '@/stores/libraryStore'
import { useProjectStore } from '@/stores/projectStore'
import type { Clip } from '@/stores/projectTypes'

const readPeaksCacheFile = vi.fn()

const HEADER_SIZE = 28

function makePeaksCache(lanes: readonly number[][], trailingBytes = 0): ArrayBuffer {
  const peakCount = (lanes[0]?.length ?? 0) / 2
  const buffer = new ArrayBuffer(
    HEADER_SIZE + lanes.length * peakCount * 2 * Float32Array.BYTES_PER_ELEMENT + trailingBytes
  )
  const header = new DataView(buffer)
  header.setUint32(0, 0x53445057, true)
  header.setUint32(4, 2, true)
  header.setUint32(8, 500, true)
  header.setUint32(12, peakCount, true)
  header.setUint32(16, lanes.length, true)
  header.setFloat64(20, 48_000, true)
  const values = new Float32Array(buffer, HEADER_SIZE, lanes.length * peakCount * 2)
  let offset = 0
  for (const lane of lanes) {
    values.set(lane, offset)
    offset += lane.length
  }
  return buffer
}

describe('parsePeaksCacheBuffer', () => {
  it('returns zero-copy views for a canonical stereo cache', () => {
    const buffer = makePeaksCache([
      [-0.5, 0.5, -0.25, 0.25],
      [-0.6, 0.6, -0.3, 0.3],
      [-0.4, 0.4, -0.2, 0.2]
    ])

    const parsed = parsePeaksCacheBuffer(buffer, 2, 'test')

    expect(parsed?.summary.buffer).toBe(buffer)
    expect(parsed?.channels).toHaveLength(2)
    expect(parsed?.channels[0]?.buffer).toBe(buffer)
    expect(parsed?.channels[1]?.buffer).toBe(buffer)
    expect(Array.from(parsed?.summary ?? [])).toEqual([-0.5, 0.5, -0.25, 0.25])
  })

  it('returns a zero-copy view for a canonical mono cache', () => {
    const buffer = makePeaksCache([[-0.5, 0.5]])

    const parsed = parsePeaksCacheBuffer(buffer, 1, 'test')

    expect(parsed?.summary.buffer).toBe(buffer)
    expect(parsed?.channels).toEqual([])
  })

  it('copies used data when the cache contains trailing bytes', () => {
    const buffer = makePeaksCache([[-0.5, 0.5]], 4)

    const parsed = parsePeaksCacheBuffer(buffer, 1, 'test')

    expect(parsed?.summary.buffer).not.toBe(buffer)
    expect(Array.from(parsed?.summary ?? [])).toEqual([-0.5, 0.5])
  })
})

describe('loadPeaksFromCache', () => {
  const summary = new Float32Array([-0.5, 0.5, -0.25, 0.25])
  const left = new Float32Array([-0.6, 0.6, -0.3, 0.3])
  const right = new Float32Array([-0.4, 0.4, -0.2, 0.2])

  function seedClip(): Clip {
    const library = useLibraryStore()
    library.addItem({
      id: 'source-1',
      kind: 'source',
      filePath: 'C:\\audio\\source.wav',
      fileName: 'source.wav',
      durationMs: 4_000,
      sampleRate: 48_000,
      channelCount: 2,
      peaks: summary,
      peaksPerSecond: 500,
      fromSnapshot: true
    })
    const clip: Clip = {
      id: 'clip-1',
      trackId: 'track-1',
      libraryItemId: 'source-1',
      filePath: 'C:\\audio\\source.wav',
      fileName: 'source.wav',
      startMs: 0,
      inMs: 0,
      durationMs: 4_000,
      sampleRate: 48_000,
      channelCount: 2,
      peaks: summary,
      peaksPerSecond: 500,
      unresolved: false
    }
    useProjectStore().clips[clip.id] = clip
    return clip
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    readPeaksCacheFile.mockReset()
    vi.stubGlobal('window', {
      silverdaw: {
        readPeaksCacheFile
      }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('skips the cache IPC read when matching stereo peaks are already present', async () => {
    seedClip()
    useLibraryStore().setItemChannelPeaks('source-1', [left, right], 500)

    await loadPeaksFromCache({
      clipId: 'clip-1',
      cachePath: 'C:\\cache\\source.peaks',
      peakCount: 2,
      laneCount: 3,
      peaksPerSecond: 500,
      sampleRate: 48_000
    })

    expect(readPeaksCacheFile).not.toHaveBeenCalled()
  })

  it('reads the cache when a stereo channel lane is missing', async () => {
    seedClip()
    readPeaksCacheFile.mockResolvedValue(makePeaksCache([
      Array.from(summary),
      Array.from(left),
      Array.from(right)
    ]))

    await loadPeaksFromCache({
      clipId: 'clip-1',
      cachePath: 'C:\\cache\\source.peaks',
      peakCount: 2,
      laneCount: 3,
      peaksPerSecond: 500,
      sampleRate: 48_000
    })

    expect(readPeaksCacheFile).toHaveBeenCalledOnce()
    expect(useLibraryStore().channelPeaksByItemId['source-1']?.channels).toHaveLength(2)
  })
})

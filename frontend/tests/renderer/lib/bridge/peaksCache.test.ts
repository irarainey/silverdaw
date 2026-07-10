import { describe, expect, it } from 'vitest'
import { parsePeaksCacheBuffer } from '@/lib/bridge/peaksCache'

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

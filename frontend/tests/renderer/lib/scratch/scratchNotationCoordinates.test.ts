import { describe, expect, it } from 'vitest'
import {
  clientToSvgCoordinates,
  timeToX,
  xToTime,
  turnsToY,
  yToTurns,
  cfValueToY,
  yToCfValue
} from '@/lib/scratch/scratchNotationCoordinates'

describe('clientToSvgCoordinates', () => {
  it('maps client coords through SVG bounding rect and viewBox', () => {
    const svgRect = { left: 100, top: 50, width: 400, height: 200 } as DOMRect
    const result = clientToSvgCoordinates(300, 150, svgRect, 800, 400)
    // relX = 200, relY = 100
    // scaleX = 800/400 = 2, scaleY = 400/200 = 2
    expect(result.x).toBeCloseTo(400)
    expect(result.y).toBeCloseTo(200)
  })

  it('handles zero offset rect', () => {
    const svgRect = { left: 0, top: 0, width: 600, height: 300 } as DOMRect
    const result = clientToSvgCoordinates(150, 75, svgRect, 600, 300)
    expect(result.x).toBeCloseTo(150)
    expect(result.y).toBeCloseTo(75)
  })

  it('handles viewBox different from rendered size', () => {
    const svgRect = { left: 0, top: 0, width: 300, height: 150 } as DOMRect
    const result = clientToSvgCoordinates(150, 75, svgRect, 600, 300)
    // scaleX = 600/300 = 2, scaleY = 300/150 = 2
    expect(result.x).toBeCloseTo(300)
    expect(result.y).toBeCloseTo(150)
  })
})

describe('timeToX / xToTime', () => {
  it('maps time 0 to paddingX', () => {
    expect(timeToX(0, 1_000_000, 500, 24)).toBe(24)
  })

  it('maps durationUs to paddingX + contentWidth', () => {
    expect(timeToX(1_000_000, 1_000_000, 500, 24)).toBeCloseTo(524)
  })

  it('maps midpoint correctly', () => {
    expect(timeToX(500_000, 1_000_000, 500, 24)).toBeCloseTo(274)
  })

  it('returns paddingX for zero duration', () => {
    expect(timeToX(100, 0, 500, 24)).toBe(24)
  })

  it('xToTime inverts timeToX', () => {
    const t = 750_000
    const x = timeToX(t, 1_000_000, 500, 24)
    const result = xToTime(x, 1_000_000, 500, 24)
    expect(result).toBe(t)
  })

  it('xToTime clamps to [0, durationUs]', () => {
    expect(xToTime(-100, 1_000_000, 500, 24)).toBe(0)
    expect(xToTime(9999, 1_000_000, 500, 24)).toBe(1_000_000)
  })
})

describe('turnsToY / yToTurns', () => {
  it('max turns maps to top margin', () => {
    const y = turnsToY(2, 0, 2, 120, 8)
    expect(y).toBe(8) // margin
  })

  it('min turns maps to bottom', () => {
    const y = turnsToY(0, 0, 2, 120, 8)
    expect(y).toBeCloseTo(112) // 120 - 8
  })

  it('yToTurns inverts turnsToY', () => {
    const turns = 1.5
    const y = turnsToY(turns, 0, 3, 120, 8)
    const result = yToTurns(y, 0, 3, 120, 8)
    expect(result).toBeCloseTo(turns, 6)
  })

  it('handles equal min/max (range defaults to 1)', () => {
    const y = turnsToY(5, 5, 5, 120, 8)
    expect(Number.isFinite(y)).toBe(true)
  })
})

describe('cfValueToY / yToCfValue', () => {
  it('value 1 maps near top of lane', () => {
    const y = cfValueToY(1, 132, 60)
    expect(y).toBeCloseTo(132) // cfLaneTop + 0
  })

  it('value 0 maps near bottom of lane', () => {
    const y = cfValueToY(0, 132, 60)
    expect(y).toBeCloseTo(132 + 52) // cfLaneTop + (cfLaneHeight - 8)
  })

  it('yToCfValue inverts cfValueToY', () => {
    const value = 0.7
    const y = cfValueToY(value, 132, 60)
    const result = yToCfValue(y, 132, 60)
    expect(result).toBeCloseTo(value, 6)
  })

  it('yToCfValue clamps to [0,1]', () => {
    expect(yToCfValue(0, 132, 60)).toBe(1)
    expect(yToCfValue(9999, 132, 60)).toBe(0)
  })
})

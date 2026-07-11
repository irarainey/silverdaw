import { describe, expect, it } from 'vitest'
import { updateWaveMeshGeometry } from '@/lib/wave-mesh-geometry'

describe('updateWaveMeshGeometry', () => {
  it('retains an existing zero UV buffer while it remains large enough', () => {
    const uvs = new Float32Array(8)
    const geometry = {
      positions: new Float32Array(),
      uvs,
      indices: new Uint32Array()
    }
    const positions = new Float32Array(6)
    const indices = new Uint32Array([0, 1, 2])

    updateWaveMeshGeometry(geometry, positions, indices)

    expect(geometry.positions).toBe(positions)
    expect(geometry.uvs).toBe(uvs)
    expect(geometry.indices).toBe(indices)
  })

  it('grows the zero UV buffer once and reuses it for smaller meshes', () => {
    const geometry = {
      positions: new Float32Array(),
      uvs: new Float32Array(2),
      indices: new Uint32Array()
    }

    updateWaveMeshGeometry(geometry, new Float32Array(10), new Uint32Array(6))
    const grown = geometry.uvs
    expect(grown).toHaveLength(10)
    expect(Array.from(grown)).toEqual(new Array(10).fill(0))

    updateWaveMeshGeometry(geometry, new Float32Array(4), new Uint32Array(3))
    expect(geometry.uvs).toBe(grown)
  })
})

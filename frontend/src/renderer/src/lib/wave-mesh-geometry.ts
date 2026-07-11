import type { MeshGeometry } from 'pixi.js'

type MutableWaveMeshGeometry = Pick<MeshGeometry, 'positions' | 'uvs' | 'indices'>

export function updateWaveMeshGeometry(
  geometry: MutableWaveMeshGeometry,
  positions: Float32Array,
  indices: Uint32Array
): void {
  geometry.positions = positions
  if (geometry.uvs.length < positions.length) {
    geometry.uvs = new Float32Array(positions.length)
  }
  geometry.indices = indices
}

// Batched waveform geometry for the clip editor, matching the timeline renderer.
//
// Each waveform lane's bars are packed into ONE Pixi `Mesh` (a single
// position/index buffer, two triangles per merged rect) that tints a shared 1×1
// white texture to the wave colour. This is the same technique the timeline uses
// (see `timeline/clipRenderer.ts`) so both surfaces draw identically and a lane
// uploads as a single GPU batch instead of thousands of `fillRect` calls.
//
// The editor draws one or two lanes. Mesh shells are pooled and reused across
// redraws (swap geometry, release the prior frame's GPU buffers) so that at high
// zoom — where auto-follow scroll triggers a rebuild almost every frame — there is
// no per-frame Mesh/geometry allocation churn or GPU buffer thrash.

import type { Container, Mesh, MeshGeometry, Texture } from 'pixi.js'

export interface WaveMeshCtors {
  MeshCtor: typeof Mesh | null
  MeshGeometryCtor: typeof MeshGeometry | null
  whiteTexture: Texture | null
}

export interface WaveMeshBuilder {
  /** Reset the cursor at the start of a redraw (before any lane is built). */
  beginFrame: () => void
  /** Reset the per-lane vertex/index accumulator before pushing quads. */
  reset: () => void
  /** Append one axis-aligned quad spanning `[x0,x1] × [y0,y1]`. */
  pushQuad: (x0: number, y0: number, x1: number, y1: number) => void
  /**
   * Upload the accumulated quads as a tinted Mesh added to `layer`, reusing a
   * pooled Mesh shell (swapping in fresh geometry and releasing the previous
   * frame's GPU buffers) so redraws don't churn allocations. Returns false when
   * there is nothing to draw or Pixi is not ready.
   */
  flush: (layer: Container, tint: number, alpha: number) => boolean
  /** Forget pooled meshes (call when the Pixi app is torn down/rebuilt). */
  dropPool: () => void
}

export function createWaveMeshBuilder(ctors: WaveMeshCtors): WaveMeshBuilder {
  // Scratch buffers grown to the busiest lane and reused every build.
  let xy = new Float32Array(8192) // 2 floats per vertex
  let idx = new Uint32Array(12288) // 6 indices per quad
  let verts = 0
  let indices = 0

  // Pooled Mesh shells reused across redraws (the editor draws 1–2 lanes), so a
  // rebuild swaps geometry on an existing Mesh instead of allocating a new one.
  type PooledMesh = InstanceType<NonNullable<WaveMeshCtors['MeshCtor']>>
  const meshPool: PooledMesh[] = []
  let cursor = 0

  function beginFrame(): void {
    cursor = 0
  }

  function dropPool(): void {
    meshPool.length = 0
  }

  function reset(): void {
    verts = 0
    indices = 0
  }

  function pushQuad(x0: number, y0: number, x1: number, y1: number): void {
    const needFloats = (verts + 4) * 2
    if (needFloats > xy.length) {
      let len = xy.length
      while (len < needFloats) len *= 2
      const grown = new Float32Array(len)
      grown.set(xy)
      xy = grown
    }
    if (indices + 6 > idx.length) {
      let len = idx.length
      while (len < indices + 6) len *= 2
      const grown = new Uint32Array(len)
      grown.set(idx)
      idx = grown
    }
    const base = verts
    let p = verts * 2
    xy[p++] = x0
    xy[p++] = y0
    xy[p++] = x1
    xy[p++] = y0
    xy[p++] = x1
    xy[p++] = y1
    xy[p++] = x0
    xy[p++] = y1
    verts += 4
    let q = indices
    idx[q++] = base
    idx[q++] = base + 1
    idx[q++] = base + 2
    idx[q++] = base
    idx[q++] = base + 2
    idx[q++] = base + 3
    indices = q
  }

  function flush(layer: Container, tint: number, alpha: number): boolean {
    const M = ctors.MeshCtor
    const MG = ctors.MeshGeometryCtor
    const tex = ctors.whiteTexture
    if (!M || !MG || !tex || indices === 0) return false
    // Exact-length copies: each geometry buffer keeps its own backing array; zero
    // UVs sample the 1×1 white pixel, tinted to the wave colour.
    const positions = xy.slice(0, verts * 2)
    const meshIndices = idx.slice(0, indices)
    const existing = meshPool[cursor]
    if (existing && !existing.destroyed) {
      // Reuse BOTH the Mesh shell AND its geometry, updating the buffers in place
      // instead of allocating a new MeshGeometry and destroying the old one each
      // flush. This removes per-frame geometry/GPU-buffer churn and the VRAM leak
      // the default Geometry.destroy() left behind. Pixi's Buffer `data` setter
      // handles in-place re-upload and resize, so no geometry teardown per frame.
      const geo = existing.geometry as MeshGeometry
      geo.positions = positions
      geo.uvs = new Float32Array(positions.length)
      geo.indices = meshIndices
      existing.tint = tint
      existing.alpha = alpha
      layer.addChild(existing)
    } else {
      // `no-batch`: keep waveform meshes off Pixi's batcher (see clipRenderer for
      // the full rationale) — a reused/re-added pooled shell can hit a null
      // `_batcher` in `MeshPipe.updateRenderable` and throw inside Pixi's render
      // loop, blanking the waveform permanently. The direct path is robust.
      const geometry = new MG({ positions, indices: meshIndices })
      geometry.batchMode = 'no-batch'
      const mesh = new M({ geometry, texture: tex })
      mesh.tint = tint
      mesh.alpha = alpha
      meshPool[cursor] = mesh
      layer.addChild(mesh)
    }
    cursor++
    return true
  }

  return { beginFrame, reset, pushQuad, flush, dropPool }
}

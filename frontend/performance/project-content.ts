import assert from 'node:assert/strict'
import { findNodes, type ProjectNode } from '../e2e/helpers/projectDocument.ts'

/** Verify meaningful fixture content, tolerating native float storage. */
export function assertProjectContent(expected: ProjectNode, saved: ProjectNode): void {
  if (expected.projectLengthMs !== undefined) {
    assert.equal(saved.projectLengthMs, expected.projectLengthMs, 'Project length changed')
  }
  const properties = {
    TRACK: [
      'name',
      'gain',
      'pan',
      'toneBassDb',
      'toneTrebleDb',
      'automation',
      'automationLaneView'
    ],
    CLIP: ['libraryItemId', 'offsetMs', 'inMs', 'durationMs']
  }
  for (const [type, keys] of Object.entries(properties)) {
    const savedNodes = new Map(findNodes(saved, type).map((node) => [node.id, node]))
    for (const node of findNodes(expected, type)) {
      const actual = savedNodes.get(node.id)
      assert.ok(actual, `Saved ${type} ${String(node.id)} is missing`)
      for (const key of keys) {
        const value = node[key]
        if (value === undefined) continue
        const message = `${type} ${String(node.id)} changed ${key}`
        if (typeof value === 'number') {
          assert.ok(
            typeof actual[key] === 'number' && Math.abs(actual[key] - value) < 1e-5,
            message
          )
        } else {
          assert.deepEqual(actual[key], value, message)
        }
      }
      if (type === 'TRACK') {
        assert.deepEqual(
          findNodes(actual, 'CLIP').map((clip) => clip.id),
          findNodes(node, 'CLIP').map((clip) => clip.id),
          `Clip ownership changed for ${String(node.id)}`
        )
      }
    }
  }
}

/** Include expanded automation rows in the existing track-scroll workload. */
export function expandedLaneHeight(project: ProjectNode): number {
  let height = 0
  for (const track of findNodes(project, 'TRACK')) {
    if (track.automationLaneView === undefined) continue
    assert.ok(Array.isArray(track.automationLaneView), 'Expected saved lane views')
    const lanes: unknown[] = track.automationLaneView
    for (const lane of lanes) {
      assert.ok(lane && typeof lane === 'object' && 'heightPx' in lane)
      assert.ok(
        typeof lane.heightPx === 'number' && Number.isFinite(lane.heightPx) && lane.heightPx > 0
      )
      height += lane.heightPx
    }
  }
  return height
}

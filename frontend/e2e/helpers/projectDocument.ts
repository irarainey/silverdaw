// Reads the saved project document.
//
// The timeline is a PixiJS canvas with no DOM, so a journey about what the
// engine did to a clip — warped, retimed, split — has to read the engine's own
// output. That makes the `.silverdaw` file a shared assertion surface rather
// than one spec's private concern, and these two functions are the whole of it.
//
// Nodes are addressed by `$type` and depth-first rather than by index, because
// nesting is by container (`PROJECT` → `TRACK` → `CLIP`) and a spec that hard-
// coded a path would break on an unrelated container being added.

import { readFileSync } from 'node:fs'

export interface ProjectNode {
  $type?: string
  $children?: ProjectNode[]
  [key: string]: unknown
}

/**
 * Parses a saved project and returns its root `PROJECT` node. Returns null when
 * the file is absent or mid-write, so callers can poll rather than race the
 * engine's own save.
 */
export function readProjectDocument(projectFile: string): ProjectNode | null {
  try {
    const parsed = JSON.parse(readFileSync(projectFile, 'utf8')) as { project?: ProjectNode }
    return parsed.project ?? null
  } catch {
    return null
  }
}

/** Depth-first search for the first node of a type, since nesting is by container. */
export function findNode(node: ProjectNode, type: string): ProjectNode | null {
  if (node.$type === type) return node
  for (const child of node.$children ?? []) {
    const found = findNode(child, type)
    if (found) return found
  }
  return null
}

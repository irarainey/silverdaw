import { afterAll, describe, expect, it } from 'vitest'
import { mkdir, writeFile, mkdtemp, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { sweepEmptyArtifactSubdirs } from '@main/projectFileCleanup'
import { registerSamplesWriteRoot } from '@main/audioPaths'

// Each test uses a unique temp project so the module-global write-root sets never
// collide between cases.
const tempRoots: string[] = []

async function makeProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'silverdaw-cleanup-'))
  tempRoots.push(dir)
  return dir
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

afterAll(async () => {
  for (const dir of tempRoots) await rm(dir, { recursive: true, force: true }).catch(() => {})
})

describe('sweepEmptyArtifactSubdirs (real filesystem)', () => {
  it('removes empty per-source subfolders but keeps non-empty ones and the root', async () => {
    const project = await makeProject()
    const samplesRoot = join(project, 'samples')
    const emptyDir = join(samplesRoot, 'Leftover')
    const fullDir = join(samplesRoot, 'Has Files')
    await mkdir(emptyDir, { recursive: true })
    await mkdir(fullDir, { recursive: true })
    await writeFile(join(fullDir, 'keep.wav'), 'wav')
    registerSamplesWriteRoot(samplesRoot)

    await sweepEmptyArtifactSubdirs(samplesRoot)
    expect(await exists(emptyDir)).toBe(false) // empty leftover removed
    expect(await exists(fullDir)).toBe(true) // non-empty kept
    expect(await exists(samplesRoot)).toBe(true) // root kept
  })

  it('is a no-op for an unregistered or missing root', async () => {
    const project = await makeProject()
    const unregistered = join(project, 'samples')
    const dir = join(unregistered, 'x')
    await mkdir(dir, { recursive: true })
    // root not registered → isPrunableArtifactSubdir is false → nothing removed
    await sweepEmptyArtifactSubdirs(unregistered)
    expect(await exists(dir)).toBe(true)
    await sweepEmptyArtifactSubdirs(join(project, 'does-not-exist'))
  })
})

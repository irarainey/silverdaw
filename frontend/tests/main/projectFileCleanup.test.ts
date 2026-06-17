import { afterAll, describe, expect, it } from 'vitest'
import { mkdir, writeFile, mkdtemp, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { cleanupArtifactWavs, sweepEmptyArtifactSubdirs } from '@main/projectFileCleanup'
import { registerSamplesWriteRoot, registerStemsWriteRoot } from '@main/audioPaths'

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

describe('cleanupArtifactWavs (real filesystem)', () => {
  it('removes the per-source folder once its LAST sample is deleted, not before', async () => {
    const project = await makeProject()
    const samplesRoot = join(project, 'samples')
    const sourceDir = join(samplesRoot, 'My Song')
    const a = join(sourceDir, 'My Song-sample-001.wav')
    const b = join(sourceDir, 'My Song-sample-002.wav')
    await mkdir(sourceDir, { recursive: true })
    await writeFile(a, 'wav-a')
    await writeFile(b, 'wav-b')
    registerSamplesWriteRoot(samplesRoot)

    // First removal: file gone, folder kept (still holds the other sample).
    await cleanupArtifactWavs([a])
    expect(await exists(a)).toBe(false)
    expect(await exists(sourceDir)).toBe(true)

    // Last removal: file gone AND the now-empty folder is pruned.
    await cleanupArtifactWavs([b])
    expect(await exists(b)).toBe(false)
    expect(await exists(sourceDir)).toBe(false)
    // The samples root itself is never removed.
    expect(await exists(samplesRoot)).toBe(true)
  })

  it('prunes the folder when both files are deleted in one call', async () => {
    const project = await makeProject()
    const stemsRoot = join(project, 'stems')
    const sourceDir = join(stemsRoot, 'Song-stems')
    const vocals = join(sourceDir, 'vocals.wav')
    const drums = join(sourceDir, 'drums.wav')
    await mkdir(sourceDir, { recursive: true })
    await writeFile(vocals, 'v')
    await writeFile(drums, 'd')
    registerStemsWriteRoot(stemsRoot)

    await cleanupArtifactWavs([vocals, drums])
    expect(await exists(sourceDir)).toBe(false)
    expect(await exists(stemsRoot)).toBe(true)
  })

  it('still prunes an emptied folder even if the file was already gone', async () => {
    const project = await makeProject()
    const samplesRoot = join(project, 'samples')
    const sourceDir = join(samplesRoot, 'Gone')
    const missing = join(sourceDir, 'already-deleted.wav')
    await mkdir(sourceDir, { recursive: true }) // empty folder, file never written
    registerSamplesWriteRoot(samplesRoot)

    await cleanupArtifactWavs([missing])
    expect(await exists(sourceDir)).toBe(false)
  })

  it('refuses to delete a file outside the stems/samples roots', async () => {
    const project = await makeProject()
    const outside = join(project, 'original.wav')
    await writeFile(outside, 'user-original')
    // No write root registered for this project's bare folder.
    await cleanupArtifactWavs([outside])
    expect(await exists(outside)).toBe(true)
  })

  it('never recursively deletes a folder that still holds an unrelated file', async () => {
    const project = await makeProject()
    const samplesRoot = join(project, 'samples')
    const sourceDir = join(samplesRoot, 'Mixed')
    const ours = join(sourceDir, 'ours-sample-001.wav')
    const keep = join(sourceDir, 'user-notes.txt')
    await mkdir(sourceDir, { recursive: true })
    await writeFile(ours, 'wav')
    await writeFile(keep, 'do not delete me')
    registerSamplesWriteRoot(samplesRoot)

    await cleanupArtifactWavs([ours])
    expect(await exists(ours)).toBe(false) // our WAV is gone
    expect(await exists(keep)).toBe(true) // the unknown file is preserved
    expect(await exists(sourceDir)).toBe(true) // folder kept (still holds the file)
  })
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

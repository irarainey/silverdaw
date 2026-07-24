import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listProjectImportSources } from '@main/projectImportSources'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function makeProjectsRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'silverdaw-project-import-'))
  temporaryRoots.push(root)
  return root
}

describe('listProjectImportSources', () => {
  it('lists direct files and standard one-folder project layouts by saved name', async () => {
    const root = await makeProjectsRoot()
    await writeFile(
      join(root, 'Direct.silverdaw'),
      JSON.stringify({ project: { name: 'Direct Mix' } })
    )
    await mkdir(join(root, 'Nested'))
    await writeFile(
      join(root, 'Nested', 'Nested.silverdaw'),
      JSON.stringify({ project: { name: 'Nested Mix' } })
    )
    await mkdir(join(root, 'Ignored', 'Deeper'), { recursive: true })
    await writeFile(join(root, 'Ignored', 'Deeper', 'Ignored.silverdaw'), '{}')

    await expect(listProjectImportSources(root)).resolves.toEqual([
      { path: join(root, 'Direct.silverdaw'), name: 'Direct Mix' },
      { path: join(root, 'Nested', 'Nested.silverdaw'), name: 'Nested Mix' }
    ])
  })

  it('falls back to the file name when project JSON is unreadable', async () => {
    const root = await makeProjectsRoot()
    await writeFile(join(root, 'Broken.silverdaw'), '{not JSON')

    await expect(listProjectImportSources(root)).resolves.toEqual([
      { path: join(root, 'Broken.silverdaw'), name: 'Broken' }
    ])
  })
})

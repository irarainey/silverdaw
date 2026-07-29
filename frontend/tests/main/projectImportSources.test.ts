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

  it('falls back to the file name for projects still carrying the default name', async () => {
    // Releases before 1.4.2 adopted the chosen filename only after serialising, so
    // every project they saved stores "Untitled". Showing the stored name would
    // render a user's whole back catalogue as identical, unusable rows.
    const root = await makeProjectsRoot()
    await mkdir(join(root, 'Summer Mashup'))
    await writeFile(
      join(root, 'Summer Mashup', 'Summer Mashup.silverdaw'),
      JSON.stringify({ project: { name: 'Untitled' } })
    )
    await mkdir(join(root, 'Winter Mashup'))
    await writeFile(
      join(root, 'Winter Mashup', 'Winter Mashup.silverdaw'),
      JSON.stringify({ project: { name: 'Untitled' } })
    )

    await expect(listProjectImportSources(root)).resolves.toEqual([
      { path: join(root, 'Summer Mashup', 'Summer Mashup.silverdaw'), name: 'Summer Mashup' },
      { path: join(root, 'Winter Mashup', 'Winter Mashup.silverdaw'), name: 'Winter Mashup' }
    ])
  })

  it('keeps a name the user actually chose', async () => {
    const root = await makeProjectsRoot()
    await writeFile(
      join(root, 'OnDisk.silverdaw'),
      JSON.stringify({ project: { name: 'Chosen Name' } })
    )

    await expect(listProjectImportSources(root)).resolves.toEqual([
      { path: join(root, 'OnDisk.silverdaw'), name: 'Chosen Name' }
    ])
  })
})

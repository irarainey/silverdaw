import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { sha256 } from './fixtures.ts'
import type { Report } from './contracts.ts'

export async function identifyBuild(executable: string): Promise<Omit<Report['build'], 'runtime'>> {
  const root = dirname(executable)
  await stat(join(root, 'resources', 'app.asar'))
  await stat(join(root, 'resources', 'backend', 'SilverdawBackend.exe'))
  const paths: string[] = []
  async function collect(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`Packaged payload contains a link: ${path}`)
      if (entry.isDirectory()) await collect(path)
      else if (entry.isFile()) paths.push(path)
    }
  }
  await collect(root)
  const files = []
  for (const path of paths.sort()) {
    const digest = createHash('sha256')
    for await (const chunk of createReadStream(path)) digest.update(chunk)
    files.push({
      path: relative(root, path),
      bytes: (await stat(path)).size,
      sha256: digest.digest('hex')
    })
  }
  return { files, fingerprint: sha256(JSON.stringify(files)) }
}

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ execFile: vi.fn(), log: vi.fn() }))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFile: mocks.execFile }
})
vi.mock('@main/log', () => ({ logMain: mocks.log }))

import { compressDiagnostics } from '@main/diagnosticsZip'

describe('diagnostics ZIP creation', () => {
  let root: string
  let zipPath: string

  beforeEach(async () => {
    vi.resetAllMocks()
    root = await mkdtemp(join(tmpdir(), "silverdaw ZIP [test] '-"))
    zipPath = join(root, 'output.zip')
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('bounds execution and logs PowerShell errors instead of claiming success', async () => {
    mocks.execFile.mockImplementation((_file, _args, _options, callback) => {
      callback(new Error('timed out'), '', 'Access denied')
    })
    expect(await compressDiagnostics(root, zipPath)).toBe(false)
    expect(mocks.execFile).toHaveBeenCalledWith(
      'powershell.exe',
      expect.not.arrayContaining(['Bypass']),
      expect.objectContaining({ timeout: 60_000, maxBuffer: 64 * 1024, windowsHide: true }),
      expect.any(Function)
    )
    expect(mocks.log).toHaveBeenCalledWith(
      'WARN ',
      'diag',
      'diagnostics ZIP failed',
      expect.any(Error),
      'Access denied'
    )
  })

  it('rejects a successful process with missing or empty output', async () => {
    mocks.execFile.mockImplementation((_file, _args, _options, callback) => callback(null, '', ''))
    expect(await compressDiagnostics(root, zipPath)).toBe(false)
    await writeFile(zipPath, '')
    expect(await compressDiagnostics(root, zipPath)).toBe(false)
  })

  it('creates a real readable ZIP for literal bracket and apostrophe paths', async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
    mocks.execFile.mockImplementation(actual.execFile)
    const source = join(root, 'logs')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(source)
    await writeFile(join(source, 'backend [1].log'), 'current separation')
    expect(await compressDiagnostics(source, zipPath)).toBe(true)
    expect((await readFile(zipPath)).subarray(0, 2).toString()).toBe('PK')
    const quote = (value: string): string => `'${value.replace(/'/g, "''")}'`
    const output = await promisify(actual.execFile)(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip = [System.IO.Compression.ZipFile]::OpenRead(${quote(zipPath)}); $reader = [System.IO.StreamReader]::new($zip.GetEntry('backend [1].log').Open()); $reader.ReadToEnd(); $reader.Dispose(); $zip.Dispose()`
      ],
      { windowsHide: true, timeout: 10_000 }
    )
    expect(output.stdout.trim()).toBe('current separation')
  }, 20_000)
})

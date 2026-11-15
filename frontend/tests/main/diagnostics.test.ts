import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  sessionDir: '',
  diagnosticsDir: '',
  compress: vi.fn(),
  reveal: vi.fn(),
  openExternal: vi.fn(),
  flush: vi.fn(),
  log: vi.fn()
}))
vi.mock('electron', () => ({
  app: { getVersion: () => '1.10.1' },
  shell: { showItemInFolder: mocks.reveal, openExternal: mocks.openExternal }
}))
vi.mock('@main/log', () => ({
  getSessionDir: () => mocks.sessionDir,
  getDiagnosticsDir: () => mocks.diagnosticsDir,
  logMain: mocks.log,
  flushLogs: mocks.flush
}))
vi.mock('@main/diagnosticsZip', () => ({ compressDiagnostics: mocks.compress }))

import { sendDiagnosticLogs } from '@main/diagnostics'

describe('diagnostic bundles', () => {
  let root: string
  let staging: string | undefined

  beforeEach(async () => {
    vi.resetAllMocks()
    root = await mkdtemp(join(tmpdir(), 'silverdaw-diagnostics-test-'))
    mocks.sessionDir = join(root, 'logs', 'session')
    mocks.diagnosticsDir = join(root, 'diagnostics')
    await mkdir(mocks.sessionDir, { recursive: true })
    await mkdir(mocks.diagnosticsDir)
    await writeFile(join(mocks.sessionDir, 'backend.log'), 'current separation')
    await writeFile(join(mocks.sessionDir, 'main.log'), 'current main')
    await writeFile(join(mocks.sessionDir, 'renderer.log'), 'current renderer')
    await writeFile(join(mocks.diagnosticsDir, 'backend.log'), 'older startup')
    await writeFile(join(mocks.diagnosticsDir, 'startup.log'), 'current startup')
    staging = undefined
    mocks.openExternal.mockResolvedValue(undefined)
    mocks.flush.mockResolvedValue(undefined)
    mocks.compress.mockImplementation(async (source: string, destination: string) => {
      staging = source
      await writeFile(destination, 'archive fixture')
      return true
    })
  })

  afterEach(async () => {
    vi.useRealTimers()
    await rm(root, { recursive: true, force: true })
    if (staging) await rm(staging, { recursive: true, force: true })
  })

  it('preserves both backend logs, counts staged files and cleans successful staging', async () => {
    mocks.flush.mockImplementation(async () => {
      await writeFile(join(mocks.sessionDir, 'renderer.log'), 'flushed send diagnostics action')
    })
    mocks.compress.mockImplementation(async (source: string, destination: string) => {
      staging = source
      expect(await readFile(join(source, 'session', 'backend.log'), 'utf8')).toBe(
        'current separation'
      )
      expect(await readFile(join(source, 'diagnostics', 'backend.log'), 'utf8')).toBe(
        'older startup'
      )
      expect(await readFile(join(source, 'session', 'renderer.log'), 'utf8')).toBe(
        'flushed send diagnostics action'
      )
      await writeFile(destination, 'archive fixture')
      return true
    })
    const result = await sendDiagnosticLogs()
    expect(result).toMatchObject({ ok: true, zipped: true })
    if (!result.ok) throw new Error(result.error)
    expect(mocks.reveal).toHaveBeenCalledWith(result.path)
    expect(await readFile(result.path, 'utf8')).toBe('archive fixture')
    expect(mocks.log).toHaveBeenCalledWith(
      'INFO ',
      'diag',
      expect.stringContaining('format=zip files=5')
    )
    await expect(stat(staging!)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(decodeURIComponent(mocks.openExternal.mock.calls[0][0])).toContain(
      'Please attach this diagnostics ZIP'
    )
  })

  it('retains the folder, removes partial ZIPs and explains compression failure', async () => {
    mocks.compress.mockImplementation(async (source: string, destination: string) => {
      staging = source
      await writeFile(destination, 'partial ZIP')
      return false
    })
    const result = await sendDiagnosticLogs()
    expect(result).toMatchObject({
      ok: true,
      zipped: false,
      warning: expect.stringContaining('ZIP creation failed')
    })
    if (!result.ok) throw new Error(result.error)
    expect(result.path).toBe(staging)
    expect(await readFile(join(result.path, 'session', 'backend.log'), 'utf8')).toBe(
      'current separation'
    )
    await expect(stat(mocks.compress.mock.calls[0][1])).rejects.toMatchObject({ code: 'ENOENT' })
    expect(decodeURIComponent(mocks.openExternal.mock.calls[0][0])).toContain(
      'Please compress this diagnostics folder'
    )
  })

  it('reports an empty bundle as failure rather than opening a draft', async () => {
    await rm(mocks.sessionDir, { recursive: true })
    await rm(mocks.diagnosticsDir, { recursive: true })
    const result = await sendDiagnosticLogs()
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining('No diagnostic logs')
    })
    expect(mocks.compress).not.toHaveBeenCalled()
    expect(mocks.openExternal).not.toHaveBeenCalled()
  })

  it('returns filesystem enumeration errors without rejecting the IPC call', async () => {
    mocks.sessionDir = join(mocks.sessionDir, 'main.log')
    expect(await sendDiagnosticLogs()).toMatchObject({ ok: false })
    expect(mocks.openExternal).not.toHaveBeenCalled()
    expect(mocks.log).toHaveBeenCalledWith(
      'ERROR',
      'diag',
      'could not prepare diagnostic logs',
      expect.any(Error)
    )
  })

  it('keeps the ZIP usable when Explorer or the mail handler fails', async () => {
    mocks.reveal.mockImplementation(() => {
      throw new Error('Explorer failed')
    })
    mocks.openExternal.mockRejectedValue(new Error('No mail client'))
    const result = await sendDiagnosticLogs()
    expect(result).toMatchObject({
      ok: true,
      zipped: true,
      warning: expect.stringContaining('support@silverdaw.com')
    })
    if (!result.ok) throw new Error(result.error)
    expect((await stat(result.path)).isFile()).toBe(true)
    expect(result.warning).toContain('File Explorer could not be opened')
  })

  it('does not leave the UI waiting forever for a hung mail handler', async () => {
    let started: (() => void) | undefined
    const mailStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    mocks.openExternal.mockImplementation(() => {
      vi.useFakeTimers()
      started!()
      return new Promise<void>(() => {})
    })
    const pending = sendDiagnosticLogs()
    await mailStarted
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await pending).toMatchObject({
      ok: true,
      warning: expect.stringContaining('email draft could not be opened')
    })
  })

  it('does not collect nested files or unrelated subfolders', async () => {
    await mkdir(join(mocks.diagnosticsDir, 'nested'))
    await writeFile(join(mocks.diagnosticsDir, 'nested', 'unrelated.log'), 'not collected')
    mocks.compress.mockImplementation(async (source: string, destination: string) => {
      staging = source
      expect(await readdir(join(source, 'diagnostics'))).toEqual(['backend.log', 'startup.log'])
      await writeFile(destination, 'archive fixture')
      return true
    })
    expect(await sendDiagnosticLogs()).toMatchObject({ ok: true })
  })
})

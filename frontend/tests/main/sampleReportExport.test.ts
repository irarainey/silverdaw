import { dirname, join, resolve } from 'node:path'
import { cp, readFile } from 'node:fs/promises'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerProjectHandlers } from '@main/ipc/projectHandlers'
import { getProjectMediaDirs, projectMediaDirsFor } from '@main/audioPaths'
import { IPC } from '@shared/ipc-channels'

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
const picker = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({
  app: { getPath: () => resolve('test-workspace') },
  ipcMain: { on: handlers.set.bind(handlers), handle: handlers.set.bind(handlers) },
  dialog: { showSaveDialog: picker }
}))
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(), mkdir: vi.fn(), writeFile: vi.fn(), rm: vi.fn(), cp: vi.fn(),
  readdir: vi.fn().mockResolvedValue([]),
  stat: vi.fn().mockResolvedValue({ isDirectory: () => true }),
  lstat: vi.fn().mockResolvedValue({ isDirectory: () => true })
}))
vi.mock('@main/log', () => ({ logMain: vi.fn() }))

const webContents = { mainFrame: {}, printToPDF: vi.fn().mockResolvedValue(Buffer.from('pdf')) }
const event = { sender: webContents, senderFrame: webContents.mainFrame }
const { confirmActive, prepareOpen, prepareRecovery, chooseSaveAs, exportSampleReport } = IPC.project
const project = resolve('project', 'Mix.silverdaw')
const customFolder = resolve('pdfs')
const call = async (channel: string, ...args: unknown[]) => handlers.get(channel)!(event, ...args)

describe('Audio Sample Report export session', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    registerProjectHandlers({
      getMainWindow: () => ({ webContents }) as never,
      consumePendingOpenPath: () => null,
      prefs: { get: () => ({ paths: {} }), bumpRecentProject: () => false } as never
    })
    vi.mocked(readFile).mockResolvedValue('{}')
    await call(prepareOpen, project)
    await call(confirmActive, project, 'Mix', true)
    picker.mockResolvedValueOnce({ filePath: join(customFolder, 'report.pdf') })
    await call(exportSampleReport, project)
    picker.mockReset().mockResolvedValue({ canceled: true })
  })

  it.each(['malformed open', 'backend-rejected open', 'backend-rejected Save As'])(
    'keeps the current project and its export destination after %s', async attempt => {
      let rejected = resolve('unopened', 'Other.silverdaw')
      if (attempt === 'backend-rejected Save As') {
        picker.mockResolvedValueOnce({ filePath: rejected })
        rejected = await call(chooseSaveAs, 'Other') as string
      } else {
        if (attempt === 'malformed open') vi.mocked(readFile).mockResolvedValueOnce('{')
        expect(await call(prepareOpen, rejected)).toBe(attempt !== 'malformed open')
      }
      await expect(call(exportSampleReport, rejected)).rejects.toThrow('active project')
      await call(exportSampleReport, project)
      expect(dirname(picker.mock.lastCall?.[1].defaultPath)).toBe(customFolder)
      expect(getProjectMediaDirs()).toEqual(projectMediaDirsFor(dirname(project)))
    }
  )

  it('preserves the destination on ordinary save but resets on reopen of the same file', async () => {
    await call(confirmActive, project, 'Mix', false)
    await call(exportSampleReport, project)
    expect(dirname(picker.mock.lastCall?.[1].defaultPath)).toBe(customFolder)
    await call(prepareOpen, project)
    await call(confirmActive, project, 'Mix', true)
    await call(exportSampleReport, project)
    expect(dirname(picker.mock.lastCall?.[1].defaultPath)).toBe(join(dirname(project), 'audit'))
    await expect(call(exportSampleReport, join(dirname(project), 'Sibling.silverdaw'))).rejects.toThrow('active project')
    await call(confirmActive, null, 'Untitled', true)
    await expect(call(exportSampleReport, project)).rejects.toThrow('active project')
  })

  it('copies media on Save As but switches the live store only on a successful save', async () => {
    const source = projectMediaDirsFor(dirname(project))
    picker.mockResolvedValueOnce({ filePath: resolve('Saved.silverdaw') })
    const saved = await call(chooseSaveAs, 'Saved') as string
    const target = projectMediaDirsFor(dirname(saved))
    expect(getProjectMediaDirs()).toEqual(source)
    expect(cp).toHaveBeenCalledWith(source.metadataDir, target.metadataDir, expect.anything())
    expect(cp).toHaveBeenCalledWith(source.coversDir, target.coversDir, expect.anything())
    await call(confirmActive, saved, 'Saved', false)
    expect(getProjectMediaDirs()).toEqual(target)
    await call(exportSampleReport, saved)
    expect(dirname(picker.mock.lastCall?.[1].defaultPath)).toBe(join(dirname(saved), 'audit'))
  })

  it('activates recovered media beside the original, or in the unsaved workspace', async () => {
    const autosave = resolve('autosaves', 'snapshot.silverdaw')
    const original = resolve('originals', 'Original.silverdaw')
    await call(prepareRecovery, autosave, original)
    expect(getProjectMediaDirs()).toEqual(projectMediaDirsFor(dirname(project)))
    await call(confirmActive, original, 'Original', true)
    expect(getProjectMediaDirs()).toEqual(projectMediaDirsFor(dirname(original)))
    await call(prepareRecovery, autosave, null)
    expect(getProjectMediaDirs()).toEqual(projectMediaDirsFor(dirname(original)))
    await call(confirmActive, null, 'Untitled', true)
    expect(getProjectMediaDirs()).toEqual(projectMediaDirsFor(resolve('test-workspace', 'Silverdaw')))
  })
})

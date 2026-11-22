import { join, resolve } from 'node:path'
import { beforeEach, expect, it, vi } from 'vitest'
import { IPC } from '@shared/ipc-channels'
import type { AudioMetadata, MediaGeometryOrigin } from '@shared/types'
import { registerChannelsWriteRoot, registerIssuedPath, registerProjectMediaRoots } from '@main/audioPaths'
import { registerAudioHandlers } from '@main/ipc/audioHandlers'

const files = new Map<string, string>()
type Handler = (event: unknown, payload: unknown) => Promise<unknown>
const handlers = new Map<string, Handler>()
vi.mock('electron', () => ({
  app: { getPath: () => resolve('appdata') }, dialog: {},
  ipcMain: { handle: (channel: string, handler: Handler) => handlers.set(channel, handler), on: vi.fn() }
}))
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(), writeFile: async (path: string, json: string) => files.set(path, json),
  readFile: async (path: string) => {
    const value = files.get(path)
    if (value === undefined) throw Error('Missing file')
    return value
  }
}))
vi.mock('music-metadata', () => ({
  parseFile: async () => ({ common: { title: 'Song' }, format: { duration: 2, container: 'WAVE' } })
}))
vi.mock('@main/log', () => ({ logMain: vi.fn() }))

beforeEach(() => {
  files.clear()
  registerProjectMediaRoots(resolve('project'))
  registerAudioHandlers({ getMainWindow: () => null, getCurrentClipDir: () => '', setCurrentClipDir: vi.fn() })
})

it('round-trips the origin of parsed WAV geometry, including an ordinary import from a managed output folder', async () => {
  const channelDir = resolve('project', 'channels')
  registerChannelsWriteRoot(channelDir)
  const saveAndRead = async (id: string, filePath: string, geometryOrigin?: MediaGeometryOrigin) => {
    registerIssuedPath(filePath)
    await handlers.get(IPC.media.save)!({}, { mediaId: id, sourceFilePath: filePath, geometryOrigin })
    return await handlers.get(IPC.media.get)!({}, id) as AudioMetadata
  }
  const original = await saveAndRead('original', resolve('song.wav'), 'recording')
  const output = await saveAndRead('output', resolve('detached.wav'), 'output')
  const channel = await saveAndRead('channel', join(channelDir, 'left.wav'), 'recording')
  const unclassified = await saveAndRead('legacy', resolve('old.wav'))
  expect(unclassified).toMatchObject({ durationMs: 2000 })
  expect(unclassified).not.toHaveProperty('geometryOrigin')
  expect(original).toMatchObject({ title: 'Song', durationMs: 2000, geometryOrigin: 'recording' })
  for (const media of [output, channel]) {
    expect(media).toMatchObject({ title: 'Song', durationMs: 2000, geometryOrigin: 'output' })
    expect(media).not.toHaveProperty('recordingDurationMs')
  }
})

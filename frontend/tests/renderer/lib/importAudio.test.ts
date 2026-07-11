import { beforeEach, describe, expect, it, vi } from 'vitest'
import { importAudioIntoLibrary } from '@/lib/importAudio'

const mocks = vi.hoisted(() => ({
  decodeAudioToPeaks: vi.fn(),
  detectMusicalKey: vi.fn(),
  probeAudioFile: vi.fn(),
  addItem: vi.fn(() => 'stem-item'),
  setItemChannelPeaks: vi.fn(),
  setItemMetadata: vi.fn(),
  beginImport: vi.fn(() => 'import-1'),
  finishImport: vi.fn(),
  markImportAnalyzing: vi.fn(),
  noteImportFinished: vi.fn(),
  saveProjectMedia: vi.fn(),
  getProjectMedia: vi.fn()
}))

vi.mock('@/lib/audioDecode', () => ({
  decodeAudioToPeaks: mocks.decodeAudioToPeaks,
  detectMusicalKey: mocks.detectMusicalKey
}))
vi.mock('@/lib/bridgeService', () => ({
  send: vi.fn(),
  probeAudioFile: mocks.probeAudioFile
}))
vi.mock('@/lib/log', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))
vi.mock('@/stores/projectStore', () => ({ useProjectStore: vi.fn() }))
vi.mock('@/stores/transportStore', () => ({ useTransportStore: vi.fn() }))
vi.mock('@/stores/notificationsStore', () => ({ useNotificationsStore: vi.fn() }))
vi.mock('@/stores/uiStore', () => ({ useUiStore: vi.fn() }))
vi.mock('@/lib/sampleRatePrompt', () => ({ promptSampleRateMismatch: vi.fn() }))
vi.mock('@/lib/library/projectMedia', () => ({
  saveProjectMedia: mocks.saveProjectMedia,
  getProjectMedia: mocks.getProjectMedia
}))
vi.mock('@/stores/libraryStore', () => ({
  useLibraryStore: () => ({
    items: [],
    byId: { source: { id: 'source', mediaId: 'media-1' } },
    beginImport: mocks.beginImport,
    finishImport: mocks.finishImport,
    addItem: mocks.addItem,
    setItemChannelPeaks: mocks.setItemChannelPeaks,
    setItemMetadata: mocks.setItemMetadata,
    markImportAnalyzing: mocks.markImportAnalyzing,
    noteImportFinished: mocks.noteImportFinished
  }),
  libraryItemDisplayName: vi.fn(),
  resolveLibraryItemMediaId: (item: { mediaId?: string } | undefined) => item?.mediaId
}))

describe('importAudioIntoLibrary generated audio', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.decodeAudioToPeaks.mockResolvedValue({
      durationMs: 100,
      sampleRate: 48000,
      channelCount: 1,
      peaks: new Float32Array([0, 1]),
      channelPeaks: [new Float32Array([0, 1])],
      peaksPerSecond: 100,
      channels: [new Float32Array([0, 1])]
    })
    vi.stubGlobal('window', {
      silverdaw: {
        readAudioMetadata: vi.fn(),
        writeTempWav: vi.fn()
      }
    })
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'new-media') })
  })

  it('uses authoritative geometry and skips redundant generated-WAV analysis', async () => {
    const inheritedMetadata = { artist: 'Artist', key: 'A min' }
    const result = await importAudioIntoLibrary(
      {
        filePath: 'C:\\stems\\vocals.wav',
        fileName: 'vocals.wav',
        data: new ArrayBuffer(0)
      },
      {
        kind: 'stem',
        derivedFrom: { sourceItemId: 'source', inMs: 0, durationMs: 0 },
        generatedAudio: { sampleRate: 44100, durationMs: 50000, channelCount: 2 },
        inheritedMetadata
      }
    )

    expect(result).toBe('stem-item')
    expect(window.silverdaw.readAudioMetadata).not.toHaveBeenCalled()
    expect(mocks.probeAudioFile).not.toHaveBeenCalled()
    expect(mocks.detectMusicalKey).not.toHaveBeenCalled()
    expect(window.silverdaw.writeTempWav).not.toHaveBeenCalled()
    expect(mocks.getProjectMedia).not.toHaveBeenCalled()
    expect(mocks.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        durationMs: 50000,
        sampleRate: 44100,
        channelCount: 2,
        playbackFilePath: 'C:\\stems\\vocals.wav',
        mediaId: 'media-1'
      })
    )
    expect(mocks.setItemMetadata).toHaveBeenCalledWith('stem-item', inheritedMetadata)
  })
})

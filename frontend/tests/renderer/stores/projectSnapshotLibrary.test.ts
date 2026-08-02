import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useLibraryStore } from '@/stores/libraryStore'
import { useProjectStore } from '@/stores/projectStore'
import { libraryBridgeHandlers } from '@/lib/bridge/handlers/libraryHandlers'

const sendMock = vi.hoisted(() => vi.fn())
const decodeMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/bridgeService', () => ({
  send: sendMock
}))

vi.mock('@/lib/log', () => ({
  log: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn()
  }
}))

vi.mock('@/lib/audioDecode', () => ({
  PEAKS_PER_SECOND: 500,
  decodeAudioToPeaks: decodeMock
}))

async function flushAsyncWork(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve()
}

function decodedAudio() {
  return {
    durationMs: 2_000,
    sampleRate: 48_000,
    channelCount: 2,
    peaks: new Float32Array([-0.5, 0.5]),
    channelPeaks: [
      new Float32Array([-0.6, 0.6]),
      new Float32Array([-0.4, 0.4])
    ],
    peaksPerSecond: 500,
    channels: [new Float32Array(1), new Float32Array(1)]
  }
}

describe('project snapshot library media hydration', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sendMock.mockReset()
    decodeMock.mockReset()
    vi.stubGlobal('window', {
      silverdaw: {
        readAudioMetadata: vi.fn().mockResolvedValue(null),
        readAudioFile: vi.fn().mockResolvedValue(null)
      }
    })
  })

  it('uses the queued backend request instead of decoding matching source peaks', async () => {
    const project = useProjectStore()
    const library = useLibraryStore()
    project.applyProjectStateSnapshot({
      filePath: null,
      name: 'Placed saved clip',
      reset: true,
      bpm: 120,
      library: [
        {
          id: 'source-1',
          kind: 'source',
          filePath: 'C:\\Audio\\Loop.wav',
          durationMs: 2_000,
          sampleRate: 48_000,
          channelCount: 2
        },
        {
          id: 'stem-1',
          kind: 'stem',
          filePath: 'c:/audio/loop.wav',
          durationMs: 2_000,
          sampleRate: 48_000,
          channelCount: 2,
          sourceItemId: 'source-1'
        },
        {
          id: 'saved-clip-1',
          kind: 'clip',
          filePath: 'C:\\audio\\loop.wav',
          durationMs: 1_000,
          sourceItemId: 'source-1',
          sourceClipId: 'original-clip',
          sourceDurationMs: 1_000
        }
      ],
      tracks: [
        {
          id: 'track-1',
          gain: 1,
          clips: [
            {
              id: 'clip-1',
              libraryItemId: 'saved-clip-1',
              offsetMs: 0,
              durationMs: 1_000
            }
          ]
        }
      ]
    })
    await flushAsyncWork()

    expect(sendMock).toHaveBeenCalledWith('WAVEFORM_REQUEST', { clipId: 'clip-1' })
    expect(window.silverdaw.readAudioFile).not.toHaveBeenCalled()
    expect(decodeMock).not.toHaveBeenCalled()

    const summary = new Float32Array([-0.5, 0.5])
    const channels = [
      new Float32Array([-0.6, 0.6]),
      new Float32Array([-0.4, 0.4])
    ]
    project.setClipPeaks('clip-1', summary, 48_000, 500, channels)
    expect(library.byId['source-1']?.peaks).toBe(summary)
    expect(library.byId['stem-1']?.peaks).toBe(summary)
    expect(library.channelPeaksByItemId['source-1']?.channels).toEqual(channels)
    expect(library.channelPeaksByItemId['stem-1']?.channels).toEqual(channels)
  })

  it('still decodes peaks for a standalone library source', async () => {
    const opened = {
      filePath: 'C:\\audio\\standalone.wav',
      fileName: 'standalone.wav',
      data: new ArrayBuffer(8)
    }
    vi.mocked(window.silverdaw.readAudioFile).mockResolvedValue(opened)
    decodeMock.mockResolvedValue(decodedAudio())

    const project = useProjectStore()
    project.applyProjectStateSnapshot({
      filePath: null,
      name: 'Standalone source',
      reset: true,
      bpm: 120,
      library: [
        {
          id: 'source-1',
          kind: 'source',
          filePath: opened.filePath,
          durationMs: 2_000,
          sampleRate: 48_000,
          channelCount: 2
        }
      ],
      tracks: []
    })
    await flushAsyncWork()

    expect(window.silverdaw.readAudioFile).toHaveBeenCalledWith(opened.filePath)
    // Peaks-only decode: this path discards the PCM, so it must not be copied.
    expect(decodeMock).toHaveBeenCalledWith(opened.data, { includeChannels: false })
    expect(useLibraryStore().byId['source-1']?.peaks).toEqual(decodedAudio().peaks)
  })

  it('carries library peaks across an undo soft-replace instead of re-decoding', async () => {
    const opened = {
      filePath: 'C:\\audio\\standalone.wav',
      fileName: 'standalone.wav',
      data: new ArrayBuffer(8)
    }
    vi.mocked(window.silverdaw.readAudioFile).mockResolvedValue(opened)
    decodeMock.mockResolvedValue(decodedAudio())

    const project = useProjectStore()
    const library = useLibraryStore()
    const snapshotLibrary = [
      {
        id: 'source-1',
        kind: 'source' as const,
        filePath: opened.filePath,
        durationMs: 2_000,
        sampleRate: 48_000,
        channelCount: 2
      }
    ]
    project.applyProjectStateSnapshot({
      filePath: null,
      name: 'Standalone source',
      reset: true,
      bpm: 120,
      library: snapshotLibrary,
      tracks: []
    })
    await flushAsyncWork()

    const decodedPeaks = library.byId['source-1']?.peaks
    const decodedLod = library.byId['source-1']?.peaksLod
    expect(decodedPeaks).toBeDefined()
    expect(decodeMock).toHaveBeenCalledTimes(1)

    // An undo wipes and rehydrates the catalogue; the audio file is unchanged, so
    // the decoded peaks and their LOD pyramids must survive untouched.
    project.applyProjectStateSnapshot({
      filePath: null,
      name: 'Standalone source',
      reset: false,
      softReplace: true,
      bpm: 120,
      library: snapshotLibrary,
      tracks: []
    })
    await flushAsyncWork()

    expect(decodeMock).toHaveBeenCalledTimes(1)
    expect(window.silverdaw.readAudioFile).toHaveBeenCalledTimes(1)
    expect(library.byId['source-1']?.peaks).toBe(decodedPeaks)
    expect(library.byId['source-1']?.peaksLod).toBe(decodedLod)
    expect(library.channelPeaksByItemId['source-1']?.channels).toEqual(
      decodedAudio().channelPeaks
    )
  })

  it('carries library tags across an undo soft-replace instead of re-reading them', async () => {
    vi.mocked(window.silverdaw.readAudioMetadata).mockResolvedValue({ title: 'Carried' })
    vi.mocked(window.silverdaw.readAudioFile).mockResolvedValue(null)

    const project = useProjectStore()
    const library = useLibraryStore()
    const snapshotLibrary = [
      {
        id: 'source-1',
        kind: 'source' as const,
        filePath: 'C:\\audio\\tagged.wav',
        durationMs: 2_000,
        sampleRate: 48_000,
        channelCount: 2
      }
    ]
    project.applyProjectStateSnapshot({
      filePath: null,
      name: 'Tagged source',
      reset: true,
      bpm: 120,
      library: snapshotLibrary,
      tracks: []
    })
    await flushAsyncWork()
    expect(window.silverdaw.readAudioMetadata).toHaveBeenCalledTimes(1)
    // Stand in for a completed decode so the row has nothing left to fetch.
    library.setItemPeaks('source-1', new Float32Array([-0.5, 0.5]), 48_000, 500)

    project.applyProjectStateSnapshot({
      filePath: null,
      name: 'Tagged source',
      reset: false,
      softReplace: true,
      bpm: 120,
      library: snapshotLibrary,
      tracks: []
    })
    await flushAsyncWork()

    expect(window.silverdaw.readAudioMetadata).toHaveBeenCalledTimes(1)
    expect(library.byId['source-1']?.metadata).toEqual({ title: 'Carried' })
  })

  it('retains renderer decoding when placed media details are missing', async () => {    const opened = {
      filePath: 'C:\\audio\\legacy.wav',
      fileName: 'legacy.wav',
      data: new ArrayBuffer(8)
    }
    vi.mocked(window.silverdaw.readAudioFile).mockResolvedValue(opened)
    decodeMock.mockResolvedValue(decodedAudio())

    const project = useProjectStore()
    project.applyProjectStateSnapshot({
      filePath: null,
      name: 'Legacy source',
      reset: true,
      bpm: 120,
      library: [
        {
          id: 'source-1',
          kind: 'source',
          filePath: opened.filePath,
          durationMs: 0,
          sampleRate: 0,
          channelCount: 0
        }
      ],
      tracks: [
        {
          id: 'track-1',
          gain: 1,
          clips: [
            {
              id: 'clip-1',
              libraryItemId: 'source-1',
              offsetMs: 0,
              durationMs: 1_000
            }
          ]
        }
      ]
    })
    await flushAsyncWork()

    expect(sendMock).toHaveBeenCalledWith('WAVEFORM_REQUEST', { clipId: 'clip-1' })
    expect(window.silverdaw.readAudioFile).toHaveBeenCalledWith(opened.filePath)
    expect(decodeMock).toHaveBeenCalled()
    expect(useLibraryStore().byId['source-1']).toMatchObject({
      durationMs: 2_000,
      sampleRate: 48_000,
      channelCount: 2
    })
  })

  it('falls back to renderer decoding when backend peak generation fails', async () => {
    const opened = {
      filePath: 'C:\\audio\\fallback.wav',
      fileName: 'fallback.wav',
      data: new ArrayBuffer(8)
    }
    const project = useProjectStore()
    project.applyProjectStateSnapshot({
      filePath: null,
      name: 'Fallback source',
      reset: true,
      bpm: 120,
      library: [
        {
          id: 'source-1',
          kind: 'source',
          filePath: opened.filePath,
          durationMs: 2_000,
          sampleRate: 48_000,
          channelCount: 2
        }
      ],
      tracks: [
        {
          id: 'track-1',
          gain: 1,
          clips: [
            {
              id: 'clip-1',
              libraryItemId: 'source-1',
              offsetMs: 0,
              durationMs: 1_000
            }
          ]
        }
      ]
    })
    await flushAsyncWork()
    vi.mocked(window.silverdaw.readAudioFile).mockResolvedValue(opened)
    decodeMock.mockResolvedValue(decodedAudio())

    libraryBridgeHandlers.WAVEFORM_FAILED({
      clipId: 'clip-1',
      error: 'Waveform peaks could not be produced'
    })
    await flushAsyncWork()

    expect(window.silverdaw.readAudioFile).toHaveBeenCalledWith(opened.filePath)
    expect(useLibraryStore().byId['source-1']?.peaks.length).toBeGreaterThan(0)
  })
})

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import {
  requestStemSeparationForClip,
  requestStemSeparationForLibraryItem,
  useStemSelection,
  toggleStemSelection,
  setStemQuality,
  confirmStemSelection,
  cancelStemSelection,
  confirmModelDownload,
  cancelModelFlow,
  useStemModelFlow
} from '@/lib/stems/stemSeparationFlow'
import { clearStemSeparationState, snapshotStemSeparationState } from '@/lib/stemSeparationState'

const sendMock = vi.fn()
vi.mock('@/lib/bridgeService', () => ({ send: (...args: unknown[]) => sendMock(...args) }))
vi.mock('@/lib/log', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }))

const registerStemJob = vi.fn()
vi.mock('@/lib/stems/createStemTracks', () => ({
  registerStemJob: (...args: unknown[]) => registerStemJob(...args),
  // The real helper walks saved-clips up to their source; tests pass the source
  // id directly, so echo it back.
  resolveSourceItemId: (_library: unknown, itemId: string | undefined) => itemId
}))

const pushInfo = vi.fn()
const pushError = vi.fn()
vi.mock('@/stores/notificationsStore', () => ({
  useNotificationsStore: () => ({ pushInfo, pushError })
}))
vi.mock('@/stores/projectStore', () => ({
  useProjectStore: () => ({
    clips: { c1: { libraryItemId: 'i1', fileName: 'song.wav', startMs: 4000 } }
  })
}))
vi.mock('@/stores/libraryStore', () => ({
  useLibraryStore: () => ({
    byId: { i1: { id: 'i1', fileName: 'song.wav' } },
    getItem: (id: string) => (id === 'i1' ? { id, fileName: 'song.wav' } : null)
  }),
  libraryItemDisplayName: (item: { fileName: string }) => item.fileName
}))

type ProgressHandler = (p: {
  receivedBytes: number
  totalBytes: number
  fileName: string
  fileIndex: number
  fileCount: number
}) => void

let progressHandler: ProgressHandler | null = null
const api = {
  getStemModelState: vi.fn(),
  getStemModelDir: vi.fn(async () => 'C:\\models\\htdemucs-ft'),
  ensureStemModel: vi.fn(),
  cancelStemModelDownload: vi.fn(),
  onStemModelDownloadProgress: vi.fn((handler: ProgressHandler) => {
    progressHandler = handler
    return () => {
      progressHandler = null
    }
  })
}

const ALL_STEMS = ['vocals', 'drums', 'bass', 'other']

/** Start a clip separation and click Start with all four stems still ticked. */
async function startClipSeparation(): Promise<void> {
  requestStemSeparationForClip('c1')
  await confirmStemSelection()
}

beforeEach(() => {
  vi.clearAllMocks()
  clearStemSeparationState()
  cancelStemSelection()
  cancelModelFlow()
  progressHandler = null
  vi.stubGlobal('window', { silverdaw: api })
  vi.stubGlobal('crypto', { randomUUID: () => 'job-123' })
  api.getStemModelDir.mockResolvedValue('C:\\models\\htdemucs-ft')
})

afterEach(() => {
  cancelStemSelection()
  cancelModelFlow()
  clearStemSeparationState()
})

describe('stem selection dialog', () => {
  it('opens with all stems ticked and a stripped source name', () => {
    requestStemSeparationForClip('c1')
    const selection = useStemSelection().value
    expect(selection?.target).toMatchObject({
      sourceItemId: 'i1',
      sourceName: 'song',
      clipId: 'c1',
      startMs: 4000
    })
    expect(selection?.selected).toEqual({ vocals: true, drums: true, bass: true, other: true })
    expect(selection?.quality).toBe('balanced')
  })

  it('cancel dismisses without dispatching', () => {
    requestStemSeparationForClip('c1')
    cancelStemSelection()
    expect(useStemSelection().value).toBeNull()
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('a library request omits clip placement fields', () => {
    requestStemSeparationForLibraryItem('i1')
    const selection = useStemSelection().value
    expect(selection?.target.sourceItemId).toBe('i1')
    expect(selection?.target.clipId).toBeUndefined()
    expect(selection?.target.startMs).toBeUndefined()
  })

  it('dispatches only the ticked stems', async () => {
    api.getStemModelState.mockResolvedValue({
      installed: true,
      presentBytes: 100,
      totalBytes: 100,
      fileCount: 4
    })
    requestStemSeparationForClip('c1')
    toggleStemSelection('bass')
    toggleStemSelection('other')
    await confirmStemSelection()

    expect(sendMock).toHaveBeenCalledWith('STEM_SEPARATE', {
      jobId: 'job-123',
      sourceItemId: 'i1',
      clipId: 'c1',
      modelDir: 'C:\\models\\htdemucs-ft',
      sourceName: 'song',
      stems: ['vocals', 'drums'],
      quality: 'balanced'
    })
  })

  it('dispatches the chosen quality preset', async () => {
    api.getStemModelState.mockResolvedValue({
      installed: true,
      presentBytes: 100,
      totalBytes: 100,
      fileCount: 4
    })
    requestStemSeparationForClip('c1')
    setStemQuality('best')
    await confirmStemSelection()

    expect(sendMock).toHaveBeenCalledWith(
      'STEM_SEPARATE',
      expect.objectContaining({ quality: 'best' })
    )
  })

  it('does not start when no stem is ticked', async () => {
    requestStemSeparationForClip('c1')
    for (const stem of ALL_STEMS) toggleStemSelection(stem as never)
    await confirmStemSelection()
    expect(sendMock).not.toHaveBeenCalled()
    // The dialog stays open so the user can re-tick.
    expect(useStemSelection().value).not.toBeNull()
  })
})

describe('stemSeparationFlow', () => {
  it('dispatches immediately when the model is already installed', async () => {
    api.getStemModelState.mockResolvedValue({
      installed: true,
      presentBytes: 100,
      totalBytes: 100,
      fileCount: 4
    })

    await startClipSeparation()

    expect(useStemModelFlow().value).toBeNull()
    expect(registerStemJob).toHaveBeenCalledWith('job-123', expect.objectContaining({ clipId: 'c1' }))
    expect(sendMock).toHaveBeenCalledWith('STEM_SEPARATE', {
      jobId: 'job-123',
      sourceItemId: 'i1',
      clipId: 'c1',
      modelDir: 'C:\\models\\htdemucs-ft',
      sourceName: 'song',
      stems: ALL_STEMS,
      quality: 'balanced'
    })
    expect(snapshotStemSeparationState()?.jobId).toBe('job-123')
  })

  it('opens the confirm flow when the model is absent', async () => {
    api.getStemModelState.mockResolvedValue({
      installed: false,
      presentBytes: 0,
      totalBytes: 1200,
      fileCount: 4
    })

    await startClipSeparation()

    const flow = useStemModelFlow().value
    expect(flow?.phase).toBe('confirm')
    expect(flow?.totalBytes).toBe(1200)
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('downloads then dispatches on confirm', async () => {
    api.getStemModelState.mockResolvedValue({
      installed: false,
      presentBytes: 0,
      totalBytes: 1200,
      fileCount: 4
    })
    api.ensureStemModel.mockImplementation(async () => {
      progressHandler?.({
        receivedBytes: 600,
        totalBytes: 1200,
        fileName: 'htdemucs_ft_bass.onnx',
        fileIndex: 1,
        fileCount: 4
      })
      return { ok: true }
    })

    await startClipSeparation()
    await confirmModelDownload()

    expect(useStemModelFlow().value).toBeNull()
    expect(sendMock).toHaveBeenCalledWith('STEM_SEPARATE', {
      jobId: 'job-123',
      sourceItemId: 'i1',
      clipId: 'c1',
      modelDir: 'C:\\models\\htdemucs-ft',
      sourceName: 'song',
      stems: ALL_STEMS,
      quality: 'balanced'
    })
  })

  it('surfaces an error when the download fails', async () => {
    api.getStemModelState.mockResolvedValue({
      installed: false,
      presentBytes: 0,
      totalBytes: 1200,
      fileCount: 4
    })
    api.ensureStemModel.mockResolvedValue({ ok: false, error: 'integrity check failed' })

    await startClipSeparation()
    await confirmModelDownload()

    const flow = useStemModelFlow().value
    expect(flow?.phase).toBe('error')
    expect(flow?.error).toBe('integrity check failed')
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('cancel during download aborts and clears the flow', async () => {
    api.getStemModelState.mockResolvedValue({
      installed: false,
      presentBytes: 0,
      totalBytes: 1200,
      fileCount: 4
    })
    let resolveEnsure: (v: { ok: false; error: string }) => void = () => {}
    api.ensureStemModel.mockImplementation(
      () =>
        new Promise<{ ok: false; error: string }>((resolve) => {
          resolveEnsure = resolve
        })
    )

    await startClipSeparation()
    const confirming = confirmModelDownload()
    expect(useStemModelFlow().value?.phase).toBe('downloading')

    cancelModelFlow()
    expect(api.cancelStemModelDownload).toHaveBeenCalled()
    expect(useStemModelFlow().value).toBeNull()

    resolveEnsure({ ok: false, error: 'download aborted' })
    await confirming
    // Cancel already nulled the flow; the late error must not resurrect it.
    expect(useStemModelFlow().value).toBeNull()
  })

  it('ignores a request while a separation is already running', async () => {
    api.getStemModelState.mockResolvedValue({
      installed: true,
      presentBytes: 100,
      totalBytes: 100,
      fileCount: 4
    })
    await startClipSeparation()
    sendMock.mockClear()

    requestStemSeparationForClip('c1')
    expect(useStemSelection().value).toBeNull()
    expect(pushInfo).toHaveBeenCalledWith('A stem separation is already running.')
    expect(sendMock).not.toHaveBeenCalled()
  })
})

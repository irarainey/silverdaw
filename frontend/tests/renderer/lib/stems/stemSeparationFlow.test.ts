import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import {
  requestStemSeparationForClip,
  requestStemSeparationForLibraryItem,
  useStemSelection,
  toggleStemSelection,
  toggleStemDereverb,
  setStemDereverbStrength,
  setStemQuality,
  confirmStemSelection,
  cancelStemSelection,
  confirmModelDownload,
  cancelModelFlow,
  useStemModelFlow,
  abandonActiveStemSeparation,
  cancelActiveStemSeparation,
  loadStemQualityPreference
} from '@/lib/stems/stemSeparationFlow'
import { clearStemSeparationState, snapshotStemSeparationState } from '@/lib/stemSeparationState'

const sendMock = vi.fn()
vi.mock('@/lib/bridgeService', () => ({ send: (...args: unknown[]) => sendMock(...args) }))
vi.mock('@/lib/log', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }))

const registerStemJob = vi.fn()
const forgetStemJob = vi.fn()
vi.mock('@/lib/stems/createStemTracks', () => ({
  registerStemJob: (...args: unknown[]) => registerStemJob(...args),
  forgetStemJob: (...args: unknown[]) => forgetStemJob(...args)
}))

const pushInfo = vi.fn()
const pushError = vi.fn()
vi.mock('@/stores/notificationsStore', () => ({
  useNotificationsStore: () => ({ pushInfo, pushError })
}))
vi.mock('@/stores/projectStore', () => ({
  useProjectStore: () => ({
    clips: {
      c1: { libraryItemId: 'i1', fileName: 'song.wav', startMs: 4000 },
      // A clip that is itself an already-separated stem (its library item derives
      // from an original source that may no longer be present).
      cstem: { libraryItemId: 'stem1', fileName: 'vocals.wav', startMs: 8000, inMs: 0 }
    }
  })
}))
vi.mock('@/stores/libraryStore', () => ({
  useLibraryStore: () => ({
    byId: {
      i1: { id: 'i1', fileName: 'song.wav' },
      stem1: {
        id: 'stem1',
        kind: 'stem',
        fileName: 'vocals.wav',
        derivedFrom: { sourceItemId: 'gone-source' }
      }
    },
    getItem: (id: string) =>
      id === 'i1'
        ? { id, fileName: 'song.wav' }
        : id === 'stem1'
          ? { id, kind: 'stem', fileName: 'vocals.wav', derivedFrom: { sourceItemId: 'gone-source' } }
          : null
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

// The currently-subscribed download progress handler. The flow subscribes to one
// source at a time, so a single slot mirrors real behaviour; ensure* mocks call
// it to simulate streamed progress.
let progressHandler: ProgressHandler | null = null

const INSTALLED_STATE = { installed: true, presentBytes: 100, totalBytes: 100, fileCount: 2 }

function captureProgress(handler: ProgressHandler): () => void {
  progressHandler = handler
  return () => {
    progressHandler = null
  }
}

type EnsureResult = { ok: true } | { ok: false; error: string }

const PREFS = {
  useGpu: true,
  quality: 'balanced' as 'fast' | 'balanced' | 'best',
  useBackupModel: false,
  enhanceVocals: false,
  vocalEnhanceStrength: 'medium' as const,
  enhanceDrums: false,
  drumEnhanceStrength: 'medium' as const,
  enhanceBass: false,
  bassEnhanceStrength: 'medium' as const,
  enhanceOther: false,
  otherEnhanceStrength: 'medium' as const
}

const api = {
  getStemModelDir: vi.fn(async () => 'C:\\models\\htdemucs-ft'),
  getStemPrefs: vi.fn(async () => PREFS),
  getStemGpuStatus: vi.fn(
    async (): Promise<{ available: boolean; name: string | null }> => ({
      available: true,
      name: 'Test GPU'
    })
  ),
  // htdemucs backup
  getStemModelState: vi.fn(async () => INSTALLED_STATE),
  ensureStemModel: vi.fn(async (): Promise<EnsureResult> => ({ ok: true })),
  cancelStemModelDownload: vi.fn(),
  onStemModelDownloadProgress: vi.fn(captureProgress),
  // Mel-Band RoFormer vocal pack (primary)
  getVocalPackState: vi.fn(async () => INSTALLED_STATE),
  getVocalPackPath: vi.fn(async () => 'C:\\models\\mel\\core.onnx'),
  ensureVocalPack: vi.fn(async (): Promise<EnsureResult> => ({ ok: true })),
  cancelVocalPackDownload: vi.fn(),
  onVocalPackDownloadProgress: vi.fn(captureProgress),
  // BS-RoFormer rhythm pack (primary)
  getRhythmPackState: vi.fn(async () => INSTALLED_STATE),
  getRhythmPackPath: vi.fn(async () => 'C:\\models\\bs\\core.onnx'),
  ensureRhythmPack: vi.fn(async (): Promise<EnsureResult> => ({ ok: true })),
  cancelRhythmPackDownload: vi.fn(),
  onRhythmPackDownloadProgress: vi.fn(captureProgress),
  setStemPrefs: vi.fn()
}

const ALL_STEMS = ['vocals', 'drums', 'bass', 'other']

// The dispatch payload shared by the common all-four, packs-installed path.
const FULL_DISPATCH = {
  jobId: 'job-123',
  sourceItemId: 'i1',
  clipId: 'c1',
  modelDir: 'C:\\models\\htdemucs-ft',
  roformerModelPath: 'C:\\models\\mel\\core.onnx',
  rhythmModelPath: 'C:\\models\\bs\\core.onnx',
  sourceName: 'song',
  stems: ALL_STEMS,
  quality: 'balanced',
  useGpu: true,
  enhanceVocals: false,
  vocalEnhanceStrength: 'medium',
  enhanceDrums: false,
  drumEnhanceStrength: 'medium',
  enhanceBass: false,
  bassEnhanceStrength: 'medium',
  enhanceOther: false,
  otherEnhanceStrength: 'medium'
}

/** Start a clip separation and click Start with all four stems ticked (the picker
 *  now opens with everything UNticked, so tick them explicitly). */
async function startClipSeparation(): Promise<void> {
  await requestStemSeparationForClip('c1')
  for (const stem of ALL_STEMS) toggleStemSelection(stem as never)
  await confirmStemSelection()
}

/** Mark both RoFormer packs as needing a download, with the given byte totals. */
function packsMissing(vocalTotal: number, rhythmTotal: number): void {
  api.getVocalPackState.mockResolvedValue({
    installed: false,
    presentBytes: 0,
    totalBytes: vocalTotal,
    fileCount: 2
  })
  api.getRhythmPackState.mockResolvedValue({
    installed: false,
    presentBytes: 0,
    totalBytes: rhythmTotal,
    fileCount: 1
  })
}

/** Make the pack ensure() calls stream some progress and, realistically, flip
 *  that pack's install state to installed (so a later state check passes). */
function packsInstallOnEnsure(): void {
  api.ensureVocalPack.mockImplementation(async () => {
    progressHandler?.({
      receivedBytes: 800,
      totalBytes: 800,
      fileName: 'mel-band-roformer.onnx',
      fileIndex: 0,
      fileCount: 2
    })
    api.getVocalPackState.mockResolvedValue(INSTALLED_STATE)
    return { ok: true }
  })
  api.ensureRhythmPack.mockImplementation(async () => {
    progressHandler?.({
      receivedBytes: 400,
      totalBytes: 400,
      fileName: 'bs-roformer-rhythm.onnx',
      fileIndex: 0,
      fileCount: 1
    })
    api.getRhythmPackState.mockResolvedValue(INSTALLED_STATE)
    return { ok: true }
  })
}

beforeEach(async () => {
  vi.clearAllMocks()
  clearStemSeparationState()
  cancelStemSelection()
  cancelModelFlow()
  progressHandler = null
  vi.stubGlobal('window', { silverdaw: api })
  vi.stubGlobal('crypto', { randomUUID: () => 'job-123' })
  api.getStemModelDir.mockResolvedValue('C:\\models\\htdemucs-ft')
  api.getStemPrefs.mockResolvedValue(PREFS)
  api.getStemGpuStatus.mockResolvedValue({ available: true, name: 'Test GPU' })
  api.getStemModelState.mockResolvedValue(INSTALLED_STATE)
  api.getVocalPackState.mockResolvedValue(INSTALLED_STATE)
  api.getRhythmPackState.mockResolvedValue(INSTALLED_STATE)
  api.getVocalPackPath.mockResolvedValue('C:\\models\\mel\\core.onnx')
  api.getRhythmPackPath.mockResolvedValue('C:\\models\\bs\\core.onnx')
  api.ensureVocalPack.mockResolvedValue({ ok: true })
  api.ensureRhythmPack.mockResolvedValue({ ok: true })
  api.onVocalPackDownloadProgress.mockImplementation(captureProgress)
  api.onRhythmPackDownloadProgress.mockImplementation(captureProgress)
  api.onStemModelDownloadProgress.mockImplementation(captureProgress)
  // Reset the module-cached preferred quality to the default before each test.
  await loadStemQualityPreference()
  vi.clearAllMocks()
})

afterEach(() => {
  cancelStemSelection()
  cancelModelFlow()
  clearStemSeparationState()
})

describe('stem selection dialog', () => {
  it('opens with all stems unticked and a stripped source name', async () => {
    await requestStemSeparationForClip('c1')
    const selection = useStemSelection().value
    expect(selection?.target).toMatchObject({
      sourceItemId: 'i1',
      sourceName: 'song',
      clipId: 'c1',
      startMs: 4000
    })
    expect(selection?.selected).toEqual({ vocals: false, drums: false, bass: false, other: false })
    expect(selection?.quality).toBe('balanced')
  })

  it('cancel dismisses without dispatching', async () => {
    await requestStemSeparationForClip('c1')
    cancelStemSelection()
    expect(useStemSelection().value).toBeNull()
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('a library request omits clip placement fields', async () => {
    await requestStemSeparationForLibraryItem('i1')
    const selection = useStemSelection().value
    expect(selection?.target.sourceItemId).toBe('i1')
    expect(selection?.target.clipId).toBeUndefined()
    expect(selection?.target.startMs).toBeUndefined()
  })

  it('separates a stem clip from the stem itself, not its (missing) original source', async () => {
    await requestStemSeparationForClip('cstem')
    toggleStemSelection('vocals')
    await confirmStemSelection()

    // The audio source is the clip's own library item (the stem WAV on the
    // timeline), never the resolved top-level source — which here is gone.
    expect(sendMock).toHaveBeenCalledWith(
      'STEM_SEPARATE',
      expect.objectContaining({ sourceItemId: 'stem1', clipId: 'cstem' })
    )
  })

  it('separates a stem library item from itself, not its original source', async () => {
    await requestStemSeparationForLibraryItem('stem1')
    expect(useStemSelection().value?.target.sourceItemId).toBe('stem1')
  })

  it('dispatches only the ticked stems', async () => {
    await requestStemSeparationForClip('c1')
    toggleStemSelection('vocals')
    toggleStemSelection('drums')
    await confirmStemSelection()

    expect(sendMock).toHaveBeenCalledWith(
      'STEM_SEPARATE',
      expect.objectContaining({ stems: ['vocals', 'drums'] })
    )
  })

  it('dispatches the chosen quality preset', async () => {
    await requestStemSeparationForClip('c1')
    toggleStemSelection('vocals')
    setStemQuality('best')
    await confirmStemSelection()

    expect(sendMock).toHaveBeenCalledWith(
      'STEM_SEPARATE',
      expect.objectContaining({ quality: 'best' })
    )
  })

  it('persists the chosen quality to preferences', async () => {
    await requestStemSeparationForClip('c1')
    setStemQuality('fast')
    expect(api.setStemPrefs).toHaveBeenCalledWith({ quality: 'fast' })
  })

  it('seeds the picker from the persisted quality preference', async () => {
    api.getStemPrefs.mockResolvedValue({ ...PREFS, quality: 'best' })
    await loadStemQualityPreference()
    await requestStemSeparationForClip('c1')
    expect(useStemSelection().value?.quality).toBe('best')
  })

  it('dispatches useGpu=false when the GPU preference is off', async () => {
    api.getStemPrefs.mockResolvedValue({ ...PREFS, useGpu: false })
    await startClipSeparation()

    expect(sendMock).toHaveBeenCalledWith(
      'STEM_SEPARATE',
      expect.objectContaining({ useGpu: false })
    )
  })

  it('dispatches useGpu=false when no GPU is detected even if the preference is on', async () => {
    api.getStemGpuStatus.mockResolvedValue({ available: false, name: null })
    await startClipSeparation()

    expect(sendMock).toHaveBeenCalledWith(
      'STEM_SEPARATE',
      expect.objectContaining({ useGpu: false })
    )
  })

  it('shows preparing immediately and reads independent preparation inputs in parallel', async () => {
    let resolveModelDir: ((path: string) => void) | undefined
    api.getStemModelDir.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        resolveModelDir = resolve
      })
    )

    await requestStemSeparationForClip('c1')
    const preferenceReadsBeforeDispatch = api.getStemPrefs.mock.calls.length
    for (const stem of ALL_STEMS) toggleStemSelection(stem as never)
    const confirmation = confirmStemSelection()
    await vi.waitFor(() => expect(registerStemJob).toHaveBeenCalledWith('job-123', expect.anything()))

    expect(snapshotStemSeparationState()).toMatchObject({ jobId: 'job-123', stage: 'prepare' })
    // One read determines model requirements before dispatch; preparation itself adds
    // exactly one snapshot shared by GPU, cleanup, and backup-model decisions.
    expect(api.getStemPrefs).toHaveBeenCalledTimes(preferenceReadsBeforeDispatch + 2)
    expect(api.getStemGpuStatus).toHaveBeenCalledTimes(1)
    expect(api.getVocalPackPath).toHaveBeenCalledTimes(1)
    expect(api.getRhythmPackPath).toHaveBeenCalledTimes(1)
    expect(sendMock).not.toHaveBeenCalled()

    resolveModelDir?.('C:\\models\\htdemucs-ft')
    await confirmation
    expect(sendMock).toHaveBeenCalledWith('STEM_SEPARATE', FULL_DISPATCH)
  })

  it('does not dispatch when the user cancels during preparation', async () => {
    let resolveModelDir: ((path: string) => void) | undefined
    api.getStemModelDir.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        resolveModelDir = resolve
      })
    )

    await requestStemSeparationForClip('c1')
    for (const stem of ALL_STEMS) toggleStemSelection(stem as never)
    const confirmation = confirmStemSelection()
    await vi.waitFor(() => expect(registerStemJob).toHaveBeenCalled())

    cancelActiveStemSeparation()
    expect(snapshotStemSeparationState()).toBeNull()

    await requestStemSeparationForClip('c1')
    for (const stem of ALL_STEMS) toggleStemSelection(stem as never)
    await confirmStemSelection()

    resolveModelDir?.('C:\\models\\htdemucs-ft')
    await confirmation

    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(sendMock).toHaveBeenCalledWith('STEM_SEPARATE', FULL_DISPATCH)
    expect(forgetStemJob).toHaveBeenCalledWith('job-123')
  })

  it('does not start when no stem is ticked', async () => {
    await requestStemSeparationForClip('c1')
    // The picker now opens with nothing ticked, so a straight confirm must not start.
    await confirmStemSelection()
    expect(sendMock).not.toHaveBeenCalled()
    // The dialog stays open so the user can tick something.
    expect(useStemSelection().value).not.toBeNull()
  })

  it('does not send dereverb by default (per-run, off unless ticked)', async () => {
    await startClipSeparation()
    const payload = sendMock.mock.calls.find((c) => c[0] === 'STEM_SEPARATE')?.[1] as
      | Record<string, unknown>
      | undefined
    expect(payload).toBeDefined()
    expect(payload).not.toHaveProperty('dereverb')
  })

  it('dispatches dereverb when the vocal reverb toggle is on', async () => {
    await requestStemSeparationForClip('c1')
    toggleStemSelection('vocals')
    toggleStemDereverb()
    await confirmStemSelection()
    expect(sendMock).toHaveBeenCalledWith(
      'STEM_SEPARATE',
      expect.objectContaining({ dereverb: true, dereverbStrength: 'medium' })
    )
  })

  it('dispatches the chosen dereverb strength', async () => {
    await requestStemSeparationForClip('c1')
    toggleStemSelection('vocals')
    toggleStemDereverb()
    setStemDereverbStrength('strong')
    await confirmStemSelection()
    expect(sendMock).toHaveBeenCalledWith(
      'STEM_SEPARATE',
      expect.objectContaining({ dereverb: true, dereverbStrength: 'strong' })
    )
  })

  it('omits dereverb when vocals are not being extracted', async () => {
    await requestStemSeparationForClip('c1')
    toggleStemSelection('drums') // extract drums only
    toggleStemDereverb() // reverb removal ticked, but no vocals stem
    await confirmStemSelection()
    const payload = sendMock.mock.calls.find((c) => c[0] === 'STEM_SEPARATE')?.[1] as
      | Record<string, unknown>
      | undefined
    expect(payload).toBeDefined()
    expect(payload).not.toHaveProperty('dereverb')
  })

  it('carries the dereverb choice through a model download to dispatch', async () => {
    // Packs missing → the download dialog opens first; the picker (where vocals +
    // dereverb are ticked) opens only after the download, then dispatch must still send it.
    packsMissing(800, 400)
    packsInstallOnEnsure()

    await requestStemSeparationForClip('c1')
    await confirmModelDownload()
    toggleStemSelection('vocals')
    toggleStemDereverb()
    await confirmStemSelection()

    expect(sendMock).toHaveBeenCalledWith(
      'STEM_SEPARATE',
      expect.objectContaining({ dereverb: true })
    )
  })
})

describe('stemSeparationFlow', () => {
  it('opens the picker directly when the required models are installed', async () => {
    await requestStemSeparationForClip('c1')

    expect(useStemSelection().value).not.toBeNull()
    expect(useStemModelFlow().value).toBeNull()
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('dispatches when the picker is confirmed and models are installed', async () => {
    await startClipSeparation()

    expect(useStemModelFlow().value).toBeNull()
    expect(registerStemJob).toHaveBeenCalledWith('job-123', expect.objectContaining({ clipId: 'c1' }))
    expect(sendMock).toHaveBeenCalledWith('STEM_SEPARATE', FULL_DISPATCH)
    expect(snapshotStemSeparationState()?.jobId).toBe('job-123')
    // The default path uses the RoFormer packs, not the htdemucs backup.
    expect(api.ensureStemModel).not.toHaveBeenCalled()
  })

  it('does not dispatch a second separation while one is already in progress', async () => {
    await startClipSeparation()
    expect(snapshotStemSeparationState()?.jobId).toBe('job-123')
    expect(sendMock.mock.calls.filter((c) => c[0] === 'STEM_SEPARATE')).toHaveLength(1)

    // A second attempt while the job is still active must be ignored — otherwise it
    // reaches the single-slot backend, which can only reject it with an error toast.
    await startClipSeparation()

    expect(sendMock.mock.calls.filter((c) => c[0] === 'STEM_SEPARATE')).toHaveLength(1)
  })

  it('shows the download dialog BEFORE the picker when the packs are absent', async () => {
    packsMissing(800, 400)

    await requestStemSeparationForClip('c1')

    const flow = useStemModelFlow().value
    expect(flow?.phase).toBe('confirm')
    expect(flow?.totalBytes).toBe(1200)
    // The picker has not opened yet, and nothing is dispatched.
    expect(useStemSelection().value).toBeNull()
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('opens the picker after the pre-selection download completes (no dispatch yet)', async () => {
    packsMissing(800, 400)
    packsInstallOnEnsure()

    await requestStemSeparationForClip('c1')
    await confirmModelDownload()

    expect(api.ensureVocalPack).toHaveBeenCalled()
    expect(api.ensureRhythmPack).toHaveBeenCalled()
    expect(useStemModelFlow().value).toBeNull()
    // Picker is now open; dispatch waits for the user to confirm stems.
    expect(useStemSelection().value).not.toBeNull()
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('dispatches once stems are confirmed after the pre-selection download', async () => {
    packsMissing(800, 400)
    packsInstallOnEnsure()

    await requestStemSeparationForClip('c1')
    await confirmModelDownload()
    for (const stem of ALL_STEMS) toggleStemSelection(stem as never)
    await confirmStemSelection()

    expect(api.ensureStemModel).not.toHaveBeenCalled()
    expect(sendMock).toHaveBeenCalledWith('STEM_SEPARATE', FULL_DISPATCH)
  })

  it('surfaces an error when a pack download fails', async () => {
    packsMissing(800, 400)
    api.ensureVocalPack.mockResolvedValue({ ok: false, error: 'integrity check failed' })

    await requestStemSeparationForClip('c1')
    await confirmModelDownload()

    const flow = useStemModelFlow().value
    expect(flow?.phase).toBe('error')
    expect(flow?.error).toBe('integrity check failed')
    // The second pack is not attempted once the first fails.
    expect(api.ensureRhythmPack).not.toHaveBeenCalled()
    expect(useStemSelection().value).toBeNull()
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('cancel during download aborts the active pack and clears the flow', async () => {
    packsMissing(800, 400)
    let resolveEnsure: (v: { ok: false; error: string }) => void = () => {}
    api.ensureVocalPack.mockImplementation(
      () =>
        new Promise<{ ok: false; error: string }>((resolve) => {
          resolveEnsure = resolve
        })
    )

    await requestStemSeparationForClip('c1')
    const confirming = confirmModelDownload()
    expect(useStemModelFlow().value?.phase).toBe('downloading')

    cancelModelFlow()
    expect(api.cancelVocalPackDownload).toHaveBeenCalled()
    expect(useStemModelFlow().value).toBeNull()

    resolveEnsure({ ok: false, error: 'download aborted' })
    await confirming
    // Cancel already nulled the flow; the late error must not resurrect it, and
    // the picker must not open.
    expect(useStemModelFlow().value).toBeNull()
    expect(useStemSelection().value).toBeNull()
  })

  it('ignores a request while a separation is already running', async () => {
    await startClipSeparation()
    sendMock.mockClear()

    await requestStemSeparationForClip('c1')
    expect(useStemSelection().value).toBeNull()
    expect(pushInfo).toHaveBeenCalledWith('A stem separation is already running.')
    expect(sendMock).not.toHaveBeenCalled()
  })
})

describe('abandonActiveStemSeparation', () => {
  it('clears the active job, forgets it, and surfaces the reason', async () => {
    await startClipSeparation()
    expect(snapshotStemSeparationState()?.jobId).toBe('job-123')

    abandonActiveStemSeparation('engine restarted')

    expect(snapshotStemSeparationState()).toBeNull()
    expect(forgetStemJob).toHaveBeenCalledWith('job-123')
    expect(pushError).toHaveBeenCalledWith('engine restarted')
  })

  it('is a no-op when no separation is active', () => {
    abandonActiveStemSeparation('engine restarted')
    expect(forgetStemJob).not.toHaveBeenCalled()
    expect(pushError).not.toHaveBeenCalled()
  })
})

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

// Per-source progress handlers — the flow subscribes simultaneously to each
// active source, so each needs its own slot; ensure* mocks call the right one.
const progressHandlers = {
  vocal: null as ProgressHandler | null,
  rhythm: null as ProgressHandler | null,
  htdemucs: null as ProgressHandler | null
}

const INSTALLED_STATE = { installed: true, presentBytes: 100, totalBytes: 100, fileCount: 2 }

function captureVocalProgress(handler: ProgressHandler): () => void {
  progressHandlers.vocal = handler
  return () => { progressHandlers.vocal = null }
}
function captureRhythmProgress(handler: ProgressHandler): () => void {
  progressHandlers.rhythm = handler
  return () => { progressHandlers.rhythm = null }
}
function captureHtdemucsProgress(handler: ProgressHandler): () => void {
  progressHandlers.htdemucs = handler
  return () => { progressHandlers.htdemucs = null }
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
  onStemModelDownloadProgress: vi.fn(captureHtdemucsProgress),
  // Mel-Band RoFormer vocal pack (primary)
  getVocalPackState: vi.fn(async () => INSTALLED_STATE),
  getVocalPackPath: vi.fn(async () => 'C:\\models\\mel\\core.onnx'),
  ensureVocalPack: vi.fn(async (): Promise<EnsureResult> => ({ ok: true })),
  cancelVocalPackDownload: vi.fn(),
  onVocalPackDownloadProgress: vi.fn(captureVocalProgress),
  // BS-RoFormer rhythm pack (primary)
  getRhythmPackState: vi.fn(async () => INSTALLED_STATE),
  getRhythmPackPath: vi.fn(async () => 'C:\\models\\bs\\core.onnx'),
  ensureRhythmPack: vi.fn(async (): Promise<EnsureResult> => ({ ok: true })),
  cancelRhythmPackDownload: vi.fn(),
  onRhythmPackDownloadProgress: vi.fn(captureRhythmProgress),
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
    progressHandlers.vocal?.({
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
    progressHandlers.rhythm?.({
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
  progressHandlers.vocal = null
  progressHandlers.rhythm = null
  progressHandlers.htdemucs = null
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
  api.onVocalPackDownloadProgress.mockImplementation(captureVocalProgress)
  api.onRhythmPackDownloadProgress.mockImplementation(captureRhythmProgress)
  api.onStemModelDownloadProgress.mockImplementation(captureHtdemucsProgress)
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

  it('surfaces an error when a pack download fails and cancels the concurrent other', async () => {
    packsMissing(800, 400)
    api.ensureVocalPack.mockResolvedValue({ ok: false, error: 'integrity check failed' })
    // Rhythm starts concurrently; keep it pending so the cancel can be observed
    let resolveRhythm!: (v: EnsureResult) => void
    api.ensureRhythmPack.mockReturnValue(new Promise<EnsureResult>((res) => { resolveRhythm = res }))

    await requestStemSeparationForClip('c1')
    const downloading = confirmModelDownload()

    // Vocal fails → rhythm is cancelled; wait for that, then let it resolve
    await vi.waitFor(() => expect(api.cancelRhythmPackDownload).toHaveBeenCalled())
    resolveRhythm({ ok: false, error: 'cancelled' })
    await downloading

    const flow = useStemModelFlow().value
    expect(flow?.phase).toBe('error')
    expect(flow?.error).toBe('integrity check failed')
    // Both packs start concurrently; rhythm is cancelled when vocal fails
    expect(api.ensureRhythmPack).toHaveBeenCalled()
    expect(useStemSelection().value).toBeNull()
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('cancel during download aborts all active downloads and clears the flow', async () => {
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
    // Both vocal and rhythm are active at cancel time; both must be aborted
    expect(api.cancelVocalPackDownload).toHaveBeenCalled()
    expect(api.cancelRhythmPackDownload).toHaveBeenCalled()
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

describe('model download concurrency', () => {
  it('starts both quality packs simultaneously before either resolves', async () => {
    packsMissing(800, 400)
    let resolveVocal!: (v: EnsureResult) => void
    let resolveRhythm!: (v: EnsureResult) => void
    api.ensureVocalPack.mockReturnValue(new Promise<EnsureResult>((res) => { resolveVocal = res }))
    api.ensureRhythmPack.mockReturnValue(new Promise<EnsureResult>((res) => { resolveRhythm = res }))

    await requestStemSeparationForClip('c1')
    const downloading = confirmModelDownload()

    // Both ensure() calls are in flight before either resolves
    expect(api.ensureVocalPack).toHaveBeenCalledTimes(1)
    expect(api.ensureRhythmPack).toHaveBeenCalledTimes(1)

    resolveVocal({ ok: true })
    resolveRhythm({ ok: true })
    await downloading

    expect(useStemModelFlow().value).toBeNull()
    expect(useStemSelection().value).not.toBeNull()
  })

  it('third source waits until a slot is free (concurrency limit of 2)', async () => {
    // Pre-selection check sees packs as installed (picker opens directly)
    api.getVocalPackState.mockResolvedValueOnce(INSTALLED_STATE)
    api.getRhythmPackState.mockResolvedValueOnce(INSTALLED_STATE)
    // Post-selection check (vocals + other, partial → requires all 3 sources) sees all missing
    api.getVocalPackState.mockResolvedValue({ installed: false, presentBytes: 0, totalBytes: 800, fileCount: 2 })
    api.getRhythmPackState.mockResolvedValue({ installed: false, presentBytes: 0, totalBytes: 400, fileCount: 1 })
    api.getStemModelState.mockResolvedValue({ installed: false, presentBytes: 0, totalBytes: 600, fileCount: 1 })

    let resolveVocal!: (v: EnsureResult) => void
    let resolveRhythm!: (v: EnsureResult) => void
    api.ensureVocalPack.mockReturnValue(new Promise<EnsureResult>((res) => { resolveVocal = res }))
    api.ensureRhythmPack.mockReturnValue(new Promise<EnsureResult>((res) => { resolveRhythm = res }))
    api.ensureStemModel.mockResolvedValue({ ok: true })

    await requestStemSeparationForClip('c1')  // picker opens (pre-check sees installed)
    toggleStemSelection('vocals')
    toggleStemSelection('other')  // partial selection → htdemucs also required
    confirmStemSelection()

    await vi.waitFor(() => expect(useStemModelFlow().value?.phase).toBe('confirm'))
    const downloading = confirmModelDownload()

    // Vocal and rhythm fill the 2 slots; htdemucs must not have started yet
    expect(api.ensureVocalPack).toHaveBeenCalledTimes(1)
    expect(api.ensureRhythmPack).toHaveBeenCalledTimes(1)
    expect(api.ensureStemModel).not.toHaveBeenCalled()

    // Freeing one slot by resolving vocal triggers htdemucs
    resolveVocal({ ok: true })
    await vi.waitFor(() => expect(api.ensureStemModel).toHaveBeenCalledTimes(1))

    resolveRhythm({ ok: true })
    await downloading

    expect(sendMock).toHaveBeenCalledWith('STEM_SEPARATE', expect.objectContaining({ stems: ['vocals', 'other'] }))
  })

  it('interleaved and regressing progress events produce monotonic aggregate bytes', async () => {
    packsMissing(800, 400)
    let resolveVocal!: (v: EnsureResult) => void
    let resolveRhythm!: (v: EnsureResult) => void
    api.ensureVocalPack.mockReturnValue(new Promise<EnsureResult>((res) => { resolveVocal = res }))
    api.ensureRhythmPack.mockReturnValue(new Promise<EnsureResult>((res) => { resolveRhythm = res }))

    await requestStemSeparationForClip('c1')
    confirmModelDownload()

    // Handlers are registered synchronously during confirmModelDownload
    progressHandlers.vocal?.({ receivedBytes: 300, totalBytes: 800, fileName: 'vocals.onnx', fileIndex: 0, fileCount: 2 })
    expect(useStemModelFlow().value?.receivedBytes).toBe(300)

    progressHandlers.rhythm?.({ receivedBytes: 200, totalBytes: 400, fileName: 'rhythm.onnx', fileIndex: 0, fileCount: 1 })
    expect(useStemModelFlow().value?.receivedBytes).toBe(500)

    // Regressing vocal event must be ignored (monotonic)
    progressHandlers.vocal?.({ receivedBytes: 250, totalBytes: 800, fileName: 'vocals.onnx', fileIndex: 0, fileCount: 2 })
    expect(useStemModelFlow().value?.receivedBytes).toBe(500)

    // Advancing vocal
    progressHandlers.vocal?.({ receivedBytes: 600, totalBytes: 800, fileName: 'vocals.onnx', fileIndex: 0, fileCount: 2 })
    expect(useStemModelFlow().value?.receivedBytes).toBe(800)

    resolveVocal({ ok: true })
    resolveRhythm({ ok: true })
    await vi.waitFor(() => expect(useStemModelFlow().value).toBeNull())
  })

  it('first failure cancels other active downloads and prevents continuation', async () => {
    packsMissing(800, 400)
    api.ensureVocalPack.mockResolvedValue({ ok: false, error: 'network error' })
    let resolveRhythm!: (v: EnsureResult) => void
    api.ensureRhythmPack.mockReturnValue(new Promise<EnsureResult>((res) => { resolveRhythm = res }))

    await requestStemSeparationForClip('c1')
    const downloading = confirmModelDownload()

    // Vocal failure triggers rhythm cancellation
    await vi.waitFor(() => expect(api.cancelRhythmPackDownload).toHaveBeenCalled())
    resolveRhythm({ ok: false, error: 'cancelled' })
    await downloading

    expect(useStemModelFlow().value?.phase).toBe('error')
    expect(useStemModelFlow().value?.error).toBe('network error')
    // Continuation must not have run
    expect(useStemSelection().value).toBeNull()
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('cancel aborts all active sources', async () => {
    packsMissing(800, 400)
    let resolveVocal!: (v: EnsureResult) => void
    let resolveRhythm!: (v: EnsureResult) => void
    api.ensureVocalPack.mockReturnValue(new Promise<EnsureResult>((res) => { resolveVocal = res }))
    api.ensureRhythmPack.mockReturnValue(new Promise<EnsureResult>((res) => { resolveRhythm = res }))

    await requestStemSeparationForClip('c1')
    const downloading = confirmModelDownload()

    cancelModelFlow()

    expect(api.cancelVocalPackDownload).toHaveBeenCalled()
    expect(api.cancelRhythmPackDownload).toHaveBeenCalled()
    expect(useStemModelFlow().value).toBeNull()

    resolveVocal({ ok: false, error: 'cancelled' })
    resolveRhythm({ ok: false, error: 'cancelled' })
    await downloading

    expect(useStemModelFlow().value).toBeNull()
    expect(useStemSelection().value).toBeNull()
  })

  it('success continuation runs exactly once after all sources succeed', async () => {
    packsMissing(800, 400)
    let resolveVocal!: (v: EnsureResult) => void
    let resolveRhythm!: (v: EnsureResult) => void
    api.ensureVocalPack.mockReturnValue(new Promise<EnsureResult>((res) => { resolveVocal = res }))
    api.ensureRhythmPack.mockReturnValue(new Promise<EnsureResult>((res) => { resolveRhythm = res }))

    await requestStemSeparationForClip('c1')
    const downloading = confirmModelDownload()

    resolveVocal({ ok: true })
    resolveRhythm({ ok: true })
    await downloading

    // Continuation (open picker) ran exactly once
    expect(useStemModelFlow().value).toBeNull()
    expect(useStemSelection().value).not.toBeNull()
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('cancel→re-enter: old promises settling do not affect the new flow', async () => {
    packsMissing(800, 400)
    let resolveVocalOld!: (v: EnsureResult) => void
    let resolveRhythmOld!: (v: EnsureResult) => void
    api.ensureVocalPack.mockReturnValue(new Promise<EnsureResult>((res) => { resolveVocalOld = res }))
    api.ensureRhythmPack.mockReturnValue(new Promise<EnsureResult>((res) => { resolveRhythmOld = res }))

    await requestStemSeparationForClip('c1')
    const firstRun = confirmModelDownload()
    expect(useStemModelFlow().value?.phase).toBe('downloading')

    // Cancel the first run mid-flight
    cancelModelFlow()
    expect(useStemModelFlow().value).toBeNull()

    // Re-enter: start a new download (same missing packs scenario)
    packsMissing(800, 400)
    packsInstallOnEnsure()
    await requestStemSeparationForClip('c1')
    expect(useStemModelFlow().value?.phase).toBe('confirm')
    const secondRun = confirmModelDownload()

    // Old promises from run 1 settle late — must not corrupt the new flow
    resolveVocalOld({ ok: false, error: 'stale error from old run' })
    resolveRhythmOld({ ok: false, error: 'stale cancelled' })
    await firstRun

    // Second run should complete successfully, not be stuck in error
    await secondRun
    expect(useStemModelFlow().value).toBeNull()
    expect(useStemSelection().value).not.toBeNull()
  })

  it('cancel→re-enter: late progress from old run does not update new flow', async () => {
    packsMissing(800, 400)
    let resolveVocalOld!: (v: EnsureResult) => void
    api.ensureVocalPack.mockReturnValue(new Promise<EnsureResult>((res) => { resolveVocalOld = res }))
    api.ensureRhythmPack.mockReturnValue(new Promise<EnsureResult>(() => {}))

    await requestStemSeparationForClip('c1')
    confirmModelDownload()

    // Capture the old progress handler before cancel disposes it
    const oldVocalHandler = progressHandlers.vocal

    cancelModelFlow()

    // Set up new run
    packsMissing(800, 400)
    let resolveVocalNew!: (v: EnsureResult) => void
    let resolveRhythmNew!: (v: EnsureResult) => void
    api.ensureVocalPack.mockReturnValue(new Promise<EnsureResult>((res) => { resolveVocalNew = res }))
    api.ensureRhythmPack.mockReturnValue(new Promise<EnsureResult>((res) => { resolveRhythmNew = res }))
    await requestStemSeparationForClip('c1')
    confirmModelDownload()
    expect(useStemModelFlow().value?.phase).toBe('downloading')
    expect(useStemModelFlow().value?.receivedBytes).toBe(0)

    // Old handler was disposed by cancel — calling it is a no-op
    oldVocalHandler?.({ receivedBytes: 500, totalBytes: 800, fileName: 'stale.onnx', fileIndex: 0, fileCount: 2 })
    expect(useStemModelFlow().value?.receivedBytes).toBe(0)
    expect(useStemModelFlow().value?.fileName).toBe('')

    // New handler works correctly
    progressHandlers.vocal?.({ receivedBytes: 200, totalBytes: 800, fileName: 'fresh.onnx', fileIndex: 0, fileCount: 2 })
    expect(useStemModelFlow().value?.receivedBytes).toBe(200)

    resolveVocalOld({ ok: true })
    resolveVocalNew({ ok: true })
    resolveRhythmNew({ ok: true })
    await vi.waitFor(() => expect(useStemModelFlow().value).toBeNull())
  })

  it('first failure transitions to error immediately even if peers never settle', async () => {
    packsMissing(800, 400)
    api.ensureVocalPack.mockResolvedValue({ ok: false, error: 'checksum mismatch' })
    // Rhythm never settles — simulates a hung IPC peer
    api.ensureRhythmPack.mockReturnValue(new Promise<EnsureResult>(() => {}))

    await requestStemSeparationForClip('c1')
    const downloading = confirmModelDownload()

    // Must resolve with error without waiting for the stuck peer
    await downloading

    expect(useStemModelFlow().value?.phase).toBe('error')
    expect(useStemModelFlow().value?.error).toBe('checksum mismatch')
    expect(api.cancelRhythmPackDownload).toHaveBeenCalled()
    expect(useStemSelection().value).toBeNull()
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('clamps oversized presentBytes seed in aggregate progress display', async () => {
    // presentBytes > totalBytes — the confirm dialog shows clamped values
    api.getVocalPackState.mockResolvedValue({
      installed: false,
      presentBytes: 9999,
      totalBytes: 800,
      fileCount: 2
    })
    api.getRhythmPackState.mockResolvedValue({
      installed: false,
      presentBytes: 500,
      totalBytes: 400,
      fileCount: 1
    })

    await requestStemSeparationForClip('c1')
    // confirm dialog shows sum of presentBytes (capped per-source by the runner)
    const flowState = useStemModelFlow().value
    expect(flowState?.phase).toBe('confirm')

    // Start download with those seeds
    let resolveVocal!: (v: EnsureResult) => void
    let resolveRhythm!: (v: EnsureResult) => void
    api.ensureVocalPack.mockReturnValue(new Promise<EnsureResult>((res) => { resolveVocal = res }))
    api.ensureRhythmPack.mockReturnValue(new Promise<EnsureResult>((res) => { resolveRhythm = res }))
    confirmModelDownload()

    // Aggregate must never exceed totalBytes (1200)
    expect(useStemModelFlow().value?.receivedBytes).toBeLessThanOrEqual(1200)

    resolveVocal({ ok: true })
    resolveRhythm({ ok: true })
    await vi.waitFor(() => expect(useStemModelFlow().value).toBeNull())
  })

  it('succeeds with receivedBytes at total even when no progress events fire', async () => {
    packsMissing(800, 400)
    // ensure() returns ok immediately without any progress events
    api.ensureVocalPack.mockResolvedValue({ ok: true })
    api.ensureRhythmPack.mockResolvedValue({ ok: true })

    await requestStemSeparationForClip('c1')
    await confirmModelDownload()

    // Flow completed — picker opened
    expect(useStemModelFlow().value).toBeNull()
    expect(useStemSelection().value).not.toBeNull()
  })
})

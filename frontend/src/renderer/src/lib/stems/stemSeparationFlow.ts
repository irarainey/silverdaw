// Renderer-side lifecycle for starting a stem separation. Models come first: if
// the models a default separation needs aren't installed, the download dialog is
// shown before the stem picker, and the picker opens once they're downloaded.
// Two reactive refs drive two small dialogs:
//   • `flow` — the one-time model download (confirm, stream combined progress).
//     Its continuation opens the picker (pre-selection) or dispatches (a later
//     download of an extra model a chosen selection needs).
//   • `selection` — the stem-picker (which of the four stems to extract).
//     Cancellable; no-op while another separation runs.
// Once dispatched, the running job's progress lives in `stemSeparationState`.

import { ref, readonly, type Ref } from 'vue'
import { send as sendBridge } from '@/lib/bridgeService'
import {
  beginStemSeparation,
  clearStemSeparationState,
  snapshotStemSeparationState,
  type StemSeparationTarget
} from '@/lib/stemSeparationState'
import { forgetStemJob, registerStemJob } from '@/lib/stems/createStemTracks'
import { useProjectStore } from '@/stores/projectStore'
import { useLibraryStore, libraryItemDisplayName } from '@/stores/libraryStore'
import { useNotificationsStore } from '@/stores/notificationsStore'
import { log } from '@/lib/log'
import type { StemName, StemQuality, DereverbStrength } from '@shared/bridge-protocol'
import type {
  StemModelState,
  StemModelDownloadProgress,
  EnsureStemModelResult,
  StemPrefsDto
} from '@shared/types'

/** Canonical four-stem order; the selection dialog and dispatch use it. */
const ALL_STEMS: readonly StemName[] = ['vocals', 'drums', 'bass', 'other']

// ─── Stem-picker dialog ─────────────────────────────────────────────────────

export interface StemSelectionState {
  target: StemSeparationTarget
  /** Which stems are currently ticked; at least one is required to start. */
  selected: Record<StemName, boolean>
  /** Quality preset trading speed against separation smoothness. */
  quality: StemQuality
  /** Per-run: remove reverb/echo from the vocals stem. Chosen fresh each run (never
   *  persisted), so it defaults off every time the picker opens. */
  dereverb: boolean
  /** Per-run strength of that reverb removal (only meaningful when `dereverb`). */
  dereverbStrength: DereverbStrength
}

const selection: Ref<StemSelectionState | null> = ref(null)

// A token prevents duplicate preparation and invalidates pending IPC on cancellation.
let activePreparation: symbol | null = null

// The last-used separation quality, persisted with application preferences so the
// picker reopens on the user's choice instead of resetting each time. Cached in the
// module (and primed once at startup via loadStemQualityPreference) so the dialog can
// seed it synchronously when it opens; setStemQuality keeps it and the store in sync.
let preferredQuality: StemQuality = 'balanced'

const DEFAULT_STEM_PREFS: StemPrefsDto = {
  useGpu: false,
  quality: 'balanced',
  useBackupModel: false,
  enhanceVocals: false,
  vocalEnhanceStrength: 'medium',
  enhanceDrums: false,
  drumEnhanceStrength: 'medium',
  enhanceBass: false,
  bassEnhanceStrength: 'medium',
  enhanceOther: false,
  otherEnhanceStrength: 'medium'
}

export function useStemSelection(): Readonly<Ref<StemSelectionState | null>> {
  return readonly(selection)
}

/** Prime the cached quality preference from persisted app preferences. Call once at
 *  app startup; failures leave the default ('balanced') in place. */
export async function loadStemQualityPreference(): Promise<void> {
  try {
    const prefs = await window.silverdaw.getStemPrefs()
    preferredQuality = prefs.quality
  } catch (err) {
    log.warn(
      'stems',
      `loadStemQualityPreference failed, keeping default: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

/**
 * Abandon any in-flight separation, surfacing a clear error. Called when the
 * audio engine restarts mid-job (e.g. a GPU driver reset / TDR can crash the
 * backend before it can send STEM_FAILED), so the job never just vanishes from
 * the UI without explanation.
 */
export function abandonActiveStemSeparation(reason: string): void {
  const active = snapshotStemSeparationState()
  if (active === null) return
  forgetStemJob(active.jobId)
  clearStemSeparationState()
  useNotificationsStore().pushError(reason)
  log.warn('stems', `active separation abandoned jobId=${active.jobId}: ${reason}`)
}

export function cancelActiveStemSeparation(): void {
  const active = snapshotStemSeparationState()
  if (active === null) return
  if (activePreparation !== null) {
    activePreparation = null
    forgetStemJob(active.jobId)
    clearStemSeparationState()
    log.info('stems', `cancelled during preparation jobId=${active.jobId}`)
    return
  }
  sendBridge('STEM_SEPARATE_CANCEL', { jobId: active.jobId })
}

function stripExtension(name: string): string {
  return name.replace(/\.[^.]+$/, '')
}

/** Open the stem picker. All stems start UNticked so the user picks only what they
 *  want (Start stays disabled until at least one is chosen) — faster than unticking
 *  from a full set. The quality preset is seeded from the persisted preference. */
function openPicker(target: StemSeparationTarget): void {
  selection.value = {
    target,
    selected: { vocals: false, drums: false, bass: false, other: false },
    quality: preferredQuality,
    dereverb: false,
    dereverbStrength: 'medium'
  }
}

/** Handle a separation request. Models come FIRST: if the models a default
 *  separation needs aren't present, the download dialog is shown before the stem
 *  picker, and the picker opens only once they finish downloading. When the
 *  models are already installed the picker opens straight away. No-op while a
 *  separation is running or a dialog is already open. */
async function beginRequest(target: StemSeparationTarget): Promise<void> {
  const notifications = useNotificationsStore()
  if (snapshotStemSeparationState() !== null) {
    notifications.pushInfo('A stem separation is already running.')
    return
  }
  if (flow.value !== null || selection.value !== null || resolvingGate) return

  resolvingGate = true
  let missing: Array<{ src: StemModelSource; state: StemModelState }>
  try {
    // Gate on the DEFAULT (all-four) selection's models — the picker isn't open
    // yet, so the exact stems aren't known. Any htdemucs-only extra a partial
    // `other` selection needs is resolved after the picker, in ensureModelThenDispatch.
    missing = await resolveMissingModels(ALL_STEMS)
  } catch (err) {
    notifications.pushError('Could not check the stem-separation models.')
    log.error(
      'stems',
      `model state check failed: ${err instanceof Error ? err.message : String(err)}`
    )
    return
  } finally {
    resolvingGate = false
  }

  if (missing.length > 0) {
    showDownloadFlow({ kind: 'select', target }, missing)
    return
  }
  openPicker(target)
}

/**
 * Entry from the clip context menu: separate a timeline clip's source. The
 * resulting stems are placed on new tracks aligned to the clip.
 */
export async function requestStemSeparationForClip(clipId: string): Promise<void> {
  const project = useProjectStore()
  const library = useLibraryStore()
  const clip = project.clips[clipId]
  if (!clip) return
  // Separate the audio the clip actually plays — its own library item — not the
  // original top-level source. A clip's trim window (`inMs`/`durationMs`) is
  // defined against its own item's file (e.g. a stem is a standalone WAV), so the
  // backend must read that file to window the clip correctly. Resolving to the
  // top-level source would read the wrong file (and fail outright when the source
  // is no longer in the library), which is why separating an already-separated
  // stem failed. Provenance for the new stems flows from this item too.
  const sourceItemId = clip.libraryItemId
  if (!sourceItemId) return
  const sourceItem = library.byId[sourceItemId]
  const name = sourceItem ? libraryItemDisplayName(sourceItem) : clip.fileName
  await beginRequest({
    sourceItemId,
    sourceName: stripExtension(name),
    clipId,
    startMs: clip.startMs,
    sourceInMs: clip.inMs
  })
}

/**
 * Entry from the library context menu: separate a source library item. The
 * stems are imported to the library only — adding them to the timeline is a
 * manual step.
 */
export async function requestStemSeparationForLibraryItem(itemId: string): Promise<void> {
  const library = useLibraryStore()
  // Separate the selected item's own audio (a stem/clip is a standalone file),
  // not a resolved top-level source — the user chose this item, and resolving
  // away from it would separate the wrong audio (or fail if the original source
  // is gone).
  const sourceItem = library.byId[itemId]
  if (!sourceItem) return
  await beginRequest({
    sourceItemId: itemId,
    sourceName: stripExtension(libraryItemDisplayName(sourceItem))
  })
}

/** Toggle one stem in the picker. */
export function toggleStemSelection(stem: StemName): void {
  if (!selection.value) return
  selection.value = {
    ...selection.value,
    selected: { ...selection.value.selected, [stem]: !selection.value.selected[stem] }
  }
}

/** Set the quality preset in the picker and persist it as the new default so the
 *  dialog reopens on this choice next time (this session and after restart). */
export function setStemQuality(quality: StemQuality): void {
  if (!selection.value) return
  selection.value = { ...selection.value, quality }
  preferredQuality = quality
  window.silverdaw.setStemPrefs({ quality })
}

/** Toggle the per-run vocal dereverb (remove reverb/echo) in the picker. */
export function toggleStemDereverb(): void {
  if (!selection.value) return
  selection.value = { ...selection.value, dereverb: !selection.value.dereverb }
}

/** Set the per-run vocal dereverb strength in the picker. */
export function setStemDereverbStrength(strength: DereverbStrength): void {
  if (!selection.value) return
  selection.value = { ...selection.value, dereverbStrength: strength }
}

/** Dismiss the picker without starting anything. */
export function cancelStemSelection(): void {
  selection.value = null
}

/** Start: collect the ticked stems and proceed to the model gate. No-op when
 *  nothing is ticked (the dialog disables Start in that case too). */
export async function confirmStemSelection(): Promise<void> {
  const current = selection.value
  if (!current) return
  const stems = ALL_STEMS.filter((s) => current.selected[s])
  if (stems.length === 0) return
  const quality = current.quality
  // Dereverb only affects the vocals stem; pass the chosen strength (or null = off).
  const dereverb: DereverbStrength | null =
    current.dereverb && current.selected.vocals ? current.dereverbStrength : null
  selection.value = null
  await ensureModelThenDispatch(current.target, stems, quality, dereverb)
}

// ─── Model-download dialog ──────────────────────────────────────────────────

export type StemModelFlowPhase = 'confirm' | 'downloading' | 'error'

// What to do once the models the download dialog is showing finish downloading:
// open the stem picker (a PRE-selection download, before the user has chosen
// stems), or dispatch straight away (a POST-selection download of an extra model
// a chosen selection needs, e.g. the htdemucs backup for a partial `other`).
type FlowNext =
  | { readonly kind: 'select'; readonly target: StemSeparationTarget }
  | {
      readonly kind: 'dispatch'
      readonly target: StemSeparationTarget
      readonly stems: StemName[]
      readonly quality: StemQuality
      readonly dereverb: DereverbStrength | null
    }

export interface StemModelFlowState {
  phase: StemModelFlowPhase
  receivedBytes: number
  totalBytes: number
  fileName: string
  fileCount: number
  error: string
}

const flow: Ref<StemModelFlowState | null> = ref(null)
// The continuation for the current download (see FlowNext).
let flowNext: FlowNext | null = null
// Guards the async model-presence gate in beginRequest against re-entry from a
// rapid second request before the first has opened a dialog.
let resolvingGate = false

export function useStemModelFlow(): Readonly<Ref<StemModelFlowState | null>> {
  return readonly(flow)
}

// ─── Model sources ──────────────────────────────────────────────────────────

/** The downloadable stem models. The two RoFormer packs are the default engine
 *  (fetched together); htdemucs is the backup. */
export type StemModelKind = 'vocalPack' | 'rhythmPack' | 'htdemucs'

/** Uniform adapter over each model's IPC surface so the download flow can treat
 *  packs and the backup identically. */
interface StemModelSource {
  readonly kind: StemModelKind
  getState(): Promise<StemModelState>
  ensure(): Promise<EnsureStemModelResult>
  onProgress(handler: (progress: StemModelDownloadProgress) => void): () => void
  cancel(): void
}

const MODEL_SOURCES: Readonly<Record<StemModelKind, StemModelSource>> = {
  vocalPack: {
    kind: 'vocalPack',
    getState: () => window.silverdaw.getVocalPackState(),
    ensure: () => window.silverdaw.ensureVocalPack(),
    onProgress: (handler) => window.silverdaw.onVocalPackDownloadProgress(handler),
    cancel: () => window.silverdaw.cancelVocalPackDownload()
  },
  rhythmPack: {
    kind: 'rhythmPack',
    getState: () => window.silverdaw.getRhythmPackState(),
    ensure: () => window.silverdaw.ensureRhythmPack(),
    onProgress: (handler) => window.silverdaw.onRhythmPackDownloadProgress(handler),
    cancel: () => window.silverdaw.cancelRhythmPackDownload()
  },
  htdemucs: {
    kind: 'htdemucs',
    getState: () => window.silverdaw.getStemModelState(),
    ensure: () => window.silverdaw.ensureStemModel(),
    onProgress: (handler) => window.silverdaw.onStemModelDownloadProgress(handler),
    cancel: () => window.silverdaw.cancelStemModelDownload()
  }
}

/**
 * The models needed for a separation. By default both RoFormer quality packs
 * are fetched together (the primary engine). htdemucs is the backup, required
 * only when the user forces it, or when `other` is requested without the full
 * four-stem set — the residual `other` is only produced alongside all four
 * stems, so a partial selection needs the htdemucs `other` specialist.
 */
export function requiredModelKinds(
  stems: readonly StemName[],
  useBackupModel: boolean
): StemModelKind[] {
  if (useBackupModel) return ['htdemucs']
  const kinds: StemModelKind[] = ['vocalPack', 'rhythmPack']
  const sel = new Set(stems)
  const allFour = sel.has('vocals') && sel.has('drums') && sel.has('bass') && sel.has('other')
  if (sel.has('other') && !allFour) kinds.push('htdemucs')
  return kinds
}

async function resolveRequiredSources(stems: readonly StemName[]): Promise<StemModelSource[]> {
  let useBackup = false
  try {
    useBackup = (await window.silverdaw.getStemPrefs()).useBackupModel
  } catch {
    // On a prefs lookup failure, fall back to the htdemucs backup so we never
    // dispatch a job the backend can't fulfil.
    return [MODEL_SOURCES.htdemucs]
  }
  return requiredModelKinds(stems, useBackup).map((kind) => MODEL_SOURCES[kind])
}

// The not-yet-installed models to fetch when the user confirms, each paired with
// its byte total so combined download progress can be computed.
let pendingSources: ReadonlyArray<{ readonly src: StemModelSource; readonly totalBytes: number }> =
  []
// Cancel hook for the model currently downloading (set during confirmModelDownload).
let activeCancel: (() => void) | null = null

/** Required models for the given selection that are not yet installed, paired
 *  with their current on-disk state (for the combined size / progress display). */
async function resolveMissingModels(
  stems: readonly StemName[]
): Promise<Array<{ src: StemModelSource; state: StemModelState }>> {
  const sources = await resolveRequiredSources(stems)
  const states = await Promise.all(
    sources.map(async (src) => ({ src, state: await src.getState() }))
  )
  return states.filter(({ state }) => !state.installed)
}

/** Show the download dialog for a set of missing models, remembering what to do
 *  once they finish downloading (open the picker, or dispatch). */
function showDownloadFlow(
  next: FlowNext,
  missing: ReadonlyArray<{ src: StemModelSource; state: StemModelState }>
): void {
  pendingSources = missing.map(({ src, state }) => ({ src, totalBytes: state.totalBytes }))
  flowNext = next
  flow.value = {
    phase: 'confirm',
    receivedBytes: missing.reduce((sum, { state }) => sum + state.presentBytes, 0),
    totalBytes: missing.reduce((sum, { state }) => sum + state.totalBytes, 0),
    fileName: '',
    fileCount: missing.reduce((sum, { state }) => sum + state.fileCount, 0),
    error: ''
  }
}

/** After the user picks stems: ensure any remaining models the selection needs
 *  are present (prompting a download), then dispatch. With the pre-selection
 *  gate the packs are usually already installed, so this typically dispatches
 *  straight away — it still catches the htdemucs backup a partial `other`
 *  selection needs. */
async function ensureModelThenDispatch(
  target: StemSeparationTarget,
  stems: StemName[],
  quality: StemQuality,
  dereverb: DereverbStrength | null
): Promise<void> {
  const notifications = useNotificationsStore()
  let missing: Array<{ src: StemModelSource; state: StemModelState }>
  try {
    missing = await resolveMissingModels(stems)
  } catch (err) {
    notifications.pushError('Could not check the stem-separation models.')
    log.error(
      'stems',
      `model state check failed: ${err instanceof Error ? err.message : String(err)}`
    )
    return
  }

  if (missing.length === 0) {
    await dispatchSeparation(target, stems, quality, dereverb)
    return
  }
  showDownloadFlow({ kind: 'dispatch', target, stems, quality, dereverb }, missing)
}

/** User accepted the download. Fetch each missing model in turn, streaming a
 *  single combined progress bar, then run the continuation: open the stem picker
 *  (pre-selection) or dispatch (post-selection). */
export async function confirmModelDownload(): Promise<void> {
  const current = flow.value
  if (!current || current.phase !== 'confirm') return
  const next = flowNext
  const sources = pendingSources
  flow.value = { ...current, phase: 'downloading', error: '' }

  const grand = Math.max(
    1,
    sources.reduce((sum, s) => sum + s.totalBytes, 0)
  )
  // Bytes from models already finished in this batch; the active model's own
  // progress (which counts from its already-present bytes) is added on top.
  let base = 0
  const report = (received: number, fileName: string): void => {
    if (!flow.value || flow.value.phase !== 'downloading') return
    flow.value = {
      ...flow.value,
      receivedBytes: Math.min(grand, base + received),
      totalBytes: grand,
      fileName
    }
  }

  try {
    for (const { src, totalBytes } of sources) {
      const stop = src.onProgress((p) => report(p.receivedBytes, p.fileName))
      activeCancel = () => src.cancel()
      let result: EnsureStemModelResult
      try {
        result = await src.ensure()
      } finally {
        stop()
        activeCancel = null
      }
      // A concurrent cancelModelFlow() nulls the flow; stop quietly then.
      if (!flow.value) return
      if (!result.ok) {
        flow.value = { ...flow.value, phase: 'error', error: result.error }
        return
      }
      base += totalBytes
    }
    flow.value = null
    flowNext = null
    pendingSources = []
    if (next?.kind === 'dispatch') {
      await dispatchSeparation(next.target, next.stems, next.quality, next.dereverb)
    } else if (next?.kind === 'select') {
      openPicker(next.target)
    }
  } catch (err) {
    if (flow.value) {
      flow.value = {
        ...flow.value,
        phase: 'error',
        error: err instanceof Error ? err.message : String(err)
      }
    }
  }
}

/** Dismiss the model flow; aborts an in-progress download. */
export function cancelModelFlow(): void {
  if (flow.value?.phase === 'downloading') {
    activeCancel?.()
  }
  activeCancel = null
  pendingSources = []
  flowNext = null
  flow.value = null
}

async function dispatchSeparation(
  target: StemSeparationTarget,
  stems: readonly StemName[],
  quality: StemQuality,
  dereverb: DereverbStrength | null
): Promise<void> {
  // Reject a duplicate before it reaches the single-slot backend. The check-and-set is
  // synchronous (no await between), so a second concurrent call is blocked; `state`
  // covers the window after the job is registered.
  if (activePreparation !== null || snapshotStemSeparationState() !== null) {
    log.warn('stems', 'ignored duplicate stem separation (one is already in progress)')
    return
  }
  const preparation = Symbol('stem-preparation')
  activePreparation = preparation
  const preparationStarted = performance.now()
  const notifications = useNotificationsStore()
  const jobId = crypto.randomUUID()
  registerStemJob(jobId, target)
  beginStemSeparation(jobId, target, stems)
  try {
    const [modelDir, prefs, gpu, vocalPackPath, rhythmPackPath] = await Promise.all([
      window.silverdaw.getStemModelDir(),
      window.silverdaw.getStemPrefs().catch((err) => {
        log.warn(
          'stems',
          `getStemPrefs failed, using safe defaults: ${err instanceof Error ? err.message : String(err)}`
        )
        return DEFAULT_STEM_PREFS
      }),
      window.silverdaw.getStemGpuStatus().catch((err) => {
        log.warn(
          'stems',
          `getStemGpuStatus failed, defaulting to CPU: ${err instanceof Error ? err.message : String(err)}`
        )
        return { available: false, name: null }
      }),
      window.silverdaw.getVocalPackPath().catch(() => null),
      window.silverdaw.getRhythmPackPath().catch(() => null)
    ])
    const useGpu = prefs.useGpu && gpu.available
    const useBackupModel = prefs.useBackupModel
    const roformerModelPath =
      !useBackupModel && vocalPackPath && vocalPackPath.length > 0 ? vocalPackPath : undefined
    const rhythmModelPath =
      !useBackupModel && rhythmPackPath && rhythmPackPath.length > 0 ? rhythmPackPath : undefined
    if (activePreparation !== preparation || snapshotStemSeparationState()?.jobId !== jobId) {
      log.info('stems', `skipped dispatch for abandoned preparation jobId=${jobId}`)
      return
    }
    sendBridge('STEM_SEPARATE', {
      jobId,
      sourceItemId: target.sourceItemId,
      clipId: target.clipId,
      modelDir,
      roformerModelPath,
      rhythmModelPath,
      sourceName: target.sourceName,
      stems: [...stems],
      quality,
      useGpu,
      enhanceVocals: prefs.enhanceVocals,
      vocalEnhanceStrength: prefs.vocalEnhanceStrength,
      enhanceDrums: prefs.enhanceDrums,
      drumEnhanceStrength: prefs.drumEnhanceStrength,
      enhanceBass: prefs.enhanceBass,
      bassEnhanceStrength: prefs.bassEnhanceStrength,
      enhanceOther: prefs.enhanceOther,
      otherEnhanceStrength: prefs.otherEnhanceStrength,
      // Per-run vocal dereverb (chosen in the picker, not persisted). Sent with its
      // strength only when the user enabled it for a vocals run.
      ...(dereverb ? { dereverb: true, dereverbStrength: dereverb } : {})
    })
    log.info(
      'stem-perf',
      `dispatch job=${jobId} preparationMs=${(performance.now() - preparationStarted).toFixed(1)}`
    )
    log.info(
      'stems',
      `dispatch STEM_SEPARATE jobId=${jobId} source=${target.sourceItemId} ` +
        `clip=${target.clipId ?? '(library)'} stems=${stems.join(',')} quality=${quality} ` +
        `useGpu=${useGpu} dereverb=${dereverb ?? 'off'} ` +
        `enhanceVocals=${prefs.enhanceVocals ? prefs.vocalEnhanceStrength : 'off'} ` +
        `enhanceDrums=${prefs.enhanceDrums ? prefs.drumEnhanceStrength : 'off'} ` +
        `enhanceBass=${prefs.enhanceBass ? prefs.bassEnhanceStrength : 'off'} ` +
        `enhanceOther=${prefs.enhanceOther ? prefs.otherEnhanceStrength : 'off'}`
    )
  } catch (err) {
    // A preparation failure (prefs / model-dir / pack-path lookup) must not leave a
    // half-registered job or a stuck progress dialog — clean up and surface it.
    forgetStemJob(jobId)
    clearStemSeparationState()
    notifications.pushError('Could not start stem separation.')
    log.error('stems', `dispatch failed: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    if (activePreparation === preparation) activePreparation = null
  }
}

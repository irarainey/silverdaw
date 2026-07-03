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
import { forgetStemJob, registerStemJob, resolveSourceItemId } from '@/lib/stems/createStemTracks'
import { useProjectStore } from '@/stores/projectStore'
import { useLibraryStore, libraryItemDisplayName } from '@/stores/libraryStore'
import { useNotificationsStore } from '@/stores/notificationsStore'
import { log } from '@/lib/log'
import type { StemName, StemQuality, VocalEnhanceStrength, DrumEnhanceStrength, BassEnhanceStrength, OtherEnhanceStrength } from '@shared/bridge-protocol'
import type { StemModelState, StemModelDownloadProgress, EnsureStemModelResult } from '@shared/types'

/** Canonical four-stem order; the selection dialog and dispatch use it. */
const ALL_STEMS: readonly StemName[] = ['vocals', 'drums', 'bass', 'other']

// ─── Stem-picker dialog ─────────────────────────────────────────────────────

export interface StemSelectionState {
  target: StemSeparationTarget
  /** Which stems are currently ticked; at least one is required to start. */
  selected: Record<StemName, boolean>
  /** Quality preset trading speed against separation smoothness. */
  quality: StemQuality
}

const selection: Ref<StemSelectionState | null> = ref(null)

// The last-used separation quality, persisted with application preferences so the
// picker reopens on the user's choice instead of resetting each time. Cached in the
// module (and primed once at startup via loadStemQualityPreference) so the dialog can
// seed it synchronously when it opens; setStemQuality keeps it and the store in sync.
let preferredQuality: StemQuality = 'balanced'

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

function stripExtension(name: string): string {
  return name.replace(/\.[^.]+$/, '')
}

/** Open the stem picker. The quality preset is seeded from the persisted
 *  preference (see `loadStemQualityPreference`) so it reopens on the user's last
 *  choice. */
function openPicker(target: StemSeparationTarget): void {
  selection.value = {
    target,
    selected: { vocals: true, drums: true, bass: true, other: true },
    quality: preferredQuality
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
  const sourceItemId = resolveSourceItemId(library, clip.libraryItemId)
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
  const sourceItemId = resolveSourceItemId(library, itemId)
  if (!sourceItemId) return
  const sourceItem = library.byId[sourceItemId]
  if (!sourceItem) return
  await beginRequest({
    sourceItemId,
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
  selection.value = null
  await ensureModelThenDispatch(current.target, stems, quality)
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
  quality: StemQuality
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
    await dispatchSeparation(target, stems, quality)
    return
  }
  showDownloadFlow({ kind: 'dispatch', target, stems, quality }, missing)
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
      await dispatchSeparation(next.target, next.stems, next.quality)
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
  quality: StemQuality
): Promise<void> {
  const modelDir = await window.silverdaw.getStemModelDir()
  const useGpu = await resolveUseGpu()
  const enhance = await resolveStemEnhance()
  const roformerModelPath = await resolveVocalPackPath()
  const rhythmModelPath = await resolveRhythmPackPath()
  const jobId = crypto.randomUUID()
  registerStemJob(jobId, target)
  beginStemSeparation(jobId, target, stems)
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
    enhanceVocals: enhance.enhanceVocals,
    vocalEnhanceStrength: enhance.vocalEnhanceStrength,
    enhanceDrums: enhance.enhanceDrums,
    drumEnhanceStrength: enhance.drumEnhanceStrength,
    enhanceBass: enhance.enhanceBass,
    bassEnhanceStrength: enhance.bassEnhanceStrength,
    enhanceOther: enhance.enhanceOther,
    otherEnhanceStrength: enhance.otherEnhanceStrength
  })
  log.info(
    'stems',
    `dispatch STEM_SEPARATE jobId=${jobId} source=${target.sourceItemId} ` +
      `clip=${target.clipId ?? '(library)'} stems=${stems.join(',')} quality=${quality} ` +
      `useGpu=${useGpu} enhanceVocals=${enhance.enhanceVocals ? enhance.vocalEnhanceStrength : 'off'} ` +
      `enhanceDrums=${enhance.enhanceDrums ? enhance.drumEnhanceStrength : 'off'} ` +
      `enhanceBass=${enhance.enhanceBass ? enhance.bassEnhanceStrength : 'off'} ` +
      `enhanceOther=${enhance.enhanceOther ? enhance.otherEnhanceStrength : 'off'}`
  )
}

/**
 * Resolves the optional per-stem cleanup settings from the persisted stem prefs.
 * Any lookup failure disables cleanup — the safe default that never alters a
 * stem the user didn't ask to process.
 */
async function resolveStemEnhance(): Promise<{
  enhanceVocals: boolean
  vocalEnhanceStrength: VocalEnhanceStrength
  enhanceDrums: boolean
  drumEnhanceStrength: DrumEnhanceStrength
  enhanceBass: boolean
  bassEnhanceStrength: BassEnhanceStrength
  enhanceOther: boolean
  otherEnhanceStrength: OtherEnhanceStrength
}> {
  try {
    const prefs = await window.silverdaw.getStemPrefs()
    return {
      enhanceVocals: prefs.enhanceVocals,
      vocalEnhanceStrength: prefs.vocalEnhanceStrength,
      enhanceDrums: prefs.enhanceDrums,
      drumEnhanceStrength: prefs.drumEnhanceStrength,
      enhanceBass: prefs.enhanceBass,
      bassEnhanceStrength: prefs.bassEnhanceStrength,
      enhanceOther: prefs.enhanceOther,
      otherEnhanceStrength: prefs.otherEnhanceStrength
    }
  } catch (err) {
    log.warn(
      'stems',
      `resolveStemEnhance failed, disabling cleanup: ${err instanceof Error ? err.message : String(err)}`
    )
    return {
      enhanceVocals: false,
      vocalEnhanceStrength: 'medium',
      enhanceDrums: false,
      drumEnhanceStrength: 'medium',
      enhanceBass: false,
      bassEnhanceStrength: 'medium',
      enhanceOther: false,
      otherEnhanceStrength: 'medium'
    }
  }
}

/**
 * Resolves the Mel-Band RoFormer "Vocal Quality Pack" core .onnx path for the
 * request. The packs are the primary engine, so this returns the path whenever
 * the pack is installed — UNLESS the user forced the htdemucs backup model. Any
 * lookup failure (or pack absent) returns undefined, so the backend falls back
 * to the htdemucs vocal specialist.
 */
async function resolveVocalPackPath(): Promise<string | undefined> {
  try {
    const prefs = await window.silverdaw.getStemPrefs()
    if (prefs.useBackupModel) return undefined
    const path = await window.silverdaw.getVocalPackPath()
    return path && path.length > 0 ? path : undefined
  } catch {
    return undefined
  }
}

/**
 * Resolves the 4-stem BS-RoFormer "Rhythm Quality Pack" core .onnx path for the
 * request. Used automatically whenever the pack is installed, unless the user
 * forced the htdemucs backup model. Any lookup failure (or pack absent) returns
 * undefined, so the backend falls back to the htdemucs drums/bass specialists.
 */
async function resolveRhythmPackPath(): Promise<string | undefined> {
  try {
    const prefs = await window.silverdaw.getStemPrefs()
    if (prefs.useBackupModel) return undefined
    const path = await window.silverdaw.getRhythmPackPath()
    return path && path.length > 0 ? path : undefined
  } catch {
    return undefined
  }
}

/**
 * Effective GPU usage for a separation: the user's persisted `stems.useGpu`
 * preference, gated by live GPU detection so a machine without a hardware GPU
 * always runs on the CPU regardless of the stored value. Any lookup failure
 * falls back to the CPU (false) — the safe default.
 */
async function resolveUseGpu(): Promise<boolean> {
  try {
    const [prefs, gpu] = await Promise.all([
      window.silverdaw.getStemPrefs(),
      window.silverdaw.getStemGpuStatus()
    ])
    return prefs.useGpu && gpu.available
  } catch (err) {
    log.warn(
      'stems',
      `resolveUseGpu failed, defaulting to CPU: ${err instanceof Error ? err.message : String(err)}`
    )
    return false
  }
}

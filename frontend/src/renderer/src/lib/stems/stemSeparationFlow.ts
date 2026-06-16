// Renderer-side lifecycle for starting a stem separation: choose stems → ensure
// the model → dispatch. Two reactive refs drive two small dialogs:
//   • `selection` — the stem-picker shown first (which of the four stems to
//     extract). Cancellable; no-op while another separation runs.
//   • `flow` — the one-time ~1.2 GB model download (first use only): confirm,
//     stream progress, then dispatch.
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

/** Open the stem picker, unless a separation is already running or pending. The
 *  quality preset is seeded from the persisted preference (see
 *  `loadStemQualityPreference`) so the dialog reopens on the user's last choice. */
function openSelection(target: StemSeparationTarget): void {
  const notifications = useNotificationsStore()
  if (snapshotStemSeparationState() !== null) {
    notifications.pushInfo('A stem separation is already running.')
    return
  }
  if (flow.value !== null || selection.value !== null) return
  selection.value = {
    target,
    selected: { vocals: true, drums: true, bass: true, other: true },
    quality: preferredQuality
  }
}

/**
 * Entry from the clip context menu: separate a timeline clip's source. The
 * resulting stems are placed on new tracks aligned to the clip.
 */
export function requestStemSeparationForClip(clipId: string): void {
  const project = useProjectStore()
  const library = useLibraryStore()
  const clip = project.clips[clipId]
  if (!clip) return
  const sourceItemId = resolveSourceItemId(library, clip.libraryItemId)
  if (!sourceItemId) return
  const sourceItem = library.byId[sourceItemId]
  const name = sourceItem ? libraryItemDisplayName(sourceItem) : clip.fileName
  openSelection({
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
export function requestStemSeparationForLibraryItem(itemId: string): void {
  const library = useLibraryStore()
  const sourceItemId = resolveSourceItemId(library, itemId)
  if (!sourceItemId) return
  const sourceItem = library.byId[sourceItemId]
  if (!sourceItem) return
  openSelection({
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

export interface StemModelFlowState {
  phase: StemModelFlowPhase
  target: StemSeparationTarget
  stems: readonly StemName[]
  quality: StemQuality
  receivedBytes: number
  totalBytes: number
  fileName: string
  fileIndex: number
  fileCount: number
  error: string
}

const flow: Ref<StemModelFlowState | null> = ref(null)

export function useStemModelFlow(): Readonly<Ref<StemModelFlowState | null>> {
  return readonly(flow)
}

/** Ensure the model is present (prompting a first-use download if not), then
 *  dispatch. */
async function ensureModelThenDispatch(
  target: StemSeparationTarget,
  stems: StemName[],
  quality: StemQuality
): Promise<void> {
  const notifications = useNotificationsStore()
  let state: { installed: boolean; presentBytes: number; totalBytes: number; fileCount: number }
  try {
    state = await window.silverdaw.getStemModelState()
  } catch (err) {
    notifications.pushError('Could not check the stem-separation model.')
    log.error('stems', `getStemModelState failed: ${err instanceof Error ? err.message : String(err)}`)
    return
  }

  if (state.installed) {
    await dispatchSeparation(target, stems, quality)
    return
  }

  flow.value = {
    phase: 'confirm',
    target,
    stems,
    quality,
    receivedBytes: state.presentBytes,
    totalBytes: state.totalBytes,
    fileName: '',
    fileIndex: 0,
    fileCount: state.fileCount,
    error: ''
  }
}

/** User accepted the first-use download. Stream progress, then dispatch. */
export async function confirmModelDownload(): Promise<void> {
  const current = flow.value
  if (!current || current.phase !== 'confirm') return
  const { target, stems, quality } = current
  flow.value = { ...current, phase: 'downloading', error: '' }

  const off = window.silverdaw.onStemModelDownloadProgress((progress) => {
    if (!flow.value || flow.value.phase !== 'downloading') return
    flow.value = {
      ...flow.value,
      receivedBytes: progress.receivedBytes,
      totalBytes: progress.totalBytes,
      fileName: progress.fileName,
      fileIndex: progress.fileIndex,
      fileCount: progress.fileCount
    }
  })

  try {
    const result = await window.silverdaw.ensureStemModel()
    if (result.ok) {
      flow.value = null
      await dispatchSeparation(target, stems, quality)
    } else if (flow.value) {
      // A concurrent cancelFlow() nulls the state; only surface a real failure.
      flow.value = { ...flow.value, phase: 'error', error: result.error }
    }
  } catch (err) {
    if (flow.value) {
      flow.value = {
        ...flow.value,
        phase: 'error',
        error: err instanceof Error ? err.message : String(err)
      }
    }
  } finally {
    off()
  }
}

/** Dismiss the model flow; aborts an in-progress download. */
export function cancelModelFlow(): void {
  if (flow.value?.phase === 'downloading') {
    window.silverdaw.cancelStemModelDownload()
  }
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
  const jobId = crypto.randomUUID()
  registerStemJob(jobId, target)
  beginStemSeparation(jobId, target, stems)
  sendBridge('STEM_SEPARATE', {
    jobId,
    sourceItemId: target.sourceItemId,
    clipId: target.clipId,
    modelDir,
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

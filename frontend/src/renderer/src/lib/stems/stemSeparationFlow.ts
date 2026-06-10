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
  snapshotStemSeparationState,
  type StemSeparationTarget
} from '@/lib/stemSeparationState'
import { registerStemJob, resolveSourceItemId } from '@/lib/stems/createStemTracks'
import { useProjectStore } from '@/stores/projectStore'
import { useLibraryStore, libraryItemDisplayName } from '@/stores/libraryStore'
import { useNotificationsStore } from '@/stores/notificationsStore'
import { log } from '@/lib/log'
import type { StemName, StemQuality } from '@shared/bridge-protocol'

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

export function useStemSelection(): Readonly<Ref<StemSelectionState | null>> {
  return readonly(selection)
}

/** Strip any trailing file extension from a friendly name. */
function stripExtension(name: string): string {
  return name.replace(/\.[^.]+$/, '')
}

/** Open the stem picker, unless a separation is already running or pending. */
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
    quality: 'balanced'
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
    startMs: clip.startMs
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

/** Set the quality preset in the picker. */
export function setStemQuality(quality: StemQuality): void {
  if (!selection.value) return
  selection.value = { ...selection.value, quality }
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
    quality
  })
  log.info(
    'stems',
    `dispatch STEM_SEPARATE jobId=${jobId} source=${target.sourceItemId} ` +
      `clip=${target.clipId ?? '(library)'} stems=${stems.join(',')} quality=${quality}`
  )
}

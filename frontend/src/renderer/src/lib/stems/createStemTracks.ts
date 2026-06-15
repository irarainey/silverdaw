// Orchestrates turning a separation into library items and (optionally) timeline
// tracks. Every stem is imported through the existing library-import flow (single
// source of truth — no parallel import logic) and inherits the source's analysis.
// Editing stays non-destructive: the source is never mutated.
//
// Placement depends on the registered job target:
//   • timeline separation (target.clipId set) — each stem also lands on its own
//     new track, aligned to the source clip's start.
//   • library separation (no clipId) — stems are imported to the library only;
//     adding them to the timeline is a manual step.
//
// Results arrive incrementally: the backend emits STEM_PARTIAL the moment each
// stem WAV is written (handled by `createTrackFromStem`), so the user sees each
// stem land while later stems are still separating. The final STEM_READY
// (`createTracksFromStems`) backfills any stem not already imported and reports
// the summary. A per-job set dedupes the two paths.

import { importAudioIntoLibrary, libraryItemToClipPlacement } from '@/lib/importAudio'
import { useProjectStore } from '@/stores/projectStore'
import { useLibraryStore } from '@/stores/libraryStore'
import { STEM_NAME_SEPARATOR } from '@/stores/libraryItemHelpers'
import { useNotificationsStore } from '@/stores/notificationsStore'
import { log } from '@/lib/log'
import type { StemName, StemPartialPayload, StemReadyPayload } from '@shared/bridge-protocol'
import type { StemSeparationTarget } from '@/lib/stemSeparationState'

const STEM_TRACK_LABEL: Record<StemName, string> = {
  vocals: 'Vocals',
  drums: 'Drums',
  bass: 'Bass',
  other: 'Other'
}

interface StemJob {
  target: StemSeparationTarget
  // Stems imported (or in flight), so STEM_PARTIAL and the final STEM_READY never
  // import the same stem twice.
  placed: Set<StemName>
}

const jobs = new Map<string, StemJob>()

/** Record where a job's stems should go before any result arrives. Called by the
 *  separation flow right after STEM_SEPARATE is dispatched. */
export function registerStemJob(jobId: string, target: StemSeparationTarget): void {
  jobs.set(jobId, { target, placed: new Set<StemName>() })
}

/** Forget a job's placement state without placing anything. Used when a job is
 *  abandoned (e.g. the backend restarted) so no stale registry entry lingers. */
export function forgetStemJob(jobId: string): void {
  jobs.delete(jobId)
}

/** Import a single stem into the library (and, for timeline jobs, place it on a
 *  new track). Reserves the stem synchronously (before the first await) so
 *  concurrent/duplicate events are skipped; un-reserves on failure so a later
 *  event can retry. Returns true when the stem was imported. */
async function importStem(job: StemJob, stem: StemName, filePath: string): Promise<boolean> {
  if (job.placed.has(stem)) return false
  job.placed.add(stem)

  const library = useLibraryStore()
  // The caller reserved one batch slot per stem. `importAudioIntoLibrary` notes
  // its own completion, so balance the slot ourselves only when we bail out
  // before delegating to it (otherwise the import-progress counter never resets).
  let delegatedImport = false
  try {
    const project = useProjectStore()
    const { target } = job
    const sourceItem = library.getItem(target.sourceItemId)

    const opened = await window.silverdaw.readAudioFile(filePath)
    if (!opened) {
      log.error('stems', `could not read stem file ${filePath}`)
      job.placed.delete(stem)
      return false
    }
    const label = STEM_TRACK_LABEL[stem]
    delegatedImport = true
    const itemId = await importAudioIntoLibrary(opened, {
      kind: 'stem',
      // Name mirrors the stem's track name ("<part> — <source>") so the library
      // item reads as a distinct, source-tagged file. The leading part (before
      // the first " — ") is what the info dialog extracts as the stem type.
      name: `${label} ${STEM_NAME_SEPARATOR} ${target.sourceName}`,
      derivedFrom: {
        sourceItemId: target.sourceItemId,
        sourceClipId: target.clipId,
        // The separation extracted [inMs, …) of the source, so the stem WAV begins
        // at source-time `inMs`. Recording it here (a) lets the backend shift the
        // inherited beat grid onto the stem's timeline and (b) keeps provenance
        // accurate. Stem clip placement still uses inMs 0 (only saved-clips read
        // this for placement), so the stem plays from its own start.
        inMs: target.sourceInMs ?? 0,
        durationMs: 0
      }
    })
    if (!itemId) {
      job.placed.delete(stem)
      return false
    }
    // Stems are sample-aligned with the source, so reuse its analysis instead of
    // re-detecting: instant, accurate, and resolves any pending auto-warp. A
    // clip-scoped separation only covers [inMs, …) of the source, so the grid is
    // shifted back by that window start (see inheritSourceAnalysis).
    // (Sample/music classification is NOT copied — it defers to the source.)
    inheritSourceAnalysis(library, itemId, sourceItem, (target.sourceInMs ?? 0) / 1000)
    const audio = library.getItem(itemId)
    if (!audio) {
      job.placed.delete(stem)
      return false
    }

    // Library-source separation imports the stems only; placing them on the
    // timeline is a manual step the user takes later.
    if (target.clipId !== undefined) {
      const trackId = project.addTrack()
      project.setTrackName(trackId, `${label} ${STEM_NAME_SEPARATOR} ${target.sourceName}`)
      project.addClipFromLibrary(trackId, libraryItemToClipPlacement(audio), target.startMs ?? 0)
    }
    return true
  } catch (err) {
    log.error('stems', `failed to import stem ${stem}: ${err instanceof Error ? err.message : String(err)}`)
    job.placed.delete(stem)
    return false
  } finally {
    if (!delegatedImport) library.noteImportFinished()
  }
}

/** Incremental: import one stem as soon as the backend reports it written, so the
 *  user sees results appear while the remaining stems are still separating. */
export async function createTrackFromStem(payload: StemPartialPayload): Promise<void> {
  const job = jobs.get(payload.jobId)
  if (!job || job.placed.has(payload.stem)) return
  useLibraryStore().beginImportBatch(1)
  await importStem(job, payload.stem, payload.filePath)
}

/** Final pass on STEM_READY: import any stem not already added incrementally, then
 *  report the per-job summary and forget the job's state. */
export async function createTracksFromStems(payload: StemReadyPayload): Promise<void> {
  const job = jobs.get(payload.jobId)
  if (!job) return
  const library = useLibraryStore()
  const notifications = useNotificationsStore()

  const missing = payload.stems.filter((s) => !job.placed.has(s.stem))
  if (missing.length > 0) library.beginImportBatch(missing.length)
  for (const { stem, filePath } of missing) {
    await importStem(job, stem, filePath)
  }

  await persistStemSidecar(job, payload)

  const created = job.placed.size
  const onTimeline = job.target.clipId !== undefined
  const sourceName = job.target.sourceName
  jobs.delete(payload.jobId)
  if (created > 0) {
    notifications.pushInfo(
      onTimeline
        ? `Added ${created} stem ${created === 1 ? 'track' : 'tracks'} from ${sourceName}`
        : `Extracted ${created} ${created === 1 ? 'stem' : 'stems'} from ${sourceName} to the library`
    )
  } else {
    notifications.pushError(`Could not create stems from ${sourceName}`)
  }
}

/** Copy the source file's metadata + cover art into the stem output folder as a
 *  sidecar so the inherited identity survives source removal and project reload.
 *  All stems for a job share one folder, so a single sidecar covers them. */
async function persistStemSidecar(job: StemJob, payload: StemReadyPayload): Promise<void> {
  const first = payload.stems[0]
  if (!first) return
  const stemDir = first.filePath.replace(/[\\/][^\\/]*$/, '')
  if (!stemDir) return
  const source = useLibraryStore().getItem(job.target.sourceItemId)
  if (!source?.filePath) return
  try {
    await window.silverdaw.writeStemSidecar(stemDir, source.filePath)
  } catch (err) {
    log.warn('stems', `sidecar write failed for ${stemDir}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Copy the source item's beat grid and key onto a freshly imported stem so its
 *  clip warps to the project grid on add (no re-analysis, no pending state).
 *  `windowStartSec` is the source clip's trim-in: a clip-scoped separation only
 *  covers [windowStart, …) of the source, so the stem WAV's sample 0 is
 *  source-time `windowStart`. The grid (anchor + beats) is in source time, so
 *  shift it back to land on the stem's own timeline. This mirrors the backend's
 *  authoritative inheritance (LibraryAnalysis.cpp) so the two never diverge. */
function inheritSourceAnalysis(
  library: ReturnType<typeof useLibraryStore>,
  stemId: string,
  source: ReturnType<ReturnType<typeof useLibraryStore>['getItem']> | undefined,
  windowStartSec: number
): void {
  if (!source || !(source.bpm && source.bpm > 0)) return
  const shift = windowStartSec > 0 ? windowStartSec : 0
  const anchor = (source.beatAnchorSec ?? source.beats?.[0] ?? 0) - shift
  const beats = source.beats ? source.beats.map((b) => b - shift).filter((b) => b >= 0) : []
  // Deliberately do NOT copy the source's `lowConfidence` auto-flag onto the
  // stem: a stem has no independent confidence measurement, and its own flag
  // would short-circuit `libraryItemIsSample` before the `derivedFrom` branch.
  // Leaving it unset lets the stem defer its sample/music classification to the
  // source live — so setting the source to "music" reveals the stem's beat grid.
  library.setItemAnalysis(
    stemId,
    source.bpm,
    anchor,
    beats,
    source.variableTempo === true,
    undefined,
    false
  )
  if (source.key) library.setItemKey(stemId, source.key)
}

/** Resolve the top-level audio-file source a clip or library item ultimately
 *  derives from. Stems nest under this source even when separated from a
 *  saved-clip (which itself derives from it). */
export function resolveSourceItemId(
  library: ReturnType<typeof useLibraryStore>,
  libraryItemId: string | undefined
): string | undefined {
  if (!libraryItemId) return undefined
  const item = library.getItem(libraryItemId)
  if (!item) return undefined
  if (item.kind === 'audio-file') return item.id
  return item.derivedFrom?.sourceItemId ?? item.id
}

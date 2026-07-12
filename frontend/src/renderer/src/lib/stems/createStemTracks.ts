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
import { runInUndoGroup } from '@/lib/undo/undoGroup'
import { useProjectStore } from '@/stores/projectStore'
import { resolveLibraryItemMediaId, useLibraryStore } from '@/stores/libraryStore'
import { STEM_NAME_SEPARATOR } from '@/stores/libraryItemHelpers'
import { inheritSourceAnalysis } from '@/lib/library/inheritSourceAnalysis'
import { getProjectMedia } from '@/lib/library/projectMedia'
import { useNotificationsStore } from '@/stores/notificationsStore'
import { log } from '@/lib/log'
import type {
  StemFile,
  StemName,
  StemPartialPayload,
  StemReadyPayload
} from '@shared/bridge-protocol'
import type { StemSeparationTarget } from '@/lib/stemSeparationState'

const STEM_TRACK_LABEL: Record<StemName, string> = {
  vocals: 'Vocals',
  drums: 'Drums',
  bass: 'Bass',
  other: 'Other'
}

interface StemJob {
  target: StemSeparationTarget
  sourceMediaId?: string
  // Completed imports and their in-flight promises are separate so STEM_READY
  // can await partial imports before reporting completion.
  placed: Set<StemName>
  imports: Map<StemName, Promise<boolean>>
  sourceMetadata?: Promise<AudioMetadata | null>
}

const jobs = new Map<string, StemJob>()

/** Record where a job's stems should go before any result arrives. Called by the
 *  separation flow right after STEM_SEPARATE is dispatched. */
export function registerStemJob(jobId: string, target: StemSeparationTarget): void {
  const library = useLibraryStore()
  jobs.set(jobId, {
    target,
    sourceMediaId: resolveLibraryItemMediaId(library.getItem(target.sourceItemId), library.byId),
    placed: new Set<StemName>(),
    imports: new Map<StemName, Promise<boolean>>()
  })
}

/** Forget a job's placement state without placing anything. Used when a job is
 *  abandoned (e.g. the backend restarted) so no stale registry entry lingers. */
export function forgetStemJob(jobId: string): void {
  jobs.delete(jobId)
}

/** Import a single stem into the library (and, for timeline jobs, place it on a
 *  new track). Returns true when the stem was imported. */
async function performStemImport(
  job: StemJob,
  stemFile: StemFile
): Promise<boolean> {
  const { stem, filePath } = stemFile
  const library = useLibraryStore()
  // The caller reserved one batch slot per stem. `importAudioIntoLibrary` notes
  // its own completion, so balance the slot ourselves only when we bail out
  // before delegating to it (otherwise the import-progress counter never resets).
  let delegatedImport = false
  try {
    const project = useProjectStore()
    const { target } = job
    const sourceItem = library.getItem(target.sourceItemId)

    if (!job.sourceMetadata) {
      job.sourceMetadata = job.sourceMediaId
        ? getProjectMedia(job.sourceMediaId)
        : Promise.resolve(null)
    }
    const [opened, sourceMetadata] = await Promise.all([
      window.silverdaw.readAudioFile(filePath),
      job.sourceMetadata
    ])
    if (!opened) {
      log.error('stems', `could not read stem file ${filePath}`)
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
        // accurate. Stem clip placement still uses inMs 0 (only library-clips read
        // this for placement), so the stem plays from its own start.
        inMs: target.sourceInMs ?? 0,
        durationMs: 0
      },
      generatedAudio:
        stemFile.sampleRate !== undefined &&
        stemFile.durationMs !== undefined &&
        stemFile.channelCount !== undefined
          ? {
              sampleRate: stemFile.sampleRate,
              durationMs: stemFile.durationMs,
              channelCount: stemFile.channelCount
            }
          : undefined,
      inheritedMetadata: sourceMetadata,
      inheritedMediaId: job.sourceMediaId
    })
    if (!itemId) {
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
      return false
    }

    // Library-source separation imports the stems only; placing them on the
    // timeline is a manual step the user takes later.
    if (target.clipId !== undefined) {
      // New track, its name, and the stem clip placement are ONE undo step.
      runInUndoGroup(`Add ${label} stem`, () => {
        const trackId = project.addTrack()
        project.setTrackName(trackId, `${label} ${STEM_NAME_SEPARATOR} ${target.sourceName}`)
        project.addClipFromLibrary(trackId, libraryItemToClipPlacement(audio), target.startMs ?? 0)
      })
    }
    return true
  } catch (err) {
    log.error('stems', `failed to import stem ${stem}: ${err instanceof Error ? err.message : String(err)}`)
    return false
  } finally {
    if (!delegatedImport) library.noteImportFinished()
  }
}

function startStemImport(job: StemJob, stemFile: StemFile): Promise<boolean> {
  if (job.placed.has(stemFile.stem)) return Promise.resolve(false)
  const existing = job.imports.get(stemFile.stem)
  if (existing) return existing

  const tracked = performStemImport(job, stemFile).then((imported) => {
    job.imports.delete(stemFile.stem)
    if (imported) job.placed.add(stemFile.stem)
    return imported
  })
  job.imports.set(stemFile.stem, tracked)
  return tracked
}

/** Incremental: import one stem as soon as the backend reports it written, so the
 *  user sees results appear while the remaining stems are still separating. */
export async function createTrackFromStem(payload: StemPartialPayload): Promise<void> {
  const job = jobs.get(payload.jobId)
  if (!job || job.placed.has(payload.stem) || job.imports.has(payload.stem)) return
  const started = performance.now()
  useLibraryStore().beginImportBatch(1)
  const imported = await startStemImport(job, payload)
  log.info(
    'stem-perf',
    `import job=${payload.jobId} stem=${payload.stem} imported=${imported} ` +
      `durationMs=${(performance.now() - started).toFixed(1)}`
  )
}

/** Final pass on STEM_READY: import any stem not already added incrementally, then
 *  report the per-job summary and forget the job's state. */
export async function createTracksFromStems(payload: StemReadyPayload): Promise<void> {
  const job = jobs.get(payload.jobId)
  if (!job) return
  const started = performance.now()
  const library = useLibraryStore()
  const notifications = useNotificationsStore()

  const unresolved = payload.stems.filter(({ stem }) => !job.placed.has(stem))
  const inFlightAtReady = unresolved.filter(({ stem }) => job.imports.has(stem))
  const missing = unresolved.filter(({ stem }) => !job.imports.has(stem))
  await Promise.all(
    inFlightAtReady.map((stemFile) => startStemImport(job, stemFile))
  )

  // A failed partial import is eligible for the final ready payload's one retry.
  const retries = inFlightAtReady.filter(({ stem }) => !job.placed.has(stem))
  if (retries.length > 0) {
    library.beginImportBatch(retries.length)
    for (const stemFile of retries) {
      await startStemImport(job, stemFile)
    }
  }
  if (missing.length > 0) {
    library.beginImportBatch(missing.length)
    for (const stemFile of missing) {
      await startStemImport(job, stemFile)
    }
  }

  const created = job.placed.size
  const onTimeline = job.target.clipId !== undefined
  const sourceName = job.target.sourceName
  jobs.delete(payload.jobId)
  log.info(
    'stem-perf',
    `ready-imports job=${payload.jobId} missing=${missing.length} awaited=${inFlightAtReady.length} ` +
      `created=${created} ` +
      `durationMs=${(performance.now() - started).toFixed(1)}`
  )
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

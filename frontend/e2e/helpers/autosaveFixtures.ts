// Seeds crash-recovery state into a throwaway profile.
//
// Recovery is a filesystem contract, not a timing one: at startup the main process
// scans `<userData>/autosave/<projectId>/` for a `manifest.json` and an
// `autosave.silverdaw`, and decides from those alone whether to offer the entry
// (`main/ipc/autosaveHandlers.ts`). Because `--user-data-dir` already isolates that
// root, a spec can write the exact state it wants to test and launch.
//
// This is deliberately not driven by crashing the app. A real crash can only produce
// whatever state it happens to produce, so it cannot reach the branches that matter
// — a half-written `pending` bucket, or an autosave that is older than the file it
// shadows — and it would make the journey wait on a background timer, which is the
// brittle timing assertion ADR 0014 warns against. The writer that produces these
// buckets is covered by a unit spec instead (`tests/renderer/lib/autosave.test.ts`).

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FIXTURE_AUDIO_FILE, FIXTURE_PROJECT_NAME } from './projectFixtures'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Autosave document name the recovery scan looks for (`main/autosaveStore.ts`). */
export const AUTOSAVE_FILENAME = 'autosave.silverdaw'

/** Manifest name the recovery scan looks for (`main/autosaveStore.ts`). */
export const AUTOSAVE_MANIFEST_FILENAME = 'manifest.json'

export interface AutosaveBucketSeed {
  /** Bucket folder name. Must satisfy `AUTOSAVE_ID_REGEX` (`[A-Za-z0-9_-]{1,64}`). */
  projectId: string
  /** Name the recovery dialog lists the entry under. */
  projectName: string
  /** The file this autosave shadows, or `null` for work never saved anywhere. */
  originalPath: string | null
  /** `true` marks a half-written bucket, which recovery must ignore. */
  pending?: boolean
  savedAtIso?: string
  /** Contents of `autosave.silverdaw`. */
  projectJson: string
  /**
   * Modification time for `autosave.silverdaw`. Recovery only offers an entry whose
   * autosave is more than 500 ms newer than its original, so a spec that wants a
   * deterministic verdict has to set this rather than hope the filesystem agrees.
   */
  autosaveMtime?: Date
}

/**
 * Builds an autosave document from the frozen project fixture, with its media path
 * rewritten to an absolute location.
 *
 * That mirrors what the engine really writes: `ProjectFile::save` only stores a path
 * relative when it sits inside the saved project's own folder, and an autosave lives
 * in its bucket rather than beside the user's media — so a genuine autosave carries
 * absolute media paths. Reusing the fixture keeps the document a real one rather
 * than a hand-rolled approximation that could drift from the schema.
 */
export function makeAutosaveProjectJson(options: {
  /** Absolute path of the audio the restored project should reference. */
  audioPath: string
  /** Name stored *inside* the document, so a restore can be told from the original. */
  projectName: string
}): string {
  const source = readFileSync(
    join(HERE, '..', 'fixtures', 'projects', FIXTURE_PROJECT_NAME, `${FIXTURE_PROJECT_NAME}.silverdaw`),
    'utf8'
  )
  const doc = JSON.parse(source) as {
    project: { name: string; $children: { $type: string; $children?: Record<string, unknown>[] }[] }
  }

  doc.project.name = options.projectName
  const library = doc.project.$children.find((child) => child.$type === 'LIBRARY')
  for (const item of library?.$children ?? []) {
    if (item['filePath'] === FIXTURE_AUDIO_FILE) item['filePath'] = options.audioPath
    if (item['playbackFilePath'] === FIXTURE_AUDIO_FILE) item['playbackFilePath'] = options.audioPath
  }
  return JSON.stringify(doc, null, 2)
}

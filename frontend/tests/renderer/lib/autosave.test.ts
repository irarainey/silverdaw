import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/log', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }
}))

import { startAutosaveManager, stopAutosaveManager } from '@/lib/autosave'
import { useAppStore } from '@/stores/appStore'
import { useProjectStore } from '@/stores/projectStore'

// The e2e tier seeds autosave buckets and asserts how startup *reads* them
// (e2e/journeys/autosave-recovery.e2e.ts). This spec owns the other half — the
// writer that produces those buckets — because its guarantees are ordering and
// ownership rules that a real crash cannot be asked to reproduce on demand.

const PROJECT_ID = 'proj-1'

const resolveAutosaveDir = vi.fn((projectId: string) =>
  Promise.resolve({ dir: `/autosave/${projectId}`, filePath: `/autosave/${projectId}/autosave.silverdaw` })
)
const writeAutosaveManifest = vi.fn(
  (_manifest: { projectId: string; pending: boolean }) => Promise.resolve(true)
)
const clearAutosave = vi.fn(() => Promise.resolve(true))

/** Puts the stores in the one state that makes the manager tick immediately. */
function armAutosave(): ReturnType<typeof useProjectStore> {
  const project = useProjectStore()
  const app = useAppStore()
  app.autosaveEnabled = true
  project.projectId = PROJECT_ID
  project.projectName = 'My Mix'
  project.currentFilePath = 'C:\\Projects\\My Mix\\My Mix.silverdaw'
  project.isDirty = true
  return project
}

/** Lets the manager's immediate tick run to completion. */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

describe('autosave writer', () => {
  // The manager resolves its stores from the pinia it is handed, so the spec must
  // arm that same instance — arming the active one and passing a fresh one would
  // leave every assertion vacuously green.
  let pinia: Pinia

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    resolveAutosaveDir.mockClear()
    writeAutosaveManifest.mockClear()
    clearAutosave.mockClear()
    // @ts-expect-error — minimal preload surface for the autosave writer.
    globalThis.window = { silverdaw: { resolveAutosaveDir, writeAutosaveManifest, clearAutosave } }
  })

  afterEach(() => {
    stopAutosaveManager()
    // @ts-expect-error — tear down the injected global.
    delete globalThis.window
  })

  it('marks the bucket pending before writing and confirms it after', async () => {
    const project = armAutosave()
    const autosaveAndWait = vi.fn(() => Promise.resolve({ ok: true }))
    project.autosaveAndWait = autosaveAndWait

    startAutosaveManager(pinia)
    await flush()

    // Ordering is the entire point: recovery skips pending buckets, so the flag has
    // to be on disk *before* the write starts. Confirming first would leave a crash
    // mid-write looking like a complete autosave.
    expect(writeAutosaveManifest).toHaveBeenCalledTimes(2)
    expect(writeAutosaveManifest.mock.calls[0]![0]).toMatchObject({ pending: true })
    expect(writeAutosaveManifest.mock.calls[1]![0]).toMatchObject({ pending: false })

    const pendingWriteOrder = writeAutosaveManifest.mock.invocationCallOrder[0]!
    const saveOrder = autosaveAndWait.mock.invocationCallOrder[0]!
    const confirmOrder = writeAutosaveManifest.mock.invocationCallOrder[1]!
    expect(pendingWriteOrder).toBeLessThan(saveOrder)
    expect(saveOrder).toBeLessThan(confirmOrder)
  })

  it('leaves the bucket pending when the engine fails to write it', async () => {
    const project = armAutosave()
    project.autosaveAndWait = vi.fn(() => Promise.resolve({ ok: false, error: 'engine gone' }))

    startAutosaveManager(pinia)
    await flush()

    // No confirmation, so recovery will ignore this bucket — which is correct: the
    // file it points at was never successfully written.
    expect(writeAutosaveManifest).toHaveBeenCalledTimes(1)
    expect(writeAutosaveManifest.mock.calls[0]![0]).toMatchObject({ pending: true })
  })

  it('does not confirm a bucket the project no longer owns', async () => {
    const project = armAutosave()
    // The user opens a different project while the write is in flight. Confirming now
    // would advertise the new project's data under the old project's identity, and
    // recovery would later offer it as the old project.
    project.autosaveAndWait = vi.fn(async () => {
      project.projectId = 'proj-2'
      return { ok: true }
    })

    startAutosaveManager(pinia)
    await flush()

    // Swapping the project re-arms the timer, so a tick for the *new* project is
    // expected and fine. The guarantee is narrower and is the one that matters:
    // nothing ever confirms a bucket under the old project's identity, because
    // recovery would then offer the new project's data as the old project's.
    const confirmedOldProject = writeAutosaveManifest.mock.calls.filter(
      ([manifest]) => manifest.projectId === PROJECT_ID && !manifest.pending
    )
    expect(confirmedOldProject).toHaveLength(0)
    expect(writeAutosaveManifest.mock.calls[0]![0]).toMatchObject({
      projectId: PROJECT_ID,
      pending: true
    })
  })

  it('does not write while engine recovery is in flight', async () => {
    const project = armAutosave()
    project.recoveryInFlight = true
    project.autosaveAndWait = vi.fn(() => Promise.resolve({ ok: true }))

    startAutosaveManager(pinia)
    await flush()

    // Renderer and engine identities are transient mid-recovery, so a snapshot taken
    // now could be attributed to the wrong project.
    expect(writeAutosaveManifest).not.toHaveBeenCalled()
    expect(project.autosaveAndWait).not.toHaveBeenCalled()
  })
})

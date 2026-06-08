import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useUnsavedChangesGuard } from '@/lib/app/useUnsavedChangesGuard'
import { useProjectStore } from '@/stores/projectStore'
import { useTransportStore } from '@/stores/transportStore'

const clearAutosaveBucket = vi.fn((..._args: unknown[]) => Promise.resolve())
vi.mock('@/lib/autosave', () => ({
  clearAutosaveBucket: (...args: unknown[]) => clearAutosaveBucket(...args)
}))
vi.mock('@/lib/bridgeService', () => ({ send: vi.fn() }))
vi.mock('@/lib/log', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }
}))

const chooseProjectSaveAs = vi.fn()

function stubWindow(): void {
  vi.stubGlobal('window', { silverdaw: { chooseProjectSaveAs } })
}

describe('useUnsavedChangesGuard', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    clearAutosaveBucket.mockClear()
    chooseProjectSaveAs.mockReset()
    stubWindow()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('runs the action immediately for a clean project without prompting', async () => {
    const project = useProjectStore()
    project.isDirty = false
    project.currentFilePath = null

    const { guardAgainstUnsavedChanges, unsavedPromptOpen } = useUnsavedChangesGuard()
    const proceed = vi.fn()
    guardAgainstUnsavedChanges(proceed)
    await new Promise((r) => setTimeout(r, 0))

    expect(unsavedPromptOpen.value).toBe(false)
    expect(proceed).toHaveBeenCalledTimes(1)
  })

  it('opens the prompt and defers the action for a dirty project', () => {
    const project = useProjectStore()
    project.isDirty = true

    const { guardAgainstUnsavedChanges, unsavedPromptOpen } = useUnsavedChangesGuard()
    const proceed = vi.fn()
    guardAgainstUnsavedChanges(proceed)

    expect(unsavedPromptOpen.value).toBe(true)
    expect(proceed).not.toHaveBeenCalled()
  })

  it('discard clears autosave then runs the pending action', async () => {
    const project = useProjectStore()
    project.isDirty = true
    project.projectId = 'p1'

    const guard = useUnsavedChangesGuard()
    const proceed = vi.fn()
    guard.guardAgainstUnsavedChanges(proceed)

    await guard.onUnsavedPromptDiscard()

    expect(clearAutosaveBucket).toHaveBeenCalledWith('p1')
    expect(proceed).toHaveBeenCalledTimes(1)
    expect(guard.unsavedPromptOpen.value).toBe(false)
  })

  it('cancel closes the prompt and drops the pending action', () => {
    const project = useProjectStore()
    project.isDirty = true

    const guard = useUnsavedChangesGuard()
    const proceed = vi.fn()
    guard.guardAgainstUnsavedChanges(proceed)
    guard.onUnsavedPromptCancel()

    expect(guard.unsavedPromptOpen.value).toBe(false)
    // A subsequent discard has nothing to run.
    void guard.onUnsavedPromptDiscard()
    expect(proceed).not.toHaveBeenCalled()
  })

  it('save persists to the existing path then runs the pending action', async () => {
    const project = useProjectStore()
    const transport = useTransportStore()
    transport.bridgeReady = true
    project.isDirty = true
    project.currentFilePath = '/songs/mix.silverdaw'
    const save = vi
      .spyOn(project, 'saveAndWait')
      .mockResolvedValue({ ok: true } as Awaited<ReturnType<typeof project.saveAndWait>>)

    const guard = useUnsavedChangesGuard()
    const proceed = vi.fn()
    guard.guardAgainstUnsavedChanges(proceed)

    await guard.onUnsavedPromptSave()

    expect(save).toHaveBeenCalledWith('/songs/mix.silverdaw', false)
    expect(chooseProjectSaveAs).not.toHaveBeenCalled()
    expect(proceed).toHaveBeenCalledTimes(1)
  })
})

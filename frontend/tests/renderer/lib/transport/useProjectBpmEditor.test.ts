import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick } from 'vue'
import { useProjectBpmEditor } from '@/lib/transport/useProjectBpmEditor'
import { useProjectStore } from '@/stores/projectStore'
import { useTransportStore } from '@/stores/transportStore'

vi.mock('@/lib/bridgeService', () => ({ send: vi.fn() }))
vi.mock('@/lib/log', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }
}))

type Editor = ReturnType<typeof useProjectBpmEditor>

/** Runs the composable in its own effect scope, standing in for the component
 *  whose teardown its scope-dispose hook rides on. */
function mountEditor(): { editor: Editor; unmount: () => void } {
  const scope = effectScope()
  const editor = scope.run(() => useProjectBpmEditor()) as Editor
  return { editor, unmount: () => scope.stop() }
}

describe('useProjectBpmEditor', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.useFakeTimers()
    const transport = useTransportStore()
    transport.bpm = 120
    const project = useProjectStore()
    vi.spyOn(project, 'applyProjectBpm').mockImplementation((bpm: number) => {
      transport.setBpm(bpm)
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('applies a run of bumps once, at the final value', () => {
    const project = useProjectStore()
    const { editor } = mountEditor()

    for (let i = 0; i < 10; i++) editor.bumpBpm(1)

    // Nothing applied while the user is still spinning; only the box moves.
    expect(project.applyProjectBpm).not.toHaveBeenCalled()
    expect(editor.bpmInput.value).toBe('130.00')

    vi.advanceTimersByTime(250)

    expect(project.applyProjectBpm).toHaveBeenCalledTimes(1)
    expect(project.applyProjectBpm).toHaveBeenCalledWith(130)
  })

  it('clamps the pending target to the editable tempo range', () => {
    const project = useProjectStore()
    const { editor } = mountEditor()

    editor.bumpBpm(500)
    vi.advanceTimersByTime(250)

    expect(project.applyProjectBpm).toHaveBeenCalledWith(300)
  })

  it('commits immediately on blur without waiting for the settle delay', () => {
    const project = useProjectStore()
    const { editor } = mountEditor()

    editor.isEditingBpm.value = true
    editor.bpmInput.value = '128'
    editor.onBpmCommit()

    expect(project.applyProjectBpm).toHaveBeenCalledTimes(1)
    expect(project.applyProjectBpm).toHaveBeenCalledWith(128)
    expect(editor.bpmInput.value).toBe('128.00')

    vi.advanceTimersByTime(250)
    expect(project.applyProjectBpm).toHaveBeenCalledTimes(1)
  })

  it('commits a numeric box value, as v-model on a number input supplies it', () => {
    const project = useProjectStore()
    const { editor } = mountEditor()

    editor.isEditingBpm.value = true
    editor.bpmInput.value = 128
    editor.onBpmCommit()

    expect(project.applyProjectBpm).toHaveBeenCalledWith(128)
  })

  it('bumps from a numeric box value while the box is focused', () => {
    const project = useProjectStore()
    const { editor } = mountEditor()

    editor.isEditingBpm.value = true
    editor.bpmInput.value = 128
    editor.bumpBpm(1)
    vi.advanceTimersByTime(250)

    expect(project.applyProjectBpm).toHaveBeenCalledWith(129)
  })

  it('snaps back and applies nothing when the box is left blank', () => {
    const project = useProjectStore()
    const { editor } = mountEditor()

    editor.isEditingBpm.value = true
    editor.bpmInput.value = ''
    editor.onBpmCommit()

    expect(project.applyProjectBpm).not.toHaveBeenCalled()
    expect(editor.bpmInput.value).toBe('120.00')
  })

  it('drops a pending bump when the tempo changes elsewhere', async () => {
    const project = useProjectStore()
    const transport = useTransportStore()
    const { editor } = mountEditor()

    editor.bumpBpm(5)
    transport.setBpm(90)
    await nextTick()
    vi.advanceTimersByTime(250)

    expect(project.applyProjectBpm).not.toHaveBeenCalled()
    expect(editor.bpmInput.value).toBe('90.00')
  })

  it('applies a pending bump on unmount rather than losing it', () => {
    const project = useProjectStore()
    const { editor, unmount } = mountEditor()

    editor.bumpBpm(2)
    unmount()

    expect(project.applyProjectBpm).toHaveBeenCalledWith(122)
  })
})

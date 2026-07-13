import { computed, onBeforeUnmount, watch, type Ref } from 'vue'
import { send as sendBridge } from '@/lib/bridgeService'
import { useScratchSessionStore } from '@/stores/scratchSessionStore'
import { useTransportStore } from '@/stores/transportStore'
import { createScratchSessionLifecycle } from './scratchSessionLifecycle'

/** Source a scratch session edits: a timeline clip or a whole library item. */
export interface ScratchEditorSource {
  id: string
  isLibrary: boolean
}

export function useScratchEditorSession(
  open: Ref<boolean>,
  source: Ref<ScratchEditorSource | null>
) {
  const store = useScratchSessionStore()
  const transport = useTransportStore()
  const lifecycle = createScratchSessionLifecycle({
    open: (payload) => {
      sendBridge('SCRATCH_SESSION_OPEN', payload)
    },
    close: (payload) => {
      sendBridge('SCRATCH_SESSION_CLOSE', payload)
    },
    control: (payload) => {
      sendBridge('SCRATCH_SESSION_CONTROL', payload)
    },
    clearState: () => store.clear()
  })

  watch(
    [open, () => source.value?.id ?? null],
    ([isOpen, targetId], [wasOpen, previousId]) => {
      if (isOpen && targetId && (!wasOpen || targetId !== previousId)) {
        lifecycle.open(targetId, source.value?.isLibrary ?? false)
      } else if (!isOpen && wasOpen) {
        lifecycle.close()
      }
    },
    { immediate: true }
  )

  watch(
    () => store.current,
    (state) => {
      if (state) lifecycle.consume(state)
    }
  )

  // Recovery: when the engine comes back from a recovery cycle, the backend
  // session is gone. Clear stale IDs and reopen the current clip once recovery
  // completes, without retry loops.
  let wasRecovering = false
  watch(
    () => transport.engineRecovery,
    (phase) => {
      if (phase === 'recovering' || phase === 'restoring') {
        wasRecovering = true
        lifecycle.clearStaleOnRecovery()
        return
      }
      if (phase === 'ok' && wasRecovering) {
        wasRecovering = false
        const target = source.value
        if (open.value && target) {
          lifecycle.open(target.id, target.isLibrary)
        }
      }
    }
  )

  onBeforeUnmount(() => lifecycle.close())

  const isPlaying = computed(() => lifecycle.state.value?.status === 'playing')
  const canControl = computed(() => {
    const status = lifecycle.state.value?.status
    return (
      status === 'ready' ||
      status === 'paused' ||
      status === 'playing' ||
      status === 'recording'
    )
  })

  return { ...lifecycle, isPlaying, canControl }
}

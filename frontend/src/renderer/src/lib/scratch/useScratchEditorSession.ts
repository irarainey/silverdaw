import { computed, onBeforeUnmount, watch, type Ref } from 'vue'
import { send as sendBridge } from '@/lib/bridgeService'
import { useScratchSessionStore } from '@/stores/scratchSessionStore'
import { useTransportStore } from '@/stores/transportStore'
import { createScratchSessionLifecycle } from './scratchSessionLifecycle'

export function useScratchEditorSession(
  open: Ref<boolean>,
  clipId: Ref<string | null>
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
    [open, clipId],
    ([isOpen, targetClipId], [wasOpen, previousClipId]) => {
      if (isOpen && targetClipId && (!wasOpen || targetClipId !== previousClipId)) {
        lifecycle.open(targetClipId)
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
        const target = clipId.value
        if (open.value && target) {
          lifecycle.open(target)
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

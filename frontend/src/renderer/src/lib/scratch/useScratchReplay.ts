// Scratch draft/saved-pattern audition. Owns the local "is a replay running"
// flag, its bounded stop timer, and the notation playhead position derived
// from it. Replay is local-only audio feedback — it never touches the
// recorded draft itself (see scratchPatternPersistence for that).

import { computed, ref, type ComputedRef, type Ref } from 'vue'
import type { ScratchPattern, ScratchSessionStatePayload } from '@shared/bridge-protocol'

export interface ScratchReplayOptions {
  /** Whether the platter/crossfader would otherwise accept live input. */
  canControl: Ref<boolean>
  /** Authoritative session state, used only to read the replay playhead. */
  sessionState: Ref<ScratchSessionStatePayload | null>
  savedPatterns: Ref<readonly ScratchPattern[]>
  startPatternReplay(pattern: string | ScratchPattern): void
  stopPatternReplay(): void
}

export interface ScratchReplay {
  isPatternReplaying: Ref<boolean>
  /** `canControl`, narrowed so platter/crossfader/keyboard input is gated off during replay. */
  controlsEnabled: ComputedRef<boolean>
  /** Playhead position (0..1 across the cropped window), or null while idle. */
  notationReplayPositionNormalized: ComputedRef<number | null>
  startReplay(pattern: string | ScratchPattern): void
  stopReplay(): void
}

export function useScratchReplay(options: ScratchReplayOptions): ScratchReplay {
  const { canControl, sessionState, savedPatterns, startPatternReplay, stopPatternReplay } = options
  const isPatternReplaying = ref(false)
  let replayStopTimer: ReturnType<typeof setTimeout> | null = null

  function clearReplayTimer(): void {
    if (replayStopTimer !== null) {
      clearTimeout(replayStopTimer)
      replayStopTimer = null
    }
  }

  function stopReplay(): void {
    clearReplayTimer()
    if (isPatternReplaying.value) stopPatternReplay()
    isPatternReplaying.value = false
  }

  function startReplay(pattern: string | ScratchPattern): void {
    const replayPattern =
      typeof pattern === 'string'
        ? savedPatterns.value.find((saved) => saved.id === pattern)
        : pattern
    if (!replayPattern) return

    clearReplayTimer()
    startPatternReplay(pattern)
    isPatternReplaying.value = true
    const replayDurationMs = Math.max(
      1,
      Math.ceil((replayPattern.cropEndUs - replayPattern.cropStartUs) / 1000)
    )
    replayStopTimer = setTimeout(() => stopReplay(), replayDurationMs + 50)
  }

  const controlsEnabled = computed(() => canControl.value && !isPatternReplaying.value)

  const notationReplayPositionNormalized = computed<number | null>(() =>
    isPatternReplaying.value ? sessionState.value?.replayPositionNormalized ?? null : null
  )

  return { isPatternReplaying, controlsEnabled, notationReplayPositionNormalized, startReplay, stopReplay }
}

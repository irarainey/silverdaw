// Session playback transport for the scratch editor's Play/Pause and
// skip-to-start controls (and the Space shortcut). These drive the prepared
// backing bed via the general session control channel — they never spin the
// scratch clip itself, which is heard only when jogged — so they stay
// disabled until a backing is prepared, and during recording (which owns
// playback) or pattern replay (a local-only audition, see useScratchReplay).

import { computed, type ComputedRef, type Ref } from 'vue'
import type { ScratchSessionControlPayload } from '@shared/bridge-protocol'
import { buildSeekPayload } from './scratchControlHelpers'

export interface ScratchTransportControlsOptions {
  activeSessionId: Ref<string | null>
  canControl: Ref<boolean>
  backingReady: Ref<boolean>
  isRecording: Ref<boolean>
  isPatternReplaying: Ref<boolean>
  stopReplay(): void
  togglePlayback(): void
  sendControl(payload: ScratchSessionControlPayload): void
}

export interface ScratchTransportControls {
  transportEnabled: ComputedRef<boolean>
  onSkipToStart(): void
  onTogglePlay(): void
}

export function useScratchTransportControls(
  options: ScratchTransportControlsOptions
): ScratchTransportControls {
  const {
    activeSessionId,
    canControl,
    backingReady,
    isRecording,
    isPatternReplaying,
    stopReplay,
    togglePlayback,
    sendControl
  } = options

  const transportEnabled = computed(
    () => canControl.value && backingReady.value && !isRecording.value && !isPatternReplaying.value
  )

  function onSkipToStart(): void {
    const sid = activeSessionId.value
    if (!sid || !transportEnabled.value) return
    sendControl(buildSeekPayload(sid, 0))
  }

  function onTogglePlay(): void {
    if (isPatternReplaying.value) stopReplay()
    else if (transportEnabled.value) togglePlayback()
  }

  return { transportEnabled, onSkipToStart, onTogglePlay }
}

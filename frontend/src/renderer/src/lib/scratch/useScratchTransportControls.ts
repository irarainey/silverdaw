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
  /** True while the backing bed is playing, so pause is always reachable. */
  isPlaying: Ref<boolean>
  /** True while the project transport or the preview voice owns the audio
   *  output. Injected rather than read from a store so the composable stays
   *  free of Pinia, as its callers and tests expect. */
  otherPlaybackActive: Ref<boolean>
  togglePlayback(): void
  sendControl(payload: ScratchSessionControlPayload): void
}

export interface ScratchTransportControls {
  transportEnabled: ComputedRef<boolean>
  playBlockedReason: ComputedRef<string>
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
    otherPlaybackActive,
    isPlaying,
    togglePlayback,
    sendControl
  } = options

  const transportEnabled = computed(
    () => canControl.value && backingReady.value && !isRecording.value && !isPatternReplaying.value
  )

  // Only one source owns the audio output at a time, so the backing cannot
  // start while the project or a file preview is playing. Pausing stays
  // allowed, so the backing can never be left stuck playing.
  const playBlockedReason = computed(() =>
    !isPlaying.value && otherPlaybackActive.value ? 'Stop other playback to play the backing' : ''
  )

  function onSkipToStart(): void {
    const sid = activeSessionId.value
    if (!sid || !transportEnabled.value) return
    sendControl(buildSeekPayload(sid, 0))
  }

  function onTogglePlay(): void {
    if (transportEnabled.value && !playBlockedReason.value) togglePlayback()
  }

  return { transportEnabled, playBlockedReason, onSkipToStart, onTogglePlay }
}

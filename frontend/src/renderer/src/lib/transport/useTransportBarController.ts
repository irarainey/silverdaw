import { computed, onBeforeUnmount, onMounted, ref, watch, type ComponentPublicInstance } from 'vue'
import { useProjectStore } from '@/stores/projectStore'
import { useLibraryStore } from '@/stores/libraryStore'
import { useTransportStore } from '@/stores/transportStore'
import { useUiStore } from '@/stores/uiStore'
import { useAudioDeviceStore } from '@/stores/audioDeviceStore'
import { useNotificationsStore } from '@/stores/notificationsStore'
import { send as sendBridge } from '@/lib/bridgeService'
import { log } from '@/lib/log'
import { MAX_MASTER_DB, taperPositionToLinear } from '@/lib/audio/db'
import { barPositionDisplay, formatTime, parseTime } from '@/lib/musicTime'
import { useAudioQuickSwitch } from '@/lib/transport/useAudioQuickSwitch'
import { useTransportSkip } from '@/lib/transport/useTransportSkip'

export function useTransportBarController() {
  const project = useProjectStore()
  const library = useLibraryStore()
  const transport = useTransportStore()
  const ui = useUiStore()
  const audioDevices = useAudioDeviceStore()
  const notifications = useNotificationsStore()

  // ─── Audio output device quick-switch ────────────────────────────────────
  // The SFC only owns document listeners for outside-click / Escape.
  const {
    audioMenuOpen,
    audioMenuRoot,
    audioMenuLabel,
    audioLatencyCaption,
    quickSwitchDevices,
    toggleAudioMenu,
    pickUniqueDevice,
    isCurrentUniqueDevice,
    onAudioMenuDocClick,
    onAudioMenuKey
  } = useAudioQuickSwitch()

  function setAudioMenuRoot(el: Element | ComponentPublicInstance | null): void {
    audioMenuRoot.value = el instanceof HTMLElement ? el : null
  }

  onMounted(() => {
    document.addEventListener('mousedown', onAudioMenuDocClick)
    document.addEventListener('keydown', onAudioMenuKey)
  })
  onBeforeUnmount(() => {
    document.removeEventListener('mousedown', onAudioMenuDocClick)
    document.removeEventListener('keydown', onAudioMenuKey)
  })

  // User edits update local state and persist to the backend.
  function applyBpm(bpm: number): void {
    transport.setBpm(bpm)
    // Send the clamped value.
    sendBridge('PROJECT_SET_BPM', { bpm: transport.bpm })
  }

  function applyProjectLength(ms: number): void {
    const minLengthMs = project.longestClipEndMs
    const requestedMs = Math.max(0, Math.floor(ms))
    const nextMs = Math.max(requestedMs, minLengthMs)
    if (requestedMs < minLengthMs) {
      notifications.pushInfo(
        `Project length cannot be shorter than the last clip (${formatTime(minLengthMs)}).`
      )
    }
    project.setProjectLengthMs(nextMs)
    // Send the post-clamp length.
    sendBridge('PROJECT_SET_LENGTH', { lengthMs: project.durationMs })
  }

  const positionDisplay = computed(() => formatTime(transport.positionMs))

  /** Playhead as 0-indexed Bar.Beat.Sub using the timeline grid rounding. */
  const barPosition = computed(() => barPositionDisplay(transport.positionMs, transport.bpm))

  /** Project sample-rate label using the same fallback as import preflight. */
  const effectiveSampleRateLabel = computed(() => {
    const projectRate = project.targetSampleRate
    if (projectRate === 44100 || projectRate === 48000) {
      return `${(projectRate / 1000).toFixed(1)} kHz`
    }
    const fallback = ui.defaultProjectSampleRate
    return `${(fallback / 1000).toFixed(1)} kHz`
  })

  // Length input mirrors the store while not focused, then parses on commit.
  const lengthInput = ref(formatTime(project.durationMs))
  const isEditingLength = ref(false)

  watch(
    () => project.durationMs,
    (ms) => {
      if (!isEditingLength.value) lengthInput.value = formatTime(ms)
    }
  )

  // Renderer pauses at project end because the audio engine streams past it.
  watch(
    () => transport.positionMs,
    (ms) => {
      if (!transport.isPlaying) return
      if (transport.midiPlaybackHoldActive) return
      const selection = ui.timelineSelection
      if (selection && ms >= selection.endMs) {
        if (ui.loopTimelineSelection) {
          transport.setPosition(selection.startMs)
          ui.requestTimelineScrollToPosition(selection.startMs, true)
          sendBridge('TRANSPORT_SEEK', {
            positionMs: selection.startMs,
            preserveEffects: true
          })
        } else {
          sendBridge('TRANSPORT_PAUSE')
          transport.setPlaybackState(false)
          transport.setPosition(selection.endMs)
        }
        return
      }
      const end = project.durationMs
      if (end <= 0) return
      if (ms < end) return
      sendBridge('TRANSPORT_PAUSE')
      // Flip the play button without waiting for backend ack.
      transport.setPlaybackState(false)
      transport.setPosition(end)
    }
  )

  // BPM mirrors the store while not focused.
  const bpmInput = ref(transport.bpm.toFixed(2))
  const isEditingBpm = ref(false)
  watch(
    () => transport.bpm,
    (bpm) => {
      if (!isEditingBpm.value) bpmInput.value = bpm.toFixed(2)
    }
  )

  const lengthEditable = computed(() => project.tracks.length > 0)
  /** Timing readouts are disabled until the project has playable content. */
  const timingEditable = lengthEditable

  const projectClipCount = computed(() =>
    project.tracks.reduce((count, track) => count + track.clipIds.length, 0)
  )

  // Disable starting playback from project end; Pause remains reachable. Also disabled while
  // the audio device is still opening on the backend worker thread (transport isn't safe yet).
  const audioReady = computed(() => transport.audioState === 'ready')
  const playDisabled = computed(() => {
    if (transport.isPlaying) return false
    if (!audioReady.value) return true
    if (ui.timelineSelection) return false
    const end = project.durationMs
    return end > 0 && transport.positionMs >= end
  })

  const playButtonTitle = computed(() => {
    if (transport.isPlaybackHeld) return 'Playback held by MIDI jog wheel'
    if (transport.isPlaying) return 'Pause'
    if (transport.audioState === 'no_device') {
      return 'No audio output available — choose an output device'
    }
    if (transport.audioState === 'failed') return 'Audio engine failed to start'
    if (!audioReady.value) return 'Starting audio engine…'
    if (ui.timelineSelection) {
      return ui.loopTimelineSelection ? 'Loop Selection' : 'Play Selection'
    }
    if (playDisabled.value) return 'Playhead at end of project — skip back to play'
    return 'Play'
  })

  const skipBackTitle = computed(() =>
    ui.skipButtonTarget === 'markers' ? 'Skip to previous marker' : 'Skip to start'
  )
  const skipForwardTitle = computed(() =>
    ui.skipButtonTarget === 'markers' ? 'Skip to next marker' : 'Skip to end'
  )

  const projectBpmPending = computed(() => {
    if (!ui.seedProjectTempoFromFirstClip) return false
    if (!timingEditable.value || projectClipCount.value === 0) return false
    const projectHasAnalysedItem = library.items.some((item) => typeof item.bpm === 'number' && item.bpm > 0)
    if (projectHasAnalysedItem) return false
    return library.imports.some(
      (entry) => entry.stage === 'detectingTempo' || entry.stage === 'detectingBeats'
    )
  })

  function onLengthCommit(): void {
    isEditingLength.value = false
    const ms = parseTime(lengthInput.value)
    if (ms === null) {
      // Reject and snap back.
      lengthInput.value = formatTime(project.durationMs)
      return
    }
    applyProjectLength(ms)
    lengthInput.value = formatTime(project.durationMs)
  }

  function onLengthKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
    else if (e.key === 'Escape') {
      lengthInput.value = formatTime(project.durationMs)
        ; (e.target as HTMLInputElement).blur()
    }
    else if (e.key === 'ArrowUp') {
      e.preventDefault()
      bumpLength(e.shiftKey ? 10 : 1)
    }
    else if (e.key === 'ArrowDown') {
      e.preventDefault()
      bumpLength(e.shiftKey ? -10 : -1)
    }
  }

  /** Bump length from in-edit text when focused, otherwise from the store. */
  function bumpLength(deltaSeconds: number): void {
    if (!lengthEditable.value) return
    const base = isEditingLength.value
      ? parseTime(lengthInput.value) ?? project.durationMs
      : project.durationMs
    const next = Math.max(0, base + deltaSeconds * 1000)
    applyProjectLength(next)
    lengthInput.value = formatTime(project.durationMs)
  }

  function onBpmCommit(): void {
    isEditingBpm.value = false
    const n = Number(bpmInput.value)
    if (!Number.isFinite(n)) {
      bpmInput.value = transport.bpm.toFixed(2)
      return
    }
    applyBpm(n)
    bpmInput.value = transport.bpm.toFixed(2)
  }

  function onBpmKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
    else if (e.key === 'Escape') {
      bpmInput.value = transport.bpm.toFixed(2)
        ; (e.target as HTMLInputElement).blur()
    }
    else if (e.key === 'ArrowUp') {
      e.preventDefault()
      bumpBpm(e.altKey ? 0.01 : 1)
    }
    else if (e.key === 'ArrowDown') {
      e.preventDefault()
      bumpBpm(e.altKey ? -0.01 : -1)
    }
  }

  /** Bump BPM; `setBpm` clamps and rounds. */
  function bumpBpm(delta: number): void {
    const base = isEditingBpm.value ? Number(bpmInput.value) : transport.bpm
    const start = Number.isFinite(base) ? base : transport.bpm
    applyBpm(start + delta)
    bpmInput.value = transport.bpm.toFixed(2)
  }

  // ─── Transport navigation ────────────────────────────────────────────────
  const { onSkipBack, onPlay, onSkipForward } = useTransportSkip()

  function onToggleFollow(): void {
    ui.setFollowPlayback(!ui.followPlayback)
    log.info('transport', `follow playback=${ui.followPlayback}`)
  }

  function onToggleLoopSelection(): void {
    ui.setLoopTimelineSelection(!ui.loopTimelineSelection)
    ui.persistTimelineSelectionView()
  }

  function onMasterVolumeInput(event: Event): void {
    // Send every drag tick; backend coalesces the stream into one undo step.
    const target = event.target as HTMLInputElement
    const pos = Number(target.value)
    if (!Number.isFinite(pos)) return
    const linear = taperPositionToLinear(pos, MAX_MASTER_DB)
    project.setMasterVolume(Math.min(1, Math.max(0, linear)))
  }

  return {
    project,
    transport,
    ui,
    audioDevices,
    audioMenuOpen,
    setAudioMenuRoot,
    audioMenuLabel,
    audioLatencyCaption,
    quickSwitchDevices,
    toggleAudioMenu,
    pickUniqueDevice,
    isCurrentUniqueDevice,
    positionDisplay,
    barPosition,
    effectiveSampleRateLabel,
    lengthInput,
    isEditingLength,
    bpmInput,
    isEditingBpm,
    lengthEditable,
    timingEditable,
    projectBpmPending,
    audioReady,
    playDisabled,
    playButtonTitle,
    skipBackTitle,
    skipForwardTitle,
    onLengthCommit,
    onLengthKeydown,
    bumpLength,
    onBpmCommit,
    onBpmKeydown,
    bumpBpm,
    onSkipBack,
    onPlay,
    onSkipForward,
    onToggleFollow,
    onToggleLoopSelection,
    onMasterVolumeInput
  }
}

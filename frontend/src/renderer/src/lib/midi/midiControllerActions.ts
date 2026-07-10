import { send as sendBridge } from '@/lib/bridgeService'
import {
  seekToNextMarker,
  seekToPreviousMarker,
  toggleTransportPlayback
} from '@/lib/transport/useTransportSkip'
import { useProjectStore } from '@/stores/projectStore'
import { useTransportStore } from '@/stores/transportStore'
import { useUiStore } from '@/stores/uiStore'
import type { MidiControlPayload } from '@shared/bridge-protocol'

const JOG_MS_PER_STEP = {
  jogScratch: 9,
  jogPitchBend: 22,
  jogSearch: 88,
  wheelPitchBend: 22,
  wheelSearch: 88
} as const

let pendingSeekDeltaMs = 0
let seekFrame: number | null = null

function flushTimelineJog(): void {
  seekFrame = null
  const project = useProjectStore()
  const transport = useTransportStore()
  const ui = useUiStore()
  const projectEnd = project.durationMs
  const unclamped = transport.positionMs + pendingSeekDeltaMs
  pendingSeekDeltaMs = 0
  const positionMs = Math.max(0, projectEnd > 0 ? Math.min(projectEnd, unclamped) : unclamped)
  if (positionMs === transport.positionMs) return
  transport.setPosition(positionMs)
  sendBridge('TRANSPORT_SEEK', { positionMs })
  ui.requestTimelineScrollToPosition(positionMs)
}

function queueTimelineJog(control: keyof typeof JOG_MS_PER_STEP, delta: number): void {
  pendingSeekDeltaMs += delta * JOG_MS_PER_STEP[control]
  if (seekFrame !== null) return
  seekFrame = globalThis.requestAnimationFrame(flushTimelineJog)
}

export function handleMidiControl(payload: MidiControlPayload): void {
  if (payload.kind === 'relative') {
    queueTimelineJog(payload.control, payload.value)
    return
  }
  if (payload.kind !== 'button' || !payload.pressed) return

  switch (payload.control) {
    case 'playPause':
      toggleTransportPlayback('MIDI')
      break
    case 'previousMarker':
      seekToPreviousMarker('MIDI Cue')
      break
    case 'nextMarker':
      seekToNextMarker('MIDI Shift+Cue')
      break
    case 'shift':
    case 'jogTouch':
      break
  }
}

export function resetMidiControllerActionsForTests(): void {
  if (seekFrame !== null) globalThis.cancelAnimationFrame(seekFrame)
  seekFrame = null
  pendingSeekDeltaMs = 0
}

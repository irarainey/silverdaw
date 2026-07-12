import { send as sendBridge } from '@/lib/bridgeService'
import {
  seekToMarkerIndex,
  seekToNextMarker,
  seekToPreviousMarker,
  toggleTransportPlayback
} from '@/lib/transport/useTransportSkip'
import { msPerSubBeat } from '@/lib/musicTime'
import {
  linearToTaperPosition,
  MAX_MASTER_DB,
  MAX_TRACK_DB,
  taperPositionToLinear
} from '@/lib/audio/db'
import {
  handleBrowsePress,
  handleBrowseRotation,
  resetMidiBrowseActionsForTests
} from '@/lib/midi/midiBrowseActions'
import {
  handleMidiJogTouch,
  releaseAllMidiPlaybackHolds,
  resetMidiPlaybackHoldForTests
} from '@/lib/midi/midiPlaybackHold'
import { useProjectStore } from '@/stores/projectStore'
import { useMidiDeviceStore } from '@/stores/midiDeviceStore'
import { useTransportStore } from '@/stores/transportStore'
import { useUiStore } from '@/stores/uiStore'
import type { MidiControlPayload } from '@shared/bridge-protocol'

const JOG_MS_PER_STEP = {
  jogScratch: 14,
  jogPitchBend: 32,
  jogSearch: 128,
  wheelPitchBend: 32,
  wheelSearch: 128
} as const

const SNAPPED_JOG_PACING = {
  jogScratch: { unitsPerBeat: 1, minIntervalMs: 20 },
  jogPitchBend: { unitsPerBeat: 1, minIntervalMs: 20 },
  jogSearch: { unitsPerBeat: 1, minIntervalMs: 10 },
  wheelPitchBend: { unitsPerBeat: 1, minIntervalMs: 20 },
  wheelSearch: { unitsPerBeat: 1, minIntervalMs: 10 }
} as const

let pendingSeekDeltaMs = 0
let pendingBeatSteps = 0
let snappedJogUnits = 0
let lastSnappedSeekAt = Number.NEGATIVE_INFINITY
let pendingSnapUnitsPerBeat: number = SNAPPED_JOG_PACING.jogScratch.unitsPerBeat
let pendingSnapMinIntervalMs: number = SNAPPED_JOG_PACING.jogScratch.minIntervalMs
let pendingJogMode: 'snapped' | 'free' | null = null
let pendingJogDeviceIdentifier: string | null = null
let seekFrame: number | null = null
const FOURTEEN_BIT_MIDPOINT = 8192 / 16383 // Normalized center of a 14-bit CC.
const DIAL_CATCH_UP_MS = 150
const DIAL_VALUE_EPSILON = 1e-4

interface DialCatchUp {
  from: number
  target: number
  startedAt: number
  lastOutput: number
  read: () => number | null
  apply: (value: number) => void
}

type TrackAbsolutePayload = Extract<MidiControlPayload, { kind: 'absolute'; deck: 1 | 2 }>

const lastMidiDialValues = new Map<string, number>()
const dialCatchUps = new Map<string, DialCatchUp>()
let dialFrame: number | null = null

function flushTimelineJog(timestamp: number): void {
  seekFrame = null
  const project = useProjectStore()
  const transport = useTransportStore()
  const ui = useUiStore()
  const projectEnd = project.durationMs
  let unclamped = transport.positionMs + pendingSeekDeltaMs
  if (pendingJogMode === 'snapped' && pendingBeatSteps !== 0) {
    snappedJogUnits += pendingBeatSteps
    if (
      Math.abs(snappedJogUnits) >= pendingSnapUnitsPerBeat &&
      timestamp - lastSnappedSeekAt >= pendingSnapMinIntervalMs
    ) {
      const gridLineMs = msPerSubBeat(transport.bpm)
      const gridStep = Math.sign(snappedJogUnits)
      snappedJogUnits -= gridStep * pendingSnapUnitsPerBeat
      lastSnappedSeekAt = timestamp
      if (gridStep > 0) {
        unclamped =
          (Math.floor(transport.positionMs / gridLineMs + 1e-9) + gridStep) * gridLineMs
      } else {
        unclamped =
          (Math.ceil(transport.positionMs / gridLineMs - 1e-9) + gridStep) * gridLineMs
      }
    }
  }
  pendingSeekDeltaMs = 0
  pendingBeatSteps = 0
  pendingJogMode = null
  const jogDeviceIdentifier = pendingJogDeviceIdentifier
  pendingJogDeviceIdentifier = null
  const positionMs = Math.max(0, projectEnd > 0 ? Math.min(projectEnd, unclamped) : unclamped)
  const deltaMs = positionMs - transport.positionMs
  if (deltaMs === 0) return
  transport.setPosition(positionMs)
  if (
    transport.midiPlaybackHoldActive &&
    jogDeviceIdentifier !== null &&
    useMidiDeviceStore().isScrubAudioEnabled(jogDeviceIdentifier)
  ) {
    sendBridge('TRANSPORT_SCRUB', { positionMs, deltaMs })
  } else {
    sendBridge('TRANSPORT_SEEK', { positionMs })
  }
  ui.requestTimelineScrollToPosition(positionMs)
}

function queueTimelineJog(
  control: keyof typeof JOG_MS_PER_STEP,
  delta: number,
  snapToGrid: boolean,
  deviceIdentifier: string
): void {
  const mode = snapToGrid ? 'snapped' : 'free'
  if (pendingJogMode !== null && pendingJogMode !== mode) {
    pendingSeekDeltaMs = 0
    pendingBeatSteps = 0
  }
  pendingJogMode = mode
  pendingJogDeviceIdentifier = deviceIdentifier
  if (snapToGrid) {
    const pacing = SNAPPED_JOG_PACING[control]
    pendingSnapUnitsPerBeat = pacing.unitsPerBeat
    pendingSnapMinIntervalMs = pacing.minIntervalMs
    if (snappedJogUnits !== 0 && Math.sign(snappedJogUnits) !== Math.sign(delta)) {
      snappedJogUnits = 0
    }
    pendingBeatSteps += delta
  } else {
    snappedJogUnits = 0
    pendingSeekDeltaMs += delta * JOG_MS_PER_STEP[control]
  }
  if (seekFrame !== null) return
  seekFrame = globalThis.requestAnimationFrame(flushTimelineJog)
}

function normalizedToBipolar(value: number): number {
  return value <= FOURTEEN_BIT_MIDPOINT
    ? value / FOURTEEN_BIT_MIDPOINT - 1
    : (value - FOURTEEN_BIT_MIDPOINT) / (1 - FOURTEEN_BIT_MIDPOINT)
}

function bipolarToNormalized(value: number): number {
  const clamped = Math.max(-1, Math.min(1, value))
  return clamped <= 0
    ? (clamped + 1) * FOURTEEN_BIT_MIDPOINT
    : FOURTEEN_BIT_MIDPOINT + clamped * (1 - FOURTEEN_BIT_MIDPOINT)
}

function scheduleDialCatchUps(): void {
  if (dialFrame !== null) return
  dialFrame = globalThis.requestAnimationFrame(flushDialCatchUps)
}

function flushDialCatchUps(timestamp: number): void {
  dialFrame = null
  for (const [key, catchUp] of dialCatchUps) {
    const current = catchUp.read()
    if (current === null || Math.abs(current - catchUp.lastOutput) > DIAL_VALUE_EPSILON) {
      dialCatchUps.delete(key)
      continue
    }

    const progress = Math.max(0, Math.min(1, (timestamp - catchUp.startedAt) / DIAL_CATCH_UP_MS))
    const eased = 1 - Math.pow(1 - progress, 3)
    const output = catchUp.from + (catchUp.target - catchUp.from) * eased
    catchUp.apply(output)
    catchUp.lastOutput = output

    if (progress >= 1) {
      lastMidiDialValues.set(key, catchUp.target)
      dialCatchUps.delete(key)
    }
  }

  if (dialCatchUps.size > 0) scheduleDialCatchUps()
}

function handleDialValue(
  key: string,
  hardwareValue: number,
  read: () => number | null,
  apply: (value: number) => void
): void {
  const current = read()
  if (current === null) return

  const active = dialCatchUps.get(key)
  if (active) {
    active.from = current
    active.target = hardwareValue
    active.startedAt = globalThis.performance.now()
    active.lastOutput = current
    scheduleDialCatchUps()
    return
  }

  const lastMidiValue = lastMidiDialValues.get(key)
  const softwareHasDrifted =
    lastMidiValue === undefined || Math.abs(current - lastMidiValue) > DIAL_VALUE_EPSILON
  if (softwareHasDrifted && Math.abs(current - hardwareValue) > DIAL_VALUE_EPSILON) {
    dialCatchUps.set(key, {
      from: current,
      target: hardwareValue,
      startedAt: globalThis.performance.now(),
      lastOutput: current,
      read,
      apply
    })
    scheduleDialCatchUps()
    return
  }

  apply(hardwareValue)
  lastMidiDialValues.set(key, hardwareValue)
}

function readTrackControl(
  trackId: string,
  control: TrackAbsolutePayload['control']
): number | null {
  const track = useProjectStore().tracks.find((candidate) => candidate.id === trackId)
  if (!track) return null
  switch (control) {
    case 'trackGain':
      return linearToTaperPosition(track.volume, MAX_TRACK_DB)
    case 'toneBass':
      return bipolarToNormalized((track.toneBassDb ?? 0) / 15)
    case 'toneMid':
      return bipolarToNormalized((track.toneMidDb ?? 0) / 15)
    case 'toneTreble':
      return bipolarToNormalized((track.toneTrebleDb ?? 0) / 15)
    case 'filter':
      return bipolarToNormalized(track.toneFilter ?? 0)
  }
}

function applyTrackControl(
  trackId: string,
  control: TrackAbsolutePayload['control'],
  value: number
): void {
  const project = useProjectStore()
  switch (control) {
    case 'trackGain':
      project.setTrackVolume(trackId, taperPositionToLinear(value, MAX_TRACK_DB))
      break
    case 'toneBass':
      project.setTrackTone(trackId, { bassDb: normalizedToBipolar(value) * 15 })
      break
    case 'toneMid':
      project.setTrackTone(trackId, { midDb: normalizedToBipolar(value) * 15 })
      break
    case 'toneTreble':
      project.setTrackTone(trackId, { trebleDb: normalizedToBipolar(value) * 15 })
      break
    case 'filter':
      project.setTrackTone(trackId, { filter: normalizedToBipolar(value) })
      break
  }
}

function applyAbsoluteControl(payload: Extract<MidiControlPayload, { kind: 'absolute' }>): void {
  const project = useProjectStore()
  if (payload.control === 'crossfader') return
  if (payload.control === 'masterVolume') {
    handleDialValue(
      `${payload.deviceIdentifier}:masterVolume`,
      payload.value,
      () => linearToTaperPosition(useProjectStore().masterVolume, MAX_MASTER_DB),
      (value) => useProjectStore().setMasterVolume(taperPositionToLinear(value, MAX_MASTER_DB))
    )
    return
  }
  if (payload.deck === null) return

  const trackId = project.selectedTrackId
  if (!trackId) return
  const key = `${payload.deviceIdentifier}:${payload.deck}:${payload.control}:${trackId}`
  if (payload.control !== 'trackGain') {
    const ui = useUiStore()
    ui.setLibraryPanelCollapsed(false)
    project.setFxTab('track')
    project.setFxPanelOpen(true)
  }
  // Physical deck identifies the source control, not a Silverdaw track assignment.
  handleDialValue(
    key,
    payload.value,
    () => readTrackControl(trackId, payload.control),
    (value) => applyTrackControl(trackId, payload.control, value)
  )
}

export function handleMidiControl(payload: MidiControlPayload): void {
  if (payload.kind === 'relative') {
    if (payload.control === 'browseTracks') {
      handleBrowseRotation(payload.deviceIdentifier, payload.value, false)
    } else if (payload.control === 'timelineZoom') {
      if (handleBrowseRotation(payload.deviceIdentifier, -payload.value, true)) return
      const ui = useUiStore()
      const action = payload.value > 0 ? 'in' : 'out'
      ui.requestTimelineZoom(action)
    } else if (payload.deck !== null) {
      queueTimelineJog(
        payload.control,
        payload.value,
        useMidiDeviceStore().syncPressed[payload.deck],
        payload.deviceIdentifier
      )
    }
    return
  }
  if (payload.kind === 'absolute') {
    applyAbsoluteControl(payload)
    return
  }
  if (payload.kind === 'button' && payload.control === 'jogTouch') {
    handleMidiJogTouch(payload.deviceIdentifier, payload.deck, payload.pressed)
    return
  }
  if (payload.kind !== 'button' || !payload.pressed) return

  switch (payload.control) {
    case 'playPause':
      toggleTransportPlayback('MIDI')
      break
    case 'browsePress':
      handleBrowsePress(payload.deviceIdentifier)
      break
    case 'previousMarker':
      seekToPreviousMarker('MIDI Cue')
      break
    case 'nextMarker':
      seekToNextMarker('MIDI Shift+Cue')
      break
    case 'markerJump':
      seekToMarkerIndex(payload.pad - 1, `MIDI Hot Cue ${payload.pad}`)
      break
    case 'markerToggle': {
      const project = useProjectStore()
      const marker = project.markers[payload.pad - 1]
      if (marker) {
        project.removeMarker(marker.id)
      } else {
        project.addMarkerAt(useTransportStore().positionMs)
      }
      break
    }
    case 'shift':
    case 'syncModifier':
      break
  }
}

function clearPendingMidiControllerActions(): void {
  if (seekFrame !== null) globalThis.cancelAnimationFrame(seekFrame)
  if (dialFrame !== null) globalThis.cancelAnimationFrame(dialFrame)
  seekFrame = null
  dialFrame = null
  pendingSeekDeltaMs = 0
  pendingBeatSteps = 0
  snappedJogUnits = 0
  lastSnappedSeekAt = Number.NEGATIVE_INFINITY
  pendingSnapUnitsPerBeat = SNAPPED_JOG_PACING.jogScratch.unitsPerBeat
  pendingSnapMinIntervalMs = SNAPPED_JOG_PACING.jogScratch.minIntervalMs
  pendingJogMode = null
  pendingJogDeviceIdentifier = null
  lastMidiDialValues.clear()
  dialCatchUps.clear()
}

export function suspendMidiControllerActions(): void {
  clearPendingMidiControllerActions()
  releaseAllMidiPlaybackHolds()
}

export function resetMidiControllerActionsForTests(): void {
  clearPendingMidiControllerActions()
  resetMidiBrowseActionsForTests()
  resetMidiPlaybackHoldForTests()
}

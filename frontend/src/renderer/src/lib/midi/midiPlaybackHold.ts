import { send as sendBridge } from '@/lib/bridgeService'
import { log } from '@/lib/log'
import { useProjectStore } from '@/stores/projectStore'
import { useTransportStore } from '@/stores/transportStore'

function touchKey(deviceIdentifier: string, deck: 1 | 2): string {
  return `${deviceIdentifier}:${deck}`
}

function resumeAfterFinalRelease(finalRelease: boolean): void {
  if (!finalRelease) return
  const transport = useTransportStore()
  if (!transport.isPlaying) return
  const end = useProjectStore().durationMs
  if (end > 0 && transport.positionMs >= end) {
    transport.setPlaybackState(false)
    return
  }
  log.info('midi', 'final jog touch released; resuming playback')
  sendBridge('TRANSPORT_PLAY')
}

export function handleMidiJogTouch(
  deviceIdentifier: string,
  deck: 1 | 2,
  pressed: boolean
): void {
  const key = touchKey(deviceIdentifier, deck)
  const transport = useTransportStore()
  if (!pressed) {
    resumeAfterFinalRelease(transport.endMidiPlaybackHold(key))
    return
  }
  if (!transport.beginMidiPlaybackHold(key)) return

  if (transport.isPlaying) {
    log.info('midi', `deck ${deck} jog touched; holding playback`)
    sendBridge('TRANSPORT_PAUSE')
  }
}

export function releaseMidiPlaybackHoldsForDeck(
  deviceIdentifier: string,
  deck: 1 | 2
): void {
  const transport = useTransportStore()
  resumeAfterFinalRelease(transport.endMidiPlaybackHold(touchKey(deviceIdentifier, deck)))
}

export function releaseMidiPlaybackHoldsForDevice(deviceIdentifier: string): void {
  const transport = useTransportStore()
  resumeAfterFinalRelease(transport.endMidiPlaybackHoldsForDevice(deviceIdentifier))
}

export function releaseAllMidiPlaybackHolds(): void {
  const transport = useTransportStore()
  if (!transport.midiPlaybackHoldActive) return
  transport.clearMidiPlaybackHolds()
  resumeAfterFinalRelease(true)
}

export function resetMidiPlaybackHoldForTests(): void {
  useTransportStore().clearMidiPlaybackHolds()
}

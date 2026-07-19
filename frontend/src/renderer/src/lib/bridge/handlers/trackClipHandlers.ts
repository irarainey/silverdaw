// Track/clip-domain inbound handlers: optimistic add/remove reconciliation and
// backend-canonical mirroring of per-track/clip parameters.

import { useProjectStore } from '@/stores/projectStore'
import { useLibraryStore } from '@/stores/libraryStore'
import { log } from '@/lib/log'
import type { AutomationParamId } from '@shared/bridge-protocol'
import type { BridgeInboundHandler, BridgeInboundHandlers } from '@/lib/bridge/handlerTypes'

// CLIP_ADDED and CLIP_ADD_FAILED share one reconciliation path; failures remove and toast.
const handleClipAddResult: BridgeInboundHandler<'CLIP_ADDED' | 'CLIP_ADD_FAILED'> = (payload) => {
  useProjectStore().confirmClipAdd(payload.trackId, payload.clipId, payload.ok, payload.error)
}

export const trackClipBridgeHandlers: BridgeInboundHandlers<
  | 'CLIP_ADDED'
  | 'CLIP_ADD_FAILED'
  | 'TRACK_ADDED'
  | 'TRACK_REMOVED'
  | 'CLIP_REMOVED'
  | 'TRACK_GAIN_APPLIED'
  | 'TRACK_MUTE_APPLIED'
  | 'TRACK_SOLO_APPLIED'
  | 'CLIP_WARP_APPLIED'
  | 'TRACK_TONE_APPLIED'
  | 'TRACK_SENDS_APPLIED'
  | 'TRACK_PAN_APPLIED'
  | 'TRACK_LEVELER_APPLIED'
  | 'TRACK_PUNCH_APPLIED'
  | 'TRACK_SATURATION_APPLIED'
  | 'TRACK_BIT_CRUSHER_APPLIED'
  | 'TRACK_AUTOMATION_APPLIED'
  | 'CLIP_ENVELOPE_APPLIED'
> = {
  CLIP_ADDED: handleClipAddResult,
  CLIP_ADD_FAILED: handleClipAddResult,

  TRACK_ADDED: (payload) => {
    // Diagnostic only: track was already created optimistically.
    if (!payload.ok) {
      log.warn('bridge', `TRACK_ADDED ok=false for ${payload.trackId}`)
    }
  },

  TRACK_REMOVED: (payload) => {
    // Diagnostic only: track was already removed optimistically.
    if (!payload.ok) {
      log.warn('bridge', `TRACK_REMOVED ok=false for ${payload.trackId}`)
    }
  },

  CLIP_REMOVED: (payload) => {
    // Diagnostic only: clip was already removed optimistically.
    if (!payload.ok) {
      log.warn('bridge', `CLIP_REMOVED ok=false for ${payload.clipId}`)
    }
  },

  TRACK_GAIN_APPLIED: (payload) => {
    // Diagnostic only: gain was already applied optimistically.
    if (!payload.ok) {
      log.warn('bridge', `TRACK_GAIN_APPLIED ok=false for ${payload.trackId} gain=${payload.gain}`)
    }
  },

  TRACK_MUTE_APPLIED: (payload) => {
    if (!payload.ok) {
      log.warn('bridge', `TRACK_MUTE_APPLIED ok=false for ${payload.trackId} muted=${payload.muted}`)
    }
  },

  TRACK_SOLO_APPLIED: (payload) => {
    if (!payload.ok) {
      log.warn('bridge', `TRACK_SOLO_APPLIED ok=false for ${payload.trackId} soloed=${payload.soloed}`)
    }
  },

  CLIP_WARP_APPLIED: (payload) => {
    // Mirror backend warp changes locally without echoing.
    const project = useProjectStore()
    project.setClipWarp(
      payload.clipId,
      {
        warpEnabled: payload.warpEnabled,
        warpMode: payload.warpMode,
        tempoRatio: payload.tempoRatio,
        semitones: payload.semitones,
        cents: payload.cents,
        pendingAutoWarp: payload.pendingAutoWarp,
        effectiveDurationMs: payload.effectiveDurationMs,
        effectiveTempoRatio: payload.effectiveTempoRatio,
        effectiveWarpActive: payload.effectiveWarpActive
      },
      { localOnly: true }
    )
    const clip = project.clips[payload.clipId]
    if (clip) useLibraryStore().finishItemWarping(clip.libraryItemId)
    log.info('bridge', `CLIP_WARP_APPLIED clipId=${payload.clipId}`)
  },

  TRACK_TONE_APPLIED: (payload) => {
    // Apply backend-canonical values without echoing.
    if (!payload.ok) {
      log.warn('bridge', `TRACK_TONE_APPLIED ok=false for ${payload.trackId}`)
      return
    }
    useProjectStore().setTrackTone(
      payload.trackId,
      {
        bassDb: payload.bassDb,
        midDb: payload.midDb,
        trebleDb: payload.trebleDb,
        filter: payload.filter
      },
      { localOnly: true }
    )
  },

  TRACK_SENDS_APPLIED: (payload) => {
    if (!payload.ok) {
      log.warn('bridge', `TRACK_SENDS_APPLIED ok=false for ${payload.trackId}`)
      return
    }
    useProjectStore().setTrackSends(
      payload.trackId,
      { reverbSend: payload.reverbSend, delaySend: payload.delaySend },
      { localOnly: true }
    )
  },

  TRACK_PAN_APPLIED: (payload) => {
    if (!payload.ok) {
      log.warn('bridge', `TRACK_PAN_APPLIED ok=false for ${payload.trackId}`)
      return
    }
    useProjectStore().setTrackPan(payload.trackId, payload.pan, { localOnly: true })
  },

  TRACK_LEVELER_APPLIED: (payload) => {
    if (!payload.ok) {
      log.warn('bridge', `TRACK_LEVELER_APPLIED ok=false for ${payload.trackId}`)
      return
    }
    useProjectStore().setTrackLeveler(payload.trackId, payload.amount, { localOnly: true })
  },

  TRACK_PUNCH_APPLIED: (payload) => {
    if (!payload.ok) {
      log.warn('bridge', `TRACK_PUNCH_APPLIED ok=false for ${payload.trackId}`)
      return
    }
    useProjectStore().setTrackPunch(payload.trackId, payload.amount, { localOnly: true })
  },

  TRACK_SATURATION_APPLIED: (payload) => {
    if (!payload.ok) {
      log.warn('bridge', `TRACK_SATURATION_APPLIED ok=false for ${payload.trackId}`)
      return
    }
    useProjectStore().setTrackSaturation(
      payload.trackId,
      { drive: payload.drive, mix: payload.mix },
      { localOnly: true }
    )
  },

  TRACK_BIT_CRUSHER_APPLIED: (payload) => {
    if (!payload.ok) {
      log.warn('bridge', `TRACK_BIT_CRUSHER_APPLIED ok=false for ${payload.trackId}`)
      return
    }
    useProjectStore().setTrackBitCrusher(
      payload.trackId,
      { rate: payload.rate, bits: payload.bits, boost: payload.boost, mix: payload.mix },
      { localOnly: true }
    )
  },

  CLIP_ENVELOPE_APPLIED: (payload) => {
    // Mirror backend-normalised envelope points without waiting for PROJECT_STATE.
    useProjectStore().setClipEnvelope(payload.clipId, payload.points ?? [], { localOnly: true })
    log.info(
      'bridge',
      `CLIP_ENVELOPE_APPLIED clipId=${payload.clipId} points=${payload.points?.length ?? 0}`
    )
  },

  TRACK_AUTOMATION_APPLIED: (payload) => {
    // Mirror backend-normalised automation points without waiting for PROJECT_STATE.
    useProjectStore().setTrackAutomation(
      payload.trackId,
      payload.paramId as AutomationParamId,
      payload.points ?? [],
      { localOnly: true }
    )
    log.info(
      'bridge',
      `TRACK_AUTOMATION_APPLIED trackId=${payload.trackId} paramId=${payload.paramId} points=${
        payload.points?.length ?? 0
      }`
    )
  }
}

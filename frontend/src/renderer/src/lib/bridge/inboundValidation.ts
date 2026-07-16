// Inbound envelope validation + narrowing for the bridge.
//
// Validates a raw parsed `{ type, payload }` frame against the inbound
// catalogue and narrows it to a typed `BridgeInboundMessage`, dropping (and
// logging) anything malformed. Split out of `bridgeService` so the per-arm
// payload-guard wiring lives in one focused module. The zod schemas in
// `@shared/bridge-protocol` remain the single source of truth.

import { log } from '@/lib/log'
import {
  isBridgeInboundType,
  isAudioDeviceChangedPayload,
  isAudioDevicesListPayload,
  isMidiDevicesListPayload,
  isMidiMessagePayload,
  isMidiControlPayload,
  isMidiDeckSelectionPayload,
  isClipAckPayload,
  isClipEditorPeaksReadyPayload,
  isClipWarpAppliedPayload,
  isClipRemovedPayload,
  isEditUndoStatePayload,
  isAudioFileProbedPayload,
  isMixdownDonePayload,
  isMixdownFailedPayload,
  isMixdownProgressPayload,
  isStemProgressPayload,
  isStemPartialPayload,
  isStemReadyPayload,
  isStemFailedPayload,
  isChannelSplitReadyPayload,
  isChannelSplitFailedPayload,
  isLibraryItemAnalysisPayload,
  isMasterLevelPayload,
  isTrackLevelsPayload,
  isPlayheadUpdatePayload,
  isPongPayload,
  isEngineErrorPayload,
  isPreviewEndedPayload,
  isPreviewPositionPayload,
  isPreviewStatePayload,
  isProjectBpmAppliedPayload,
  isSampleSavedPayload,
  isProjectAutosavedPayload,
  isProjectDirtyPayload,
  isProjectLoadFailedPayload,
  isProjectRenamedPayload,
  isProjectSavedPayload,
  isProjectStatePayload,
  isProjectViewStateSavedPayload,
  isReadyPayload,
  isTrackAddedPayload,
  isTrackGainAppliedPayload,
  isTrackMuteAppliedPayload,
  isTrackSoloAppliedPayload,
  isTrackSendsAppliedPayload,
  isTrackToneAppliedPayload,
  isTrackLevelerAppliedPayload,
  isTrackPanAppliedPayload,
  isTrackAutomationAppliedPayload,
  isClipEnvelopeAppliedPayload,
  isProjectReverbAppliedPayload,
  isProjectDelayAppliedPayload,
  isTrackRemovedPayload,
  isWaveformFailedPayload,
  isWaveformReadyPayload,
  isEngineAudioStatusPayload,
  isScratchSessionStatePayload,
  isScratchPatternRecordedPayload,
  type BridgeInboundMessage,
  type BridgeInboundType
} from '@shared/bridge-protocol'

interface RawBridgeEnvelope {
  type?: unknown
  payload?: unknown
}

/**
 * Validate a raw parsed envelope against the inbound catalogue. Returns the
 * narrowed message on success, `null` on any structural mismatch (and logs
 * a warning so unexpected wire traffic is visible during development).
 */
export function validateInbound(raw: unknown): BridgeInboundMessage | null {
  if (typeof raw !== 'object' || raw === null) {
    log.warn('bridge', 'dropped non-object envelope')
    return null
  }
  const env = raw as RawBridgeEnvelope
  if (!isBridgeInboundType(env.type)) {
    log.warn('bridge', `dropped unknown envelope type ${String(env.type)}`)
    return null
  }
  return narrowPayload(env.type, env.payload)
}

/** Per-arm payload guard. Keeps the type narrowing tied to the discriminant. */
function narrowPayload(type: BridgeInboundType, payload: unknown): BridgeInboundMessage | null {
  switch (type) {
    case 'READY':
      return isReadyPayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'PROJECT_STATE':
      return isProjectStatePayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'PLAYHEAD_UPDATE':
      return isPlayheadUpdatePayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'CLIP_ADDED':
    case 'CLIP_ADD_FAILED':
      return isClipAckPayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'TRACK_ADDED':
      return isTrackAddedPayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'TRACK_REMOVED':
      return isTrackRemovedPayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'CLIP_REMOVED':
      return isClipRemovedPayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'TRACK_GAIN_APPLIED':
      return isTrackGainAppliedPayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'TRACK_MUTE_APPLIED':
      return isTrackMuteAppliedPayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'TRACK_SOLO_APPLIED':
      return isTrackSoloAppliedPayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'PROJECT_SAVED':
      return isProjectSavedPayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'PROJECT_VIEW_STATE_SAVED':
      return isProjectViewStateSavedPayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'PROJECT_AUTOSAVED':
      return isProjectAutosavedPayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'PROJECT_LOAD_FAILED':
      return isProjectLoadFailedPayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'PROJECT_RENAMED':
      return isProjectRenamedPayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'PROJECT_DIRTY':
      return isProjectDirtyPayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'WAVEFORM_READY':
      return isWaveformReadyPayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'WAVEFORM_FAILED':
      return isWaveformFailedPayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'CLIP_EDITOR_PEAKS_READY':
      return isClipEditorPeaksReadyPayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'SAMPLE_SAVED':
      return isSampleSavedPayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'LIBRARY_ITEM_ANALYSIS':
      return isLibraryItemAnalysisPayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'PROJECT_BPM_APPLIED':
      return isProjectBpmAppliedPayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'CLIP_WARP_APPLIED':
      return isClipWarpAppliedPayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'PREVIEW_STATE':
      return isPreviewStatePayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'PREVIEW_POSITION':
      return isPreviewPositionPayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'PREVIEW_ENDED':
      return isPreviewEndedPayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'AUDIO_DEVICES_LIST':
      return isAudioDevicesListPayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'AUDIO_DEVICE_CHANGED':
      return isAudioDeviceChangedPayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'MIDI_DEVICES_LIST':
      return isMidiDevicesListPayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'MIDI_MESSAGE':
      return isMidiMessagePayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'MIDI_CONTROL':
      return isMidiControlPayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'MIDI_DECK_SELECTION':
      return isMidiDeckSelectionPayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'EDIT_UNDO_STATE':
      return isEditUndoStatePayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'AUDIO_FILE_PROBED':
      return isAudioFileProbedPayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'MIXDOWN_PROGRESS':
      return isMixdownProgressPayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'MIXDOWN_DONE':
      return isMixdownDonePayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'MIXDOWN_FAILED':
      return isMixdownFailedPayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'STEM_PROGRESS':
      return isStemProgressPayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'STEM_PARTIAL':
      return isStemPartialPayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'STEM_READY':
      return isStemReadyPayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'STEM_FAILED':
      return isStemFailedPayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'CHANNEL_SPLIT_READY':
      return isChannelSplitReadyPayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'CHANNEL_SPLIT_FAILED':
      return isChannelSplitFailedPayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'MASTER_LEVEL':
      return isMasterLevelPayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'TRACK_LEVELS':
      return isTrackLevelsPayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'TRACK_SENDS_APPLIED':
      return isTrackSendsAppliedPayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'TRACK_TONE_APPLIED':
      return isTrackToneAppliedPayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'TRACK_LEVELER_APPLIED':
      return isTrackLevelerAppliedPayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'TRACK_PAN_APPLIED':
      return isTrackPanAppliedPayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'TRACK_AUTOMATION_APPLIED':
      return isTrackAutomationAppliedPayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'CLIP_ENVELOPE_APPLIED':
      return isClipEnvelopeAppliedPayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'PROJECT_REVERB_APPLIED':
      return isProjectReverbAppliedPayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'PROJECT_DELAY_APPLIED':
      return isProjectDelayAppliedPayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'PONG':
      return isPongPayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'ENGINE_ERROR':
      return isEngineErrorPayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'ENGINE_AUDIO_STATUS':
      return isEngineAudioStatusPayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'SCRATCH_SESSION_STATE':
      return isScratchSessionStatePayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'SCRATCH_PATTERN_RECORDED':
      return isScratchPatternRecordedPayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    default:
      return assertNeverType(type)
  }
}

function payloadMismatch(type: BridgeInboundType, payload: unknown): null {
  log.warn('bridge', `dropped envelope with malformed payload type=${type} payload=${JSON.stringify(payload)}`)
  return null
}

function assertNeverType(value: never): never {
  throw new Error(`[bridge] unhandled inbound envelope type: ${String(value)}`)
}

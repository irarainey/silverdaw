// Project-domain inbound handlers: authoritative state snapshots, save/autosave
// acks, rename/dirty mirroring, BPM/undo state, and master FX application.

import { useProjectStore } from '@/stores/projectStore'
import { useTransportStore } from '@/stores/transportStore'
import { useAppStore } from '@/stores/appStore'
import { useAudioDeviceStore } from '@/stores/audioDeviceStore'
import { useNotificationsStore } from '@/stores/notificationsStore'
import * as engineRecovery from '@/lib/engineRecovery'
import { log } from '@/lib/log'
import type { BridgeInboundHandlers } from '@/lib/bridge/handlerTypes'

export const projectBridgeHandlers: BridgeInboundHandlers<
  | 'PROJECT_STATE'
  | 'PROJECT_SAVED'
  | 'PROJECT_VIEW_STATE_SAVED'
  | 'PROJECT_AUTOSAVED'
  | 'PROJECT_LOAD_FAILED'
  | 'PROJECT_RENAMED'
  | 'PROJECT_DIRTY'
  | 'PROJECT_BPM_APPLIED'
  | 'EDIT_UNDO_STATE'
  | 'PROJECT_REVERB_APPLIED'
  | 'PROJECT_DELAY_APPLIED'
> = {
  PROJECT_STATE: (payload) => {
    // Authoritative snapshot after AUTH reconciles optimistic state.
    useProjectStore().applyProjectStateSnapshot(payload)
    useTransportStore().setPlaybackState(false)
    useTransportStore().setBridgeReady(true)
    // Load/Save As reset snapshots update MRU; initial reconnect snapshots do not.
    if (payload.reset === true && payload.filePath) {
      window.silverdaw.setLastProjectPath(payload.filePath)
      void useAppStore().refreshRecentProjects()
    }
    // Seed audio devices as soon as the bridge is ready.
    useAudioDeviceStore().requestInitialList()
    // Recovery distinguishes empty reconnect snapshots from restored resets.
    engineRecovery.onProjectStateApplied(payload)
  },

  PROJECT_SAVED: (payload) => {
    const notifications = useNotificationsStore()
    const project = useProjectStore()
    // Unblock any saveAndWait caller.
    project.notifySaveAck(payload.ok, payload.error)
    if (payload.ok) {
      log.info('bridge', `PROJECT_SAVED path=${payload.filePath}`)
      // Main persists last project path and updates the MRU.
      window.silverdaw.setLastProjectPath(payload.filePath)
      // Explicit save makes the current autosave bucket redundant.
      if (project.projectId) void window.silverdaw.clearAutosave(project.projectId)
      void useAppStore().refreshRecentProjects()
      notifications.pushInfo('Project saved')
    } else {
      log.warn('bridge', `PROJECT_SAVED failed: ${payload.error ?? 'unknown'}`)
      notifications.pushError(`Save failed: ${payload.error ?? 'unknown error'}`)
    }
  },

  PROJECT_VIEW_STATE_SAVED: (payload) => {
    useProjectStore().notifyViewStateSaveAck(payload.ok, payload.error)
    if (!payload.ok) {
      log.warn('bridge', `PROJECT_VIEW_STATE_SAVED failed: ${payload.error ?? 'unknown'}`)
    }
  },

  PROJECT_AUTOSAVED: (payload) => {
    // Autosave acks confirm pending manifests without user-visible UI.
    useProjectStore().notifyAutosaveAck(payload.filePath, payload.ok, payload.error)
    if (!payload.ok) {
      log.warn('bridge', `PROJECT_AUTOSAVED failed: ${payload.error ?? 'unknown'}`)
    } else {
      log.debug('bridge', `PROJECT_AUTOSAVED path=${payload.filePath}`)
    }
  },

  PROJECT_LOAD_FAILED: (payload) => {
    log.warn('bridge', `PROJECT_LOAD_FAILED ${payload.filePath}: ${payload.error}`)
    useProjectStore().notifyProjectLoadFailed(payload.error)
    useNotificationsStore().pushError(
      `Could not open project: ${payload.error || payload.filePath}`
    )
  },

  PROJECT_RENAMED: (payload) => {
    // Mirror backend-canonical name after optimistic rename.
    if (payload.ok) {
      useProjectStore().projectName = payload.name
    }
  },

  PROJECT_DIRTY: (payload) => {
    useProjectStore().isDirty = payload.dirty
    log.debug('bridge', `PROJECT_DIRTY dirty=${payload.dirty}`)
  },

  PROJECT_BPM_APPLIED: (payload) => {
    // Mirror backend-seeded BPM locally without echoing to the bridge.
    useTransportStore().setBpm(payload.bpm)
    log.info('bridge', `PROJECT_BPM_APPLIED bpm=${payload.bpm.toFixed(2)}`)
  },

  EDIT_UNDO_STATE: (payload) => {
    useProjectStore().applyEditUndoState(payload)
  },

  PROJECT_REVERB_APPLIED: (payload) => {
    if (!payload.ok) {
      log.warn('bridge', 'PROJECT_REVERB_APPLIED ok=false')
      return
    }
    useProjectStore().setProjectReverb(
      {
        size: payload.size,
        decay: payload.decay,
        tone: payload.tone,
        mix: payload.mix
      },
      { localOnly: true }
    )
  },

  PROJECT_DELAY_APPLIED: (payload) => {
    if (!payload.ok) {
      log.warn('bridge', 'PROJECT_DELAY_APPLIED ok=false')
      return
    }
    useProjectStore().setProjectDelay(
      {
        noteValue: payload.noteValue,
        feedback: payload.feedback,
        tone: payload.tone,
        mix: payload.mix
      },
      { localOnly: true }
    )
  }
}

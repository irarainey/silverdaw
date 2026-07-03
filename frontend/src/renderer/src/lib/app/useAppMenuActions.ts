// Application menu-action dispatcher; App.vue owns dialogs, guards and recent-path opening.
import type { Ref } from 'vue'
import type { useTransportStore } from '@/stores/transportStore'
import type { useProjectStore } from '@/stores/projectStore'
import type { useUiStore } from '@/stores/uiStore'
import type { useLibraryStore } from '@/stores/libraryStore'
import type { useNotificationsStore } from '@/stores/notificationsStore'
import type { useAppStore } from '@/stores/appStore'
import { effectiveClipDurationMs } from '@/stores/projectStore'
import { send as sendBridge } from '@/lib/bridgeService'
import { log } from '@/lib/log'
import { isZoomPresetAction, parseZoomPresetAction } from '@/lib/timeline/zoomPresets'

type TransportStore = ReturnType<typeof useTransportStore>
type ProjectStore = ReturnType<typeof useProjectStore>
type UiStore = ReturnType<typeof useUiStore>
type LibraryStore = ReturnType<typeof useLibraryStore>
type NotificationsStore = ReturnType<typeof useNotificationsStore>
type AppStore = ReturnType<typeof useAppStore>

export interface AppMenuActionsDeps {
  project: ProjectStore
  transport: TransportStore
  ui: UiStore
  library: LibraryStore
  notifications: NotificationsStore
  appStore: AppStore
  aboutOpen: Ref<boolean>
  preferencesOpen: Ref<boolean>
  projectPropertiesOpen: Ref<boolean>
  exportMixdownOpen: Ref<boolean>
  guardAgainstUnsavedChanges: (proceed: () => void | Promise<void>) => void
  // True when a modal/dialog owns the keyboard; suppresses menu-zoom.
  isModalOpen: () => boolean
  openRecentPath: (filePath: string) => void | Promise<void>
}

export interface AppMenuActions {
  handleMenuAction: (action: string) => void
}

export function useAppMenuActions(deps: AppMenuActionsDeps): AppMenuActions {
  const { project, transport, ui, notifications, appStore } = deps

  function handleMenuAction(action: string): void {
    log.info('menu', `action ${action}`)
    // About and Preferences remain reachable before PROJECT_STATE.
    if (action === 'help.about') {
      deps.aboutOpen.value = true
      return
    }
    if (action === 'edit.preferences') {
      deps.preferencesOpen.value = true
      return
    }
    // Quit/close must work even during a stuck startup.
    if (action === 'file.exit') {
      // When the backend isn't connected a save can never complete, so skip the
      // unsaved-changes prompt (whose Save would fail) and exit directly.
      if (!transport.bridgeReady) {
        window.silverdaw.menuAction('file.exitConfirmed')
        return
      }
      deps.guardAgainstUnsavedChanges(() => window.silverdaw.menuAction('file.exitConfirmed'))
      return
    }
    if (action === 'app.requestClose') {
      if (!transport.bridgeReady) {
        window.silverdaw.menuAction('app.confirmClose')
        return
      }
      deps.guardAgainstUnsavedChanges(() => window.silverdaw.menuAction('app.confirmClose'))
      return
    }
    // Drop accelerators until initial PROJECT_STATE reconciles local state.
    if (!transport.bridgeReady) {
      log.warn('menu', `dropped ${action} (bridge not ready)`)
      return
    }
    // Mirror the keyboard zoom modal guard for menu-click zoom.
    if (
      action === 'view.zoomIn' ||
      action === 'view.zoomOut' ||
      action === 'view.zoomReset' ||
      isZoomPresetAction(action)
    ) {
      if (deps.isModalOpen()) return
      if (action === 'view.zoomIn') ui.requestTimelineZoom('in')
      else if (action === 'view.zoomOut') ui.requestTimelineZoom('out')
      else if (action === 'view.zoomReset') ui.requestTimelineZoom('reset')
      else {
        const px = parseZoomPresetAction(action)
        if (px !== null) ui.requestTimelineZoomTo(px)
      }
      return
    }
    if (action === 'file.addTrack') {
      project.addTrack()
      return
    }
    if (action === 'file.projectProperties') {
      deps.projectPropertiesOpen.value = true
      return
    }
    if (action === 'file.exportMixdown') {
      deps.exportMixdownOpen.value = true
      return
    }
    if (action === 'file.newProject') {
      deps.guardAgainstUnsavedChanges(() => {
        project.requestNewProject()
        appStore.dismissStartScreen()
      })
      return
    }
    if (action === 'file.openProject') {
      deps.guardAgainstUnsavedChanges(() => {
        void window.silverdaw.chooseProjectOpen().then(async (filePath) => {
          if (!filePath) return
          // Seed the allow-list before PROJECT_STATE triggers metadata refresh.
          await window.silverdaw.prepareProjectOpen(filePath)
          project.requestLoad(filePath)
        })
      })
      return
    }
    // Recent-project actions encode the appStore MRU index.
    if (action.startsWith('file.openRecentByIndex:')) {
      const indexStr = action.slice('file.openRecentByIndex:'.length)
      const index = Number.parseInt(indexStr, 10)
      if (!Number.isFinite(index) || index < 0) return
      const recent = appStore.recentProjects[index]
      if (!recent) return
      const filePath = recent.path
      void (async () => {
        await deps.openRecentPath(filePath)
      })().catch((err) => log.warn('menu', `open recent failed: ${String(err)}`))
      return
    }
    if (action === 'file.clearRecentProjects') {
      window.silverdaw.clearRecentProjects()
      void appStore.refreshRecentProjects()
      return
    }
    if (action === 'file.save') {
      // No current path falls through to Save As.
      if (project.currentFilePath) {
        void project.saveAndWait(project.currentFilePath, false).then((result) => {
          if (
            !result.ok &&
            (result.error?.startsWith('Timed out') || result.error === 'The audio engine isn\'t connected')
          ) {
            notifications.pushError(`Save failed: ${result.error}.`)
          }
        })
      } else {
        handleMenuAction('file.saveAs')
      }
      return
    }
    if (action === 'file.saveAs') {
      void window.silverdaw
        .chooseProjectSaveAs(project.projectName || 'Untitled')
        .then((filePath) => {
          if (!filePath) return
          void project.saveAndWait(filePath, true).then((result) => {
            if (
              !result.ok &&
              (result.error?.startsWith('Timed out') || result.error === 'The audio engine isn\'t connected')
            ) {
              notifications.pushError(`Save failed: ${result.error}.`)
            }
          })
        })
      return
    }
    if (action === 'edit.undo') {
      project.requestUndo()
      return
    }
    if (action === 'edit.redo') {
      project.requestRedo()
      return
    }
    if (action === 'edit.splitAtPlayhead') {
      const atMs = transport.positionMs
      const selectedTrackId = project.selectedTrackId
      if (!selectedTrackId) return
      const track = project.tracks.find((candidate) => candidate.id === selectedTrackId)
      if (!track) return
      // Find the clip under the playhead on the selected track by position only.
      // Do NOT pre-filter saved ("clip"-kind) clips here: splitClipAt surfaces the
      // "Linked clips must be edited in the Clip Editor" message for those, so
      // skipping them here would make Split silently do nothing with no feedback.
      const splitClip = track.clipIds
        .map((clipId) => project.clips[clipId])
        .find((clip) => {
          if (!clip) return false
          const effDur = effectiveClipDurationMs(clip)
          return atMs > clip.startMs && atMs < clip.startMs + effDur
        })
      if (splitClip) project.splitClipAt(splitClip.id, atMs)
      return
    }
    if (action === 'edit.cut') {
      project.cutSelectedClip()
      return
    }
    if (action === 'edit.copy') {
      project.copySelectedClip()
      return
    }
    if (action === 'edit.paste') {
      project.pasteClipAtPlayhead(transport.positionMs)
      return
    }
    if (action === 'edit.duplicateClip') {
      if (project.selectedClipId) {
        project.duplicateClip(project.selectedClipId)
      }
      return
    }
    if (action === 'edit.deleteClip') {
      if (project.selectedClipId) {
        project.removeClip(project.selectedClipId)
      }
      return
    }
    if (action === 'edit.cropProjectToLastClip') {
      // No-op on empty projects to avoid a 0-width ruler.
      let maxEndMs = 0
      for (const clip of Object.values(project.clips)) {
        const effDur = effectiveClipDurationMs(clip)
        const end = clip.startMs + effDur
        if (end > maxEndMs) maxEndMs = end
      }
      if (maxEndMs <= 0) {
        notifications.pushInfo('No clips on the timeline — nothing to trim.')
        return
      }
      const before = project.durationMs
      project.setProjectLengthMs(maxEndMs)
      const after = project.durationMs
      if (after !== before) {
        sendBridge('PROJECT_SET_LENGTH', { lengthMs: after })
      }
      return
    }
  }

  return { handleMenuAction }
}

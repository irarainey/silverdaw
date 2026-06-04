// Application menu-action dispatcher, extracted from App.vue. Handles every
// `window.silverdaw.onMenuAction` command (file / edit / view / help) plus the
// keyboard accelerators that route through the same channel. The SFC keeps
// ownership of the dialog open-refs, the unsaved-changes guard, the modal guard,
// and the recent-path opener, passing them in as deps so this module stays a
// pure command router with no Vue lifecycle of its own.
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
  // Dialog open-state owned by the SFC.
  aboutOpen: Ref<boolean>
  preferencesOpen: Ref<boolean>
  projectPropertiesOpen: Ref<boolean>
  exportMixdownOpen: Ref<boolean>
  // Runs `proceed` once unsaved changes are saved/discarded (SFC-owned).
  guardAgainstUnsavedChanges: (proceed: () => void) => void
  // True when a modal/dialog owns the keyboard; suppresses menu-zoom.
  isModalOpen: () => boolean
  // Opens a Recent-Projects MRU entry (SFC-owned).
  openRecentPath: (filePath: string) => void
}

export interface AppMenuActions {
  handleMenuAction: (action: string) => void
}

export function useAppMenuActions(deps: AppMenuActionsDeps): AppMenuActions {
  const { project, transport, ui, library, notifications, appStore } = deps

  function handleMenuAction(action: string): void {
    log.info('menu', `action ${action}`)
    // The About dialog must remain reachable even before the bridge has
    // delivered its first PROJECT_STATE — it doesn't touch project state
    // and users may want to see version / licence info while diagnosing a
    // backend-startup problem. Same reasoning applies to Preferences.
    if (action === 'help.about') {
      deps.aboutOpen.value = true
      return
    }
    if (action === 'edit.preferences') {
      deps.preferencesOpen.value = true
      return
    }
    // Quitting / closing the window must work regardless of bridge
    // state — the user has to be able to give up on a stuck startup.
    // `project.isDirty` is reliably false until the bridge has
    // delivered at least one PROJECT_STATE, so the guard is a no-op
    // in that case anyway.
    if (action === 'file.exit') {
      deps.guardAgainstUnsavedChanges(() => window.silverdaw.menuAction('file.exitConfirmed'))
      return
    }
    if (action === 'app.requestClose') {
      deps.guardAgainstUnsavedChanges(() => window.silverdaw.menuAction('app.confirmClose'))
      return
    }
    // Drop any menu action (incl. keyboard shortcut) that arrives before
    // the bridge has delivered its initial PROJECT_STATE — the visible
    // <StartupScreen> swallows mouse clicks but accelerators bypass
    // it, and acting on stale local state before reconcile would lose
    // the action (it'd race the snapshot apply pass).
    if (!transport.bridgeReady) {
      log.warn('menu', `dropped ${action} (bridge not ready)`)
      return
    }
    // Timeline zoom — menu-click path only. The keyboard path is owned by
    // `onGlobalShortcutKey` and never routes through here. Mirror that
    // handler's modal guard so a menu click can't zoom the timeline behind
    // an open dialog (clip editor, export, recovery, …).
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
    // Adding a track is now just "create an empty track". Importing a file
    // into the track happens via the per-track Import button on the track
    // header panel (see TrackHeaderPanel.vue).
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
          // Same allow-list seeding as the auto-open path. The metadata
          // refresh fired by `applyProjectStateSnapshot` runs as soon as
          // the backend echoes PROJECT_STATE, so the paths must be on the
          // whitelist by that point.
          await window.silverdaw.prepareProjectOpen(filePath)
          project.requestLoad(filePath)
          // StartupScreen disappears once PROJECT_STATE arrives. Avoid
          // a preemptive dismiss so the empty timeline never flashes.
        })
      })
      return
    }
    // Recent Projects MRU click. The action ID encodes the visible-menu
    // index; we look the path up out of the appStore mirror because the
    // file menu only surfaces the top 5 (the full MRU lives in the
    // start screen).
    if (action.startsWith('file.openRecentByIndex:')) {
      const indexStr = action.slice('file.openRecentByIndex:'.length)
      const index = Number.parseInt(indexStr, 10)
      if (!Number.isFinite(index) || index < 0) return
      const filePath = appStore.recentProjects[index]
      if (!filePath) return
      deps.openRecentPath(filePath)
      return
    }
    if (action === 'file.clearRecentProjects') {
      window.silverdaw.clearRecentProjects()
      void appStore.refreshRecentProjects()
      return
    }
    if (action === 'file.save') {
      // No current path → fall through to Save As so the user gets the
      // OS dialog rather than a confusing silent failure.
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
      const splitClip = track.clipIds
        .map((clipId) => project.clips[clipId])
        .find((clip) => {
          if (!clip) return false
          const libItem = library.byId[clip.libraryItemId]
          if (libItem?.kind === 'saved-clip') return false
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
      // Crop the project length to the end of the latest clip on any
      // track. No-op if there are no clips at all — collapsing an empty
      // project to 0 ms would leave a 0-width ruler with no way back
      // except a tempo / length edit. The setter clamps upward per-track
      // to fit clips on that track, so passing the global max keeps the
      // shorter tracks honest as well.
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

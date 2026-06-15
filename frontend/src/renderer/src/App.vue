<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AppTitleBar from '@/components/AppTitleBar.vue'
import TimelineView from '@/components/TimelineView.vue'
import TransportBar from '@/components/TransportBar.vue'
import LibraryPanel from '@/components/LibraryPanel.vue'
import StatusBar from '@/components/StatusBar.vue'
import NotificationToasts from '@/components/NotificationToasts.vue'
import ImportProgressDialog from '@/components/ImportProgressDialog.vue'
import AboutDialog from '@/components/AboutDialog.vue'
import PreferencesDialog from '@/components/PreferencesDialog.vue'
import ProjectPropertiesDialog from '@/components/ProjectPropertiesDialog.vue'
import ExportMixdownDialog from '@/components/ExportMixdownDialog.vue'
import MixdownProgressDialog from '@/components/MixdownProgressDialog.vue'
import StemSeparationProgressDialog from '@/components/StemSeparationProgressDialog.vue'
import StemModelDownloadDialog from '@/components/StemModelDownloadDialog.vue'
import StemSelectionDialog from '@/components/StemSelectionDialog.vue'
import { useMixdownState } from '@/lib/mixdownState'
import AudioDeviceUnavailableDialog from '@/components/AudioDeviceUnavailableDialog.vue'
import SampleRateMismatchDialog from '@/components/SampleRateMismatchDialog.vue'
import {
  useSampleRateMismatchPromptState,
  resolveSampleRateMismatchPrompt
} from '@/lib/sampleRatePrompt'
import UnsavedChangesDialog from '@/components/UnsavedChangesDialog.vue'
import RelinkDialog from '@/components/RelinkDialog.vue'
import RecoveryDialog, { type RecoverableEntry } from '@/components/RecoveryDialog.vue'
import StartupScreen from '@/components/StartupScreen.vue'
import EngineRecoveryOverlay from '@/components/EngineRecoveryOverlay.vue'
import { useProjectStore } from '@/stores/projectStore'
import { useTransportStore } from '@/stores/transportStore'
import { useUiStore } from '@/stores/uiStore'
import { useLibraryStore } from '@/stores/libraryStore'
import { useNotificationsStore } from '@/stores/notificationsStore'
import { startAutosaveManager, stopAutosaveManager } from '@/lib/autosave'
import { getActivePinia } from 'pinia'
import { connect as connectBridge, disconnect as disconnectBridge } from '@/lib/bridgeService'
import { log } from '@/lib/log'
import { registerMenuShortcuts } from '@/lib/menuShortcuts'
import { onBackendStatus as onEngineBackendStatus } from '@/lib/engineRecovery'
import { useAppKeyboardShortcuts } from '@/lib/app/useAppKeyboardShortcuts'
import { useAppMenuActions } from '@/lib/app/useAppMenuActions'
import { useMissingFileRelink } from '@/lib/app/useMissingFileRelink'
import { useProjectAudioOutputReconciliation } from '@/lib/app/useProjectAudioOutputReconciliation'
import { useUnsavedChangesGuard } from '@/lib/app/useUnsavedChangesGuard'
import { useAppStore } from '@/stores/appStore'

const project = useProjectStore()
const transport = useTransportStore()
const ui = useUiStore()
const library = useLibraryStore()
const notifications = useNotificationsStore()
const appStore = useAppStore()

const aboutOpen = ref(false)
const preferencesOpen = ref(false)
const projectPropertiesOpen = ref(false)
const exportMixdownOpen = ref(false)
const sampleRatePromptState = useSampleRateMismatchPromptState()
const mixdownState = useMixdownState()
// Recovery blocks startup until each autosave entry is resolved.
const recoveryEntries = ref<RecoverableEntry[]>([])
const recoveryDialogOpen = ref(false)
// Cold-launch path parked while recovery runs.
let pendingOpenAfterRecovery: string | null = null

// Missing-file relink, per-project audio-output reconciliation, and the
// unsaved-changes guard live in focused shell composables.
const { relinkDialogOpen } = useMissingFileRelink()
const { audioUnavailableOpen, audioUnavailableSavedTypeName, audioUnavailableSavedDeviceName } =
  useProjectAudioOutputReconciliation()
const {
  unsavedPromptOpen,
  guardAgainstUnsavedChanges,
  onUnsavedPromptSave,
  onUnsavedPromptDiscard,
  onUnsavedPromptCancel
} = useUnsavedChangesGuard()

let unsubscribeMenu: (() => void) | null = null
let unsubscribeOpenFromPath: (() => void) | null = null
let unsubscribeBackendStatus: (() => void) | null = null
let unregisterShortcuts: (() => void) | null = null

// One body class covers all long-running jobs so the busy cursor cannot clear early.
const stopBusyCursorWatcher = watch(
  () => library.isImporting || mixdownState.value !== null,
  (busy) => {
    document.body.classList.toggle('is-importing', busy)
  },
  { immediate: true }
)

onMounted(() => {
  log.info('app', 'mounted')
  unsubscribeMenu = window.silverdaw.onMenuAction(handleMenuAction)
  // Warm-launch file hand-offs arrive from the single-instance lock.
  unsubscribeOpenFromPath = window.silverdaw.onOpenProjectFromPath((filePath) => {
    void openProjectByPath(filePath)
  })
  // Backend supervisor status drives the engine-recovery overlay.
  unsubscribeBackendStatus = window.silverdaw.onBackendStatus(onEngineBackendStatus)
  unregisterShortcuts = registerMenuShortcuts({ devToolsEnabled: appStore.devToolsEnabled })
  window.addEventListener('keydown', onGlobalShortcutKey, { capture: true })
  connectBridge()
  startBridgeConnectionTimer()
  // Hydrate persisted panel sizes after first paint.
  void ui.hydrate()
  // Start autosave; it stays idle until the project is dirty.
  const pinia = getActivePinia()
  if (pinia) startAutosaveManager(pinia)
})

// ─── Global keyboard shortcuts ────────────────────────────────────────────
// Modal guard stays here because it reads this component's dialog refs.
function isShortcutModalOpen(): boolean {
  return (
    aboutOpen.value ||
    preferencesOpen.value ||
    projectPropertiesOpen.value ||
    exportMixdownOpen.value ||
    mixdownState.value !== null ||
    audioUnavailableOpen.value ||
    sampleRatePromptState.value.open ||
    relinkDialogOpen.value ||
    unsavedPromptOpen.value ||
    recoveryDialogOpen.value ||
    startupScreenVisible.value ||
    ui.clipEditorOpen
  )
}

const { onGlobalShortcutKey } = useAppKeyboardShortcuts({
  transport,
  project,
  ui,
  isModalOpen: isShortcutModalOpen,
  openExportMixdown: () => {
    exportMixdownOpen.value = true
  }
})

// ─── Initial bridge-connection timeout ────────────────────────────────
// Surface startup failures instead of leaving StartupScreen waiting forever.
const BRIDGE_CONNECTION_TIMEOUT_MS = 30_000
let bridgeTimer: ReturnType<typeof setTimeout> | null = null

function startBridgeConnectionTimer(): void {
  if (bridgeTimer) clearTimeout(bridgeTimer)
  bridgeTimer = setTimeout(() => {
    bridgeTimer = null
    if (transport.bridgeReady) return
    log.warn('app', `bridge connection timed out after ${BRIDGE_CONNECTION_TIMEOUT_MS}ms`)
    // Keep copy user-facing; distinguish socket failure from handshake failure.
    const message = transport.connected
      ? 'Silverdaw connected to the audio engine but did not receive a response. Please relaunch Silverdaw.'
      : 'Silverdaw could not connect to the audio engine. Please relaunch Silverdaw.'
    transport.setBridgeFailure(message)
  }, BRIDGE_CONNECTION_TIMEOUT_MS)
}

// Only the initial connect can trip this terminal startup timeout.
const stopBridgeTimerWatcher = watch(
  () => transport.bridgeReady,
  (ready) => {
    if (ready && bridgeTimer) {
      clearTimeout(bridgeTimer)
      bridgeTimer = null
    }
    if (!ready) return
    // ── Startup coordinator ────────────────────────────────────────────
    // Park cold-launch paths until recovery has finished.
    void window.silverdaw.consumePendingOpenPath().then((filePath) => {
      if (filePath) pendingOpenAfterRecovery = filePath
      runStartupRecoveryFlow()
    })
  }
)

/** Drive the recovery-then-launch flow once the bridge is ready. */
function runStartupRecoveryFlow(): void {
  void window.silverdaw.listRecoverableAutosaves().then((entries) => {
    if (entries.length > 0) {
      recoveryEntries.value = entries
      recoveryDialogOpen.value = true
      return
    }
    finishStartupFlow()
  })
}

/** Finish recovery, consume any parked cold-launch path, then release startup. */
function finishStartupFlow(): void {
  const parked = pendingOpenAfterRecovery
  pendingOpenAfterRecovery = null
  if (parked) {
    // Let PROJECT_STATE hide StartupScreen once the project path lands.
    void openProjectByPath(parked)
  }
  appStore.markStartupFlowComplete()
}

function onRecoveryRestored(): void {
  // Restore wins over any parked cold-launch path.
  pendingOpenAfterRecovery = null
}

function onRecoveryClose(): void {
  recoveryDialogOpen.value = false
  recoveryEntries.value = []
  finishStartupFlow()
}

/** Drop a discarded autosave row; closing once the list empties. */
function onRecoveryDiscarded(projectId: string): void {
  recoveryEntries.value = recoveryEntries.value.filter((e) => e.projectId !== projectId)
  if (recoveryEntries.value.length === 0) onRecoveryClose()
}

/** Open `.silverdaw` hand-offs through the same guard as File > Open. */
async function openProjectByPath(filePath: string): Promise<void> {
  if (!filePath) return
  if (!transport.bridgeReady) {
    log.warn('app', `dropped open-from-path ${filePath} (bridge not ready)`)
    return
  }
  guardAgainstUnsavedChanges(async () => {
    await window.silverdaw.prepareProjectOpen(filePath)
    project.requestLoad(filePath)
    // PROJECT_STATE hides StartupScreen without exposing the empty timeline.
  })
}

/** Open a recent project, dropping stale MRU entries before loading. */
async function openRecentPath(filePath: string): Promise<void> {
  if (!filePath) return
  if (!transport.bridgeReady) {
    log.warn('app', `dropped open-recent ${filePath} (bridge not ready)`)
    return
  }
  const exists = await window.silverdaw.projectFileExists(filePath)
  if (!exists) {
    log.warn('app', `recent project missing: ${filePath}`)
    window.silverdaw.removeRecentProject(filePath)
    await appStore.refreshRecentProjects()
    notifications.pushError(`Recent project file no longer exists: ${filePath}`)
    return
  }
  void openProjectByPath(filePath)
}

function onStartScreenNew(): void {
  // Empty new projects need explicit start-screen dismissal.
  appStore.dismissStartScreen()
  handleMenuAction('file.newProject')
}

function onStartScreenOpen(): void {
  // Keep the screen if the file picker is cancelled.
  handleMenuAction('file.openProject')
}

function onStartScreenRecent(filePath: string): void {
  // Dismissal is driven by the project-loaded gate.
  void openRecentPath(filePath)
}

/** Forget a recent project from the start-screen list (persisted removal). */
async function onStartScreenRemoveRecent(filePath: string): Promise<void> {
  if (!filePath) return
  window.silverdaw.removeRecentProject(filePath)
  await appStore.refreshRecentProjects()
}

/** Startup stays visible until a project loads or the user explicitly dismisses it. */
const startupScreenVisible = computed(
  () =>
    !appStore.startScreenDismissed &&
    project.currentFilePath === null &&
    project.tracks.length === 0 &&
    library.items.length === 0
)

onBeforeUnmount(() => {
  log.info('app', 'beforeUnmount')
  unsubscribeMenu?.()
  unsubscribeMenu = null
  unsubscribeOpenFromPath?.()
  unsubscribeOpenFromPath = null
  unsubscribeBackendStatus?.()
  unsubscribeBackendStatus = null
  unregisterShortcuts?.()
  unregisterShortcuts = null
  window.removeEventListener('keydown', onGlobalShortcutKey, { capture: true })
  disconnectBridge()
  stopAutosaveManager()
  stopBusyCursorWatcher()
  stopBridgeTimerWatcher()
  if (bridgeTimer) {
    clearTimeout(bridgeTimer)
    bridgeTimer = null
  }
  document.body.classList.remove('is-importing')
})

const { handleMenuAction } = useAppMenuActions({
  project,
  transport,
  ui,
  library,
  notifications,
  appStore,
  aboutOpen,
  preferencesOpen,
  projectPropertiesOpen,
  exportMixdownOpen,
  guardAgainstUnsavedChanges,
  isModalOpen: isShortcutModalOpen,
  openRecentPath
})
</script>

<template>
  <div class="flex h-screen flex-col bg-zinc-950 text-zinc-100">
    <AppTitleBar :window-controls-disabled="isShortcutModalOpen()" />

    <TransportBar />

    <main class="flex-1 overflow-hidden">
      <TimelineView />
    </main>

    <LibraryPanel
      :height="ui.libraryPanelHeight"
      @update:height="ui.setLibraryPanelHeight"
    />

    <StatusBar />

    <NotificationToasts />

    <ImportProgressDialog />

    <AboutDialog
      :open="aboutOpen"
      @close="aboutOpen = false"
    />

    <PreferencesDialog
      :open="preferencesOpen"
      @close="preferencesOpen = false"
    />

    <ProjectPropertiesDialog
      :open="projectPropertiesOpen"
      @close="projectPropertiesOpen = false"
    />

    <ExportMixdownDialog
      :open="exportMixdownOpen"
      @close="exportMixdownOpen = false"
    />

    <MixdownProgressDialog />

    <StemSelectionDialog />

    <StemModelDownloadDialog />

    <StemSeparationProgressDialog />

    <AudioDeviceUnavailableDialog
      :open="audioUnavailableOpen"
      :saved-type-name="audioUnavailableSavedTypeName"
      :saved-device-name="audioUnavailableSavedDeviceName"
      @close="audioUnavailableOpen = false"
    />

    <SampleRateMismatchDialog
      :open="sampleRatePromptState.open"
      :buckets="sampleRatePromptState.buckets"
      :project-sample-rate="sampleRatePromptState.projectSampleRate"
      @choose="resolveSampleRateMismatchPrompt"
    />

    <UnsavedChangesDialog
      :open="unsavedPromptOpen"
      :project-name="project.projectName"
      @save="onUnsavedPromptSave"
      @discard="onUnsavedPromptDiscard"
      @cancel="onUnsavedPromptCancel"
    />

    <RelinkDialog
      :open="relinkDialogOpen"
      @close="relinkDialogOpen = false"
    />

    <RecoveryDialog
      :open="recoveryDialogOpen"
      :entries="recoveryEntries"
      @restored="onRecoveryRestored"
      @discarded="onRecoveryDiscarded"
      @close="onRecoveryClose"
    />

    <StartupScreen
      :open="startupScreenVisible"
      :startup-flow-complete="appStore.startupFlowComplete"
      :recovery-open="recoveryDialogOpen"
      @new-project="onStartScreenNew"
      @open-project="onStartScreenOpen"
      @open-recent="onStartScreenRecent"
      @remove-recent="onStartScreenRemoveRecent"
    />

    <!-- Mid-session audio-engine recovery gate. -->
    <EngineRecoveryOverlay />
  </div>
</template>

<style>
/* Busy-but-interactive cursor while imports or mixdowns run. */
body.is-importing,
body.is-importing * {
  cursor: progress !important;
}

button {
  appearance: none;
  border: 1px solid rgb(63 63 70);
  outline: none !important;
  -webkit-tap-highlight-color: transparent;
}

button:focus {
  --tw-ring-shadow: 0 0 #0000 !important;
  border-color: rgb(63 63 70);
  box-shadow: none !important;
  outline: none !important;
}

button:focus-visible {
  --tw-ring-shadow: 0 0 #0000 !important;
  border-color: rgb(14 165 233);
  box-shadow: inset 0 0 0 1px rgb(14 165 233 / 0.45) !important;
  outline: none !important;
}

button:disabled {
  border-color: rgb(63 63 70 / 0.55);
}

.titlebar button,
.titlebar button:focus,
.titlebar button:focus-visible,
button[data-borderless-button="true"],
button[data-borderless-button="true"]:focus,
button[data-borderless-button="true"]:focus-visible {
  border: 0;
  box-shadow: none !important;
  outline: none !important;
}

/* Shared dark scrollbar chrome for scrollable panels and dialogs. */
.silverdaw-scroll {
  scrollbar-color: rgb(113 113 122) rgb(24 24 27 / 0.8);
  scrollbar-width: thin;
}

.silverdaw-scroll::-webkit-scrollbar {
  width: 12px;
  height: 12px;
}

.silverdaw-scroll::-webkit-scrollbar-track {
  background: rgb(24 24 27 / 0.8);
}

.silverdaw-scroll::-webkit-scrollbar-thumb {
  background-color: rgb(113 113 122);
  border: 3px solid rgb(24 24 27 / 0.8);
  border-radius: 9999px;
}

.silverdaw-scroll::-webkit-scrollbar-thumb:hover {
  background-color: rgb(161 161 170);
}
</style>

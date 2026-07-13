<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AppTitleBar from '@/components/AppTitleBar.vue'
import TimelineView from '@/components/TimelineView.vue'
import TransportBar from '@/components/TransportBar.vue'
import LibraryPanel from '@/components/LibraryPanel.vue'
import ScratchEditorDialog from '@/components/ScratchEditorDialog.vue'
import StatusBar from '@/components/StatusBar.vue'
import NotificationToasts from '@/components/NotificationToasts.vue'
import {
  loadStemQualityPreference,
  useStemModelFlow,
  useStemSelection
} from '@/lib/stems/stemSeparationFlow'
import { useStemSeparationState } from '@/lib/stemSeparationState'
import { useChannelSplitSelection } from '@/lib/stems/channelSplitFlow'
import { useMixdownState } from '@/lib/mixdownState'
import {
  useSampleRateMismatchPromptState,
  resolveSampleRateMismatchPrompt
} from '@/lib/sampleRatePrompt'
import RecoveryDialog, { type RecoverableEntry } from '@/components/RecoveryDialog.vue'
import StartupScreen from '@/components/StartupScreen.vue'
import EngineRecoveryOverlay from '@/components/EngineRecoveryOverlay.vue'
import { useProjectStore } from '@/stores/projectStore'
import { useTransportStore } from '@/stores/transportStore'
import { useUiStore } from '@/stores/uiStore'
import { useLibraryStore } from '@/stores/libraryStore'
import { useNotificationsStore } from '@/stores/notificationsStore'
import { useScratchEditorStore } from '@/stores/scratchEditorStore'
import { startAutosaveManager, stopAutosaveManager } from '@/lib/autosave'
import { getActivePinia } from 'pinia'
import { connect as connectBridge, disconnect as disconnectBridge } from '@/lib/bridgeService'
import { warmPixi } from '@/lib/timeline/pixiLoader'
import { log } from '@/lib/log'
import { registerMenuShortcuts } from '@/lib/menuShortcuts'
import { onBackendStatus as onEngineBackendStatus } from '@/lib/engineRecovery'
import type { BackendStatus } from '@shared/ipc-channels'
import { useAppKeyboardShortcuts } from '@/lib/app/useAppKeyboardShortcuts'
import { useAppMenuActions } from '@/lib/app/useAppMenuActions'
import { useMissingFileRelink } from '@/lib/app/useMissingFileRelink'
import { useProjectAudioOutputReconciliation } from '@/lib/app/useProjectAudioOutputReconciliation'
import { useUnsavedChangesGuard } from '@/lib/app/useUnsavedChangesGuard'
import { useRenderedDialogPresence } from '@/lib/app/useRenderedDialogPresence'
import { useAppStore } from '@/stores/appStore'
import { useMidiDeviceStore } from '@/stores/midiDeviceStore'
import { useMidiControllerActions } from '@/lib/midi/useMidiControllerActions'
import {
  AboutDialog,
  AudioDeviceUnavailableDialog,
  ChannelSplitDialog,
  ExportMixdownDialog,
  ImportProgressDialog,
  MidiMonitorDialog,
  MixdownProgressDialog,
  PreferencesDialog,
  ProjectPropertiesDialog,
  RelinkDialog,
  SampleRateMismatchDialog,
  StemModelDownloadDialog,
  StemSelectionDialog,
  StemSeparationProgressDialog,
  UnsavedChangesDialog
} from '@/lib/app/lazyDialogs'

const project = useProjectStore()
const transport = useTransportStore()
const ui = useUiStore()
const library = useLibraryStore()
const scratchEditor = useScratchEditorStore()
const notifications = useNotificationsStore()
const appStore = useAppStore()
const midiDevices = useMidiDeviceStore()
const renderedDialogOpen = useRenderedDialogPresence()

const aboutOpen = ref(false)
const preferencesOpen = ref(false)
const projectPropertiesOpen = ref(false)
const exportMixdownOpen = ref(false)
const diagnosticsBusy = ref(false)
const midiMonitorOpen = ref(false)
const sampleRatePromptState = useSampleRateMismatchPromptState()
const mixdownState = useMixdownState()
const stemSelection = useStemSelection()
const stemModelFlow = useStemModelFlow()
const stemSeparationState = useStemSeparationState()
const channelSplitSelection = useChannelSplitSelection()
// Recovery blocks startup until each autosave entry is resolved.
const recoveryEntries = ref<RecoverableEntry[]>([])
const recoveryDialogOpen = ref(false)
// Cold-launch path parked while recovery runs.
let pendingOpenAfterRecovery: string | null = null
type StartupRecoveryData = {
  pendingOpenPath: string | null
  recoverableEntries: RecoverableEntry[]
}
let startupRecoveryPrefetch: Promise<StartupRecoveryData> | null = null
// A project open requested before `bridgeReady` (e.g. a fast click on the startup
// picker): the latest requested path, plus the single watcher that fires it once the
// bridge is ready. Coalesced so rapid clicks resolve to one load of the last choice.
let deferredOpenPath: string | null = null
let stopDeferredOpen: (() => void) | null = null

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
  log.info('perf', `renderer onMounted @ ${Math.round(performance.now())}ms`)
  unsubscribeMenu = window.silverdaw.onMenuAction(handleMenuAction)
  // Warm-launch file hand-offs arrive from the single-instance lock.
  unsubscribeOpenFromPath = window.silverdaw.onOpenProjectFromPath((filePath) => {
    void openProjectByPath(filePath)
  })
  // Backend supervisor status drives startup fast-fail + the engine-recovery overlay.
  unsubscribeBackendStatus = window.silverdaw.onBackendStatus(handleBackendStatus)
  unregisterShortcuts = registerMenuShortcuts(
    { devToolsEnabled: appStore.devToolsEnabled },
    isInteractionBlocked
  )
  window.addEventListener('keydown', onGlobalShortcutKey, { capture: true })
  // These main-process reads do not depend on the backend, so overlap them with its startup.
  prefetchStartupRecovery()
  connectBridge()
  startBridgeConnectionTimer()
  // Hydrate persisted panel sizes after first paint.
  void ui.hydrate()
  // Seed the stem-separation quality picker from the persisted preference.
  void loadStemQualityPreference()
  // Start autosave; it stays idle until the project is dirty.
  const pinia = getActivePinia()
  if (pinia) startAutosaveManager(pinia)
  // A2: warm the large Pixi/WebGL chunk in the background now (after first paint, while the
  // startup screen is shown) so the first timeline/clip-editor draw doesn't pay the import cost.
  warmPixi()
})

// ─── Global keyboard shortcuts ────────────────────────────────────────────
// Immediate refs cover the state change before Vue renders the dialog; the
// rendered-dialog observer also covers dialogs owned by child components.
function isInteractionBlocked(): boolean {
  return (
    renderedDialogOpen.value ||
    aboutOpen.value ||
    preferencesOpen.value ||
    projectPropertiesOpen.value ||
    exportMixdownOpen.value ||
    diagnosticsBusy.value ||
    midiMonitorOpen.value ||
    library.imports.length > 0 ||
    mixdownState.value !== null ||
    stemSelection.value !== null ||
    stemModelFlow.value !== null ||
    stemSeparationState.value !== null ||
    channelSplitSelection.value !== null ||
    audioUnavailableOpen.value ||
    sampleRatePromptState.value.open ||
    relinkDialogOpen.value ||
    unsavedPromptOpen.value ||
    recoveryDialogOpen.value ||
    startupScreenVisible.value ||
    ui.clipEditorOpen ||
    transport.engineRecovery !== 'ok'
  )
}

const { onGlobalShortcutKey } = useAppKeyboardShortcuts({
  transport,
  project,
  ui,
  library,
  isModalOpen: isInteractionBlocked,
  openExportMixdown: () => {
    exportMixdownOpen.value = true
  }
})

// ─── Initial bridge-connection timeout ────────────────────────────────
// A last-resort ceiling so StartupScreen never waits forever. Real failures are
// driven by the backend supervisor's process status (see handleBackendStatus),
// so this is deliberately generous: a slow first-run audio-device open must not
// be mistaken for a dead engine.
const BRIDGE_CONNECTION_TIMEOUT_MS = 60_000
let bridgeTimer: ReturnType<typeof setTimeout> | null = null

/** Terminal cold-start failure; only meaningful while the initial connect is pending. */
function failStartupBridge(reason: string): void {
  if (transport.bridgeReady) return
  if (bridgeTimer) {
    clearTimeout(bridgeTimer)
    bridgeTimer = null
  }
  log.warn('app', `startup bridge failed: ${reason}`)
  // Keep copy user-facing; distinguish socket failure from handshake failure.
  const message = transport.connected
    ? 'Silverdaw connected to the audio engine but did not receive a response. Please relaunch Silverdaw.'
    : 'Silverdaw could not connect to the audio engine. Please relaunch Silverdaw.'
  transport.setBridgeFailure(message)
}

function startBridgeConnectionTimer(): void {
  if (bridgeTimer) clearTimeout(bridgeTimer)
  bridgeTimer = setTimeout(() => {
    bridgeTimer = null
    failStartupBridge(`timed out after ${BRIDGE_CONNECTION_TIMEOUT_MS}ms`)
  }, BRIDGE_CONNECTION_TIMEOUT_MS)
}

/**
 * Bridge the supervisor's OS-process status into both startup and mid-session
 * recovery. During cold start (before the first PROJECT_STATE) a terminal `failed`
 * means the backend crash-looped and gave up — surface it immediately rather than
 * waiting out the ceiling; a `restarting` means it is still coming up, so extend the
 * ceiling instead of tripping it. Mid-session, defer entirely to engine recovery.
 */
function handleBackendStatus(status: BackendStatus): void {
  if (!transport.bridgeReady) {
    if (status === 'failed') {
      failStartupBridge('audio engine stopped responding during startup')
      return
    }
    if (status === 'restarting') {
      // Backend is respawning (still alive); give the slow cold start more runway.
      startBridgeConnectionTimer()
    }
  }
  onEngineBackendStatus(status)
}

// Handshake (READY) — not the post-open PROJECT_STATE — drives startup so the UI appears
// while the audio device is still opening. Also the point past which the connect timeout
// must not fire: the backend is proven reachable.
const stopBridgeTimerWatcher = watch(
  () => transport.handshakeReady,
  (ready) => {
    if (ready && bridgeTimer) {
      clearTimeout(bridgeTimer)
      bridgeTimer = null
    }
    if (!ready) return
    void runStartupRecoveryFlow()
  }
)

/** Start backend-independent recovery reads once and share their result. */
function prefetchStartupRecovery(): Promise<StartupRecoveryData> {
  if (startupRecoveryPrefetch) return startupRecoveryPrefetch
  startupRecoveryPrefetch = Promise.all([
    window.silverdaw.consumePendingOpenPath(),
    window.silverdaw.listRecoverableAutosaves()
  ]).then(([pendingOpenPath, recoverableEntries]) => ({
    pendingOpenPath,
    recoverableEntries
  }))
  return startupRecoveryPrefetch
}

/** Drive the prefetched recovery-then-launch flow once the bridge is ready. */
async function runStartupRecoveryFlow(): Promise<void> {
  try {
    const { pendingOpenPath, recoverableEntries } = await prefetchStartupRecovery()
    if (pendingOpenPath) pendingOpenAfterRecovery = pendingOpenPath
    if (recoverableEntries.length > 0) {
      recoveryEntries.value = recoverableEntries
      recoveryDialogOpen.value = true
      return
    }
    finishStartupFlow()
  } catch (err) {
    log.error('app', `startup recovery scan failed: ${String(err)}`)
    transport.setBridgeFailure(
      'Silverdaw could not check for recovered projects. Please relaunch Silverdaw.'
    )
  }
}

/** Finish recovery, consume any parked cold-launch path, then release startup. */
function finishStartupFlow(): void {
  const parked = pendingOpenAfterRecovery
  pendingOpenAfterRecovery = null
  if (parked) {
    // Opening a project needs the engine ready to load it (PROJECT_STATE path), which can
    // lag the handshake while the audio device opens — defer until bridgeReady.
    openProjectWhenBridgeReady(parked)
  }
  appStore.markStartupFlowComplete()
}

/** Open a cold-launch path now if the engine is ready, else once it becomes ready. */
function openProjectWhenBridgeReady(filePath: string): void {
  // `openProjectByPath` now defers until `bridgeReady` itself, so just route through it.
  void openProjectByPath(filePath)
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
    // The startup picker (and a cold-launch path) can surface as soon as the WebSocket
    // handshake lands, which is BEFORE `bridgeReady` — the backend opens the audio device
    // and emits the first PROJECT_STATE only after the bridge is already serving. A click
    // in that window must NOT be dropped; defer the open until the bridge is ready (the
    // same contract the cold-launch path used) instead of silently ignoring it. Rapid
    // clicks coalesce onto the latest path behind a single watcher.
    deferredOpenPath = filePath
    if (stopDeferredOpen === null) {
      log.info('app', `deferring open ${filePath} until bridge ready`)
      stopDeferredOpen = watch(
        () => transport.bridgeReady,
        (ready) => {
          if (!ready) return
          stopDeferredOpen?.()
          stopDeferredOpen = null
          const next = deferredOpenPath
          deferredOpenPath = null
          if (next) void openProjectByPath(next)
        }
      )
    }
    return
  }
  guardAgainstUnsavedChanges(async () => {
    try {
      await window.silverdaw.prepareProjectOpen(filePath)
      project.requestLoad(filePath)
      // PROJECT_STATE hides StartupScreen without exposing the empty timeline.
    } catch (err) {
      appStore.finishRecentProjectOpen()
      log.warn('project', `prepareProjectOpen failed: ${String(err)}`)
      notifications.pushError(`Could not open project: ${String(err)}`)
    }
  })
}

/** Open a recent project, dropping stale MRU entries before loading. */
async function openRecentPath(filePath: string): Promise<void> {
  if (!filePath) return
  // The existence check + MRU cleanup are main-process IPC (independent of the backend
  // bridge), so they run immediately; the actual load defers to `openProjectByPath`,
  // which waits for `bridgeReady` if the picker was clicked before the engine finished
  // opening — so an early click is never silently dropped.
  let exists: boolean
  try {
    exists = await window.silverdaw.projectFileExists(filePath)
  } catch (err) {
    appStore.finishRecentProjectOpen()
    log.warn('app', `recent project check failed: ${String(err)}`)
    notifications.pushError(`Could not open project: ${String(err)}`)
    return
  }
  if (!exists) {
    appStore.finishRecentProjectOpen()
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
  if (appStore.openingRecentProjectPath !== null) return
  // Dismissal is driven by the project-loaded gate.
  appStore.beginRecentProjectOpen(filePath)
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

useMidiControllerActions(isInteractionBlocked)

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
  diagnosticsBusy,
  guardAgainstUnsavedChanges,
  isModalOpen: isInteractionBlocked,
  openRecentPath
})
</script>

<template>
  <div class="flex h-screen flex-col bg-zinc-950 text-zinc-100">
    <AppTitleBar :window-controls-disabled="isInteractionBlocked()" />

    <TransportBar />

    <main class="flex-1 overflow-hidden">
      <TimelineView v-if="!startupScreenVisible" />
    </main>

    <LibraryPanel
      :height="ui.libraryPanelHeight"
      @update:height="ui.setLibraryPanelHeight"
    />

    <ScratchEditorDialog
      :open="scratchEditor.isOpen"
      :clip-id="scratchEditor.clipId"
      :library-item-id="scratchEditor.libraryItemId"
      @close="scratchEditor.close"
    />

    <StatusBar />

    <NotificationToasts />

    <ImportProgressDialog v-if="library.imports.length > 0" />

    <AboutDialog
      v-if="aboutOpen"
      :open="aboutOpen"
      @close="aboutOpen = false"
    />

    <!-- Wait spinner while the diagnostics bundle is zipped (Help ▸ Send Diagnostic Logs). -->
    <div
      v-if="diagnosticsBusy"
      class="dialog-backdrop"
      role="alertdialog"
      aria-busy="true"
      aria-label="Preparing diagnostic logs"
    >
      <div class="flex flex-col items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900 px-8 py-6 shadow-2xl">
        <div
          class="h-8 w-8 animate-spin rounded-full border-2 border-zinc-700 border-t-zinc-100"
          aria-hidden="true"
        />
        <p class="text-sm text-zinc-200">
          Preparing diagnostic logs…
        </p>
      </div>
    </div>

    <PreferencesDialog
      v-if="preferencesOpen"
      :open="preferencesOpen"
      @close="preferencesOpen = false"
      @midi-monitor="midiMonitorOpen = true"
    />
    <MidiMonitorDialog
      v-if="midiMonitorOpen"
      :open="midiMonitorOpen"
      :inputs="midiDevices.inputs"
      :messages="midiDevices.monitorMessages"
      :clear="midiDevices.clearMonitorMessages"
      @close="midiMonitorOpen = false"
    />

    <ProjectPropertiesDialog
      v-if="projectPropertiesOpen"
      :open="projectPropertiesOpen"
      @close="projectPropertiesOpen = false"
    />

    <ExportMixdownDialog
      v-if="exportMixdownOpen"
      :open="exportMixdownOpen"
      @close="exportMixdownOpen = false"
    />

    <MixdownProgressDialog v-if="mixdownState !== null" />

    <StemSelectionDialog v-if="stemSelection !== null" />

    <StemModelDownloadDialog v-if="stemModelFlow !== null" />

    <StemSeparationProgressDialog v-if="stemSeparationState !== null" />

    <ChannelSplitDialog v-if="channelSplitSelection !== null" />

    <AudioDeviceUnavailableDialog
      v-if="audioUnavailableOpen"
      :open="audioUnavailableOpen"
      :saved-type-name="audioUnavailableSavedTypeName"
      :saved-device-name="audioUnavailableSavedDeviceName"
      @close="audioUnavailableOpen = false"
    />

    <SampleRateMismatchDialog
      v-if="sampleRatePromptState.open"
      :open="sampleRatePromptState.open"
      :buckets="sampleRatePromptState.buckets"
      :project-sample-rate="sampleRatePromptState.projectSampleRate"
      @choose="resolveSampleRateMismatchPrompt"
    />

    <UnsavedChangesDialog
      v-if="unsavedPromptOpen"
      :open="unsavedPromptOpen"
      :project-name="project.projectName"
      @save="onUnsavedPromptSave"
      @discard="onUnsavedPromptDiscard"
      @cancel="onUnsavedPromptCancel"
    />

    <RelinkDialog
      v-if="relinkDialogOpen"
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

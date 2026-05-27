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
import { effectiveClipDurationMs, useProjectStore } from '@/stores/projectStore'
import { useTransportStore } from '@/stores/transportStore'
import { useUiStore } from '@/stores/uiStore'
import { useLibraryStore } from '@/stores/libraryStore'
import { useNotificationsStore } from '@/stores/notificationsStore'
import { useAudioDeviceStore } from '@/stores/audioDeviceStore'
import { startAutosaveManager, stopAutosaveManager, clearAutosaveBucket } from '@/lib/autosave'
import { getActivePinia } from 'pinia'
import { connect as connectBridge, disconnect as disconnectBridge, send as sendBridge } from '@/lib/bridgeService'
import { log } from '@/lib/log'
import { registerMenuShortcuts } from '@/lib/menuShortcuts'
import { useAppStore } from '@/stores/appStore'

const project = useProjectStore()
const transport = useTransportStore()
const ui = useUiStore()
const library = useLibraryStore()
const notifications = useNotificationsStore()
const audioDevices = useAudioDeviceStore()
const appStore = useAppStore()

const aboutOpen = ref(false)
const preferencesOpen = ref(false)
const projectPropertiesOpen = ref(false)
const exportMixdownOpen = ref(false)
const relinkDialogOpen = ref(false)
// "Saved audio device not available" warning state. Populated by the
// project-load reconciliation watcher below when the project's stored
// audio-output preference doesn't match any device the OS currently
// exposes. The live `juce::AudioDeviceManager` keeps whatever device
// it opened at backend startup; the dialog is purely informational
// and the project's stored preference is left intact.
const audioUnavailableOpen = ref(false)
const audioUnavailableSavedTypeName = ref<string | null>(null)
const audioUnavailableSavedDeviceName = ref<string | null>(null)
// Dedupe key for the warning dialog so a single project + missing
// device combination only fires once per renderer session — without
// this, PROJECT_STATE echoes or audio-device-list refreshes could
// reopen the dialog after the user has dismissed it.
const audioReconciledKeys = new Set<string>()
const sampleRatePromptState = useSampleRateMismatchPromptState()
const mixdownState = useMixdownState()
// Crash-recovery state. Populated on bridge-ready by
// `autosave:listRecoverable`; if non-empty, the RecoveryDialog mounts
// and blocks the rest of the startup flow (auto-open + start screen)
// until the user resolves each entry. Mutually exclusive with
// `pendingOpenAfterRecovery`.
const recoveryEntries = ref<RecoverableEntry[]>([])
const recoveryDialogOpen = ref(false)
// Set when a cold-launch `.silverdaw` file is parked while the
// recovery dialog is open. Consumed once recovery resolves.
let pendingOpenAfterRecovery: string | null = null
// Unsaved-changes prompt state. `pendingAfterSave` is the action to
// run once the user has either saved or chosen to discard their
// changes. Set when the prompt opens; cleared when it closes.
const unsavedPromptOpen = ref(false)
let pendingAfterDiscard: (() => void) | null = null

let unsubscribeMenu: (() => void) | null = null
let unsubscribeOpenFromPath: (() => void) | null = null
let unregisterShortcuts: (() => void) | null = null
let cleanViewStateSave: Promise<void> | null = null

// Mirror the library's "import in flight" flag onto the <body> as a class
// so the global CSS rule (see <style> below) can swap the OS cursor to the
// platform's "busy / progress" shape while files decode. Toggling a single
// class on the root keeps it cheap and covers every element without each
// component having to opt in.
const stopImportingWatcher = watch(
  () => library.isImporting,
  (busy) => {
    document.body.classList.toggle('is-importing', busy)
  },
  { immediate: true }
)

// ─── Missing-file detection ────────────────────────────────────────────
// Watch the set of unresolved clip ids — when it transitions from empty
// to non-empty (i.e. a project just loaded with missing files), pop
// the RelinkDialog and a single toast. We watch on id-string so the
// dialog doesn't bounce open every time a clip property changes; it
// only re-opens when NEW unresolved clips appear.
const unresolvedClipIds = computed(() =>
  Object.values(project.clips)
    .filter((c) => c.unresolved)
    .map((c) => c.id)
    .sort()
    .join('|')
)
const stopUnresolvedWatch = watch(
  unresolvedClipIds,
  (next, prev) => {
    if (!next || next === prev) return
    const ids = next.split('|').filter((s) => s.length > 0)
    if (ids.length === 0) return
    // Only auto-open / toast when this is a fresh set that wasn't
    // there before (or has grown).
    const prevIds = (prev ?? '').split('|').filter((s) => s.length > 0)
    const isNew = ids.some((id) => !prevIds.includes(id))
    if (!isNew) return
    relinkDialogOpen.value = true
    // Count UNIQUE missing file paths (not clip references) so the
    // toast matches the row count the RelinkDialog actually shows —
    // a project with five clips referencing one missing file should
    // say "1 audio file is missing", not "5 audio files".
    const uniqueMissingPaths = new Set<string>()
    for (const id of ids) {
      const clip = project.clips[id]
      if (clip) uniqueMissingPaths.add(clip.filePath)
    }
    const fileCount = uniqueMissingPaths.size
    notifications.push(
      'error',
      `${fileCount} ${fileCount === 1 ? 'audio file is' : 'audio files are'} missing — locate or relink to play.`
    )
  }
)

onMounted(() => {
  log.info('app', 'mounted')
  unsubscribeMenu = window.silverdaw.onMenuAction(handleMenuAction)
  // Warm-launch hand-offs: a second `Silverdaw.exe <file.silverdaw>`
  // collapses into this instance via the single-instance lock; main
  // pushes the path here.
  unsubscribeOpenFromPath = window.silverdaw.onOpenProjectFromPath((filePath) => {
    void openProjectByPath(filePath)
  })
  unregisterShortcuts = registerMenuShortcuts({ devToolsEnabled: appStore.devToolsEnabled })
  window.addEventListener('keydown', onGlobalShortcutKey, { capture: true })
  connectBridge()
  startBridgeConnectionTimer()
  // Pull persisted panel sizes from the main-process preferences file so
  // the layout is correct from the very first paint. (Default values are
  // already in the store, so a slow hydrate just looks like a tiny size
  // tween rather than a jarring jump.)
  void ui.hydrate()
  // Start the background autosave manager. The manager subscribes to
  // `projectStore.isDirty` + the autosave config — it stays idle until
  // there's actually something to save, then ticks every N seconds.
  const pinia = getActivePinia()
  if (pinia) startAutosaveManager(pinia)
})

// ─── Global keyboard shortcuts ────────────────────────────────────────────
// Arrow Left / Arrow Right step the playhead back / forward to the
// adjacent grid line (sub-beat — 16th-note in 4/4, matching the
// timeline's finest grid division). Skipped while focus is in any
// editable field so arrows still move the text cursor in the rename
// input, numeric BPM/length inputs, etc.
//
// Step size = 60 000 / bpm / SUBDIVISIONS_PER_BEAT, so a tempo change
// automatically rescales the step. SUBDIVISIONS_PER_BEAT is duplicated
// here from `@/lib/timeline/constants` because importing the whole
// timeline module just for one constant would pull in the PixiJS-aware
// drawing graph; the value (4) hasn't moved since project inception
// and is the canonical 16th-note resolution.
const SUB_BEATS_PER_BEAT = 4

// Last position the arrow-step shortcut asked the backend to seek to.
// Used as the basis for the NEXT arrow press when the backend's reported
// position has rounded to slightly less than the floating-point target —
// otherwise repeated presses get stuck oscillating between adjacent
// grid lines because of sub-millisecond round-trip error.
let lastArrowSeekMs: number | null = null

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return target.isContentEditable
}

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

function onGlobalShortcutKey(e: KeyboardEvent): void {
  // Don't fight text fields, and don't trigger before the bridge is up
  // (no point sending TRANSPORT_SEEK that the backend would just drop).
  if (isEditableTarget(e.target)) return
  if (isShortcutModalOpen()) return
  if (!transport.bridgeReady) return

  if (e.code === 'Space' && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
    e.preventDefault()
    e.stopPropagation()
    if (e.repeat) return
    lastArrowSeekMs = null
    if (transport.isPlaying) {
      sendBridge('TRANSPORT_PAUSE')
      transport.setPlaybackState(false)
      log.info('transport', 'shortcut pause')
    } else {
      // Playhead parked at the end → Spacebar Play is a no-op.
      // Mirrors `TransportBar.onPlay`'s guard so the keyboard
      // shortcut can't bypass the disabled Play button.
      const end = project.durationMs
      if (end > 0 && transport.positionMs >= end) {
        log.info('transport', 'shortcut play ignored (at end of project)')
        return
      }
      sendBridge('TRANSPORT_PLAY')
      transport.setPlaybackState(true)
      log.info('transport', 'shortcut play')
    }
    return
  }

  if ((e.ctrlKey || e.metaKey) && !e.altKey) {
    let zoomAction: 'in' | 'out' | 'reset' | null = null
    if (e.key === '+' || e.key === '=' || e.code === 'NumpadAdd') {
      zoomAction = 'in'
    } else if (e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract') {
      zoomAction = 'out'
    } else if (e.key === '0' || e.code === 'Numpad0' || e.code === 'Digit0') {
      zoomAction = 'reset'
    }
    if (zoomAction) {
      e.preventDefault()
      e.stopPropagation()
      ui.requestTimelineZoom(zoomAction)
      return
    }
  }

  if (e.key.toLowerCase() === 'm' && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
    e.preventDefault()
    e.stopPropagation()
    const msPerSub = 60_000 / transport.bpm / SUB_BEATS_PER_BEAT
    const snappedMs = Math.max(0, Math.round(transport.positionMs / msPerSub) * msPerSub)
    project.toggleMarkerAt(snappedMs)
    return
  }

  if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    e.preventDefault()
    e.stopPropagation()
    lastArrowSeekMs = null
    if (e.key === 'ArrowLeft') {
      // Skip-to-start: scroll the view + rewind the playhead. Never
      // touches the playback state — playing carries on from 0.
      ui.requestTimelineScroll('start')
      transport.setPosition(0)
      sendBridge('TRANSPORT_SEEK', { positionMs: 0 })
      log.info('transport', 'shortcut skip-back')
      return
    }

    const end = project.durationMs
    if (!Number.isFinite(end) || end <= 0) return
    ui.requestTimelineScroll('end')
    transport.setPosition(end)
    sendBridge('TRANSPORT_SEEK', { positionMs: end })
    log.info('transport', `shortcut skip-forward -> ${end}ms`)
    return
  }

  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    e.preventDefault()
    e.stopPropagation()
    const direction = e.key === 'ArrowLeft' ? -1 : 1
    if (project.markers.length === 0) return
    const current = transport.positionMs
    const targetMarker =
      direction < 0
        ? [...project.markers].reverse().find((marker) => marker.positionMs < current - 1)
        : project.markers.find((marker) => marker.positionMs > current + 1)
    if (!targetMarker) return
    lastArrowSeekMs = targetMarker.positionMs
    ui.requestTimelineScrollToPosition(targetMarker.positionMs)
    transport.setPosition(targetMarker.positionMs)
    sendBridge('TRANSPORT_SEEK', { positionMs: targetMarker.positionMs })
    log.debug('transport', `marker-seek to ${targetMarker.positionMs}ms`)
    return
  }

  if (e.ctrlKey || e.metaKey || e.shiftKey) return
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return

  // Alt + Arrow: fine-grained step (one pixel's worth of time at the
  // current zoom). Use this when placing the playhead exactly inside a
  // clip waveform for a future split. At default zoom (100 px/s) that's
  // ~16.7 ms; at max zoom (480 px/s) it's ~2 ms. Always at least 1 ms.
  // Bare Arrow: grid step (sub-beat / 16th note).
  const direction = e.key === 'ArrowLeft' ? -1 : 1
  if (e.altKey) {
    const pxPerSec = project.viewPxPerSecond ?? 60
    const msPerPx = Math.max(1, 1000 / pxPerSec)
    const reported = transport.positionMs
    const base =
      lastArrowSeekMs !== null && Math.abs(reported - lastArrowSeekMs) < 1
        ? lastArrowSeekMs
        : reported
    const target = Math.max(0, base + direction * msPerPx)
    if (target === reported) return
    e.preventDefault()
    e.stopPropagation()
    lastArrowSeekMs = target
    transport.setPosition(target)
    ui.requestTimelineScrollToPosition(target)
    sendBridge('TRANSPORT_SEEK', { positionMs: target })
    log.debug('transport', `alt-arrow-seek to ${target.toFixed(2)}ms (${msPerPx.toFixed(2)}ms/px step)`)
    return
  }

  const bpm = transport.bpm
  if (!Number.isFinite(bpm) || bpm <= 0) return
  const msPerSub = 60_000 / bpm / SUB_BEATS_PER_BEAT

  // If our last arrow-seek target is still essentially the current
  // position (the backend's ack will have rounded by a sub-millisecond
  // at non-integer-rate BPMs), compute the next step from THAT exact
  // value rather than the rounded one. Without this, repeated arrow
  // presses can get pinned to the same grid line as floor() keeps
  // rounding the reported position to the previous bucket index.
  const reported = transport.positionMs
  const base =
    lastArrowSeekMs !== null && Math.abs(reported - lastArrowSeekMs) < 1
      ? lastArrowSeekMs
      : reported

  const target =
    direction < 0
      ? Math.max(0, Math.floor((base - 1e-6) / msPerSub) * msPerSub)
      : (Math.floor(base / msPerSub + 1e-6) + 1) * msPerSub
  if (target === reported) return

  e.preventDefault()
  e.stopPropagation()
  lastArrowSeekMs = target
  transport.setPosition(target)
  ui.requestTimelineScrollToPosition(target)
  sendBridge('TRANSPORT_SEEK', { positionMs: target })
  log.debug('transport', `arrow-seek to ${target}ms (msPerSub=${msPerSub.toFixed(2)})`)
}

// ─── Per-project audio output reconciliation ──────────────────────────
// When a project loads, its saved audio-output preference (if any)
// drives a live device switch. The reconcile runs once per unique
// (projectId, savedType, savedDevice) tuple per renderer session so
// that PROJECT_STATE echoes (mutation acks, undo soft-replaces) don't
// re-fire the switch. The device list arrives independently of
// PROJECT_STATE — we watch both signals and gate on
// `audioDevices.hydrated`.
function reconcileProjectAudioOutput(): void {
  if (!audioDevices.hydrated) return
  const projectId = project.projectId
  if (!projectId) return
  const savedType = project.audioOutputTypeName
  const savedDevice = project.audioOutputDeviceName
  if (!savedType || !savedDevice) return

  const key = `${projectId}::${savedType}::${savedDevice}`
  if (audioReconciledKeys.has(key)) return
  audioReconciledKeys.add(key)

  // Already on the saved device — nothing to do.
  if (
    audioDevices.currentTypeName === savedType &&
    audioDevices.currentDeviceName === savedDevice
  ) {
    log.info('audio', `project audio output already active (${savedType} / ${savedDevice})`)
    return
  }

  const available = audioDevices.flatDevices.some(
    (d) => d.typeName === savedType && d.deviceName === savedDevice
  )
  if (available) {
    log.info('audio', `switching to project audio output (${savedType} / ${savedDevice})`)
    audioDevices.selectDevice(savedType, savedDevice, { persistUserPreference: false })
  } else {
    log.warn(
      'audio',
      `project audio output unavailable (${savedType} / ${savedDevice}); leaving live device on default`
    )
    audioUnavailableSavedTypeName.value = savedType
    audioUnavailableSavedDeviceName.value = savedDevice
    audioUnavailableOpen.value = true
  }
}

// Two triggers: project load (PROJECT_STATE applies, projectId changes
// and the audioOutput fields may change) AND audio-device hydration
// (the device list arrives after PROJECT_STATE on the connect path).
watch(
  () => [
    project.projectId,
    project.audioOutputTypeName,
    project.audioOutputDeviceName,
    audioDevices.hydrated
  ] as const,
  () => {
    reconcileProjectAudioOutput()
  },
  { immediate: true }
)

// ─── Initial bridge-connection timeout ────────────────────────────────
// Without this the StartupScreen can sit on screen forever if the
// backend never starts (missing exe, wrong path, crashed at launch) or
// if the bridge handshake fails (socket open but no PROJECT_STATE). 30
// seconds comfortably covers a cold backend launch + initial
// `audio device init` on a slow machine while still being short enough
// that a real failure is surfaced before the user gives up.
const BRIDGE_CONNECTION_TIMEOUT_MS = 30_000
let bridgeTimer: ReturnType<typeof setTimeout> | null = null

function startBridgeConnectionTimer(): void {
  if (bridgeTimer) clearTimeout(bridgeTimer)
  bridgeTimer = setTimeout(() => {
    bridgeTimer = null
    if (transport.bridgeReady) return
    log.warn('app', `bridge connection timed out after ${BRIDGE_CONNECTION_TIMEOUT_MS}ms`)
    // Phrase the message so it reads like a normal end-user error — no
    // mention of logs, debug mode, or developer concepts. The two
    // failure modes (socket never opened vs opened but no handshake)
    // get slightly different copy so a relaunch lands the user closer
    // to the right next step.
    const message = transport.connected
      ? 'Silverdaw connected to the audio engine but did not receive a response. Please relaunch Silverdaw.'
      : 'Silverdaw could not connect to the audio engine. Please relaunch Silverdaw.'
    transport.setBridgeFailure(message)
  }, BRIDGE_CONNECTION_TIMEOUT_MS)
}

// Cancel the timer the instant the bridge comes up. Subsequent
// disconnect/reconnect cycles do NOT re-arm it — those are normal
// session events handled by `bridgeService`'s backoff loop, not
// terminal startup failures.
const stopBridgeTimerWatcher = watch(
  () => transport.bridgeReady,
  (ready) => {
    if (ready && bridgeTimer) {
      clearTimeout(bridgeTimer)
      bridgeTimer = null
    }
    if (!ready) return
    // ── Startup coordinator ────────────────────────────────────────────
    // 1. Park any cold-launch hand-off path so it doesn't race the
    //    recovery scan (consumePendingOpenPath clears the slot in main;
    //    we hold the value locally until the recovery flow has
    //    finished).
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

/** Called once the recovery dialog has resolved (Restore + close, or
 *  Skip, or no entries to begin with). Runs the cold-launch
 *  hand-off if one was parked, then marks the startup flow complete
 *  so the start screen can decide whether to mount. */
function finishStartupFlow(): void {
  const parked = pendingOpenAfterRecovery
  pendingOpenAfterRecovery = null
  if (parked) {
    // Cold-launch hand-off. The StartupScreen stays mounted while
    // the project loads — its disappearance is driven by the
    // `currentFilePath !== null` arm of `startupScreenVisible`,
    // so there's no need (or desire) to dismiss it preemptively.
    void openProjectByPath(parked)
  }
  appStore.markStartupFlowComplete()
}

function onRecoveryRestored(): void {
  // Restore implies a project will replace the empty boot snapshot;
  // discard any parked cold-launch path so we don't immediately
  // navigate away from the recovered project.
  pendingOpenAfterRecovery = null
}

function onRecoveryClose(): void {
  recoveryDialogOpen.value = false
  recoveryEntries.value = []
  finishStartupFlow()
}

/**
 * Shared entry point for both the cold-launch and warm-launch hand-offs
 * from a `.silverdaw` file association. Runs the same unsaved-changes
 * guard and allow-list seeding that File > Open uses, then sends
 * PROJECT_LOAD over the bridge.
 */
async function openProjectByPath(filePath: string): Promise<void> {
  if (!filePath) return
  if (!transport.bridgeReady) {
    log.warn('app', `dropped open-from-path ${filePath} (bridge not ready)`)
    return
  }
  guardAgainstUnsavedChanges(async () => {
    await window.silverdaw.prepareProjectOpen(filePath)
    project.requestLoad(filePath)
    // The StartupScreen hides naturally when PROJECT_STATE arrives and
    // `currentFilePath` becomes non-null. Dismissing here would briefly
    // expose the empty timeline during the load round-trip.
  })
}

/**
 * Open a Recent Projects entry. Guarded by the unsaved-changes prompt
 * + main's path allow-list seeding. If the file no longer exists, the
 * MRU entry is removed and a toast surfaces the failure — the user
 * was probably looking at a stale list.
 */
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
  // "New Project" creates an empty workspace with no file path and
  // no tracks, so the natural file-loaded gate can't hide the
  // screen — we have to dismiss explicitly.
  appStore.dismissStartScreen()
  handleMenuAction('file.newProject')
}

function onStartScreenOpen(): void {
  // Defer dismissal to the project-loaded gate via `openProjectByPath`.
  // If the user cancels the file dialog, the screen stays.
  handleMenuAction('file.openProject')
}

function onStartScreenRecent(filePath: string): void {
  // Same as Open: dismissal is driven by the project-loaded gate.
  void openRecentPath(filePath)
}

/**
 * Visibility of the startup landing screen. Mounts on app boot
 * (does NOT wait for bridge-ready) and stays visible until the
 * project becomes non-empty or the user explicitly dismisses it.
 * The screen has its own internal "loading / failure / ready"
 * states; gating those there rather than here keeps the boot to
 * a single visual surface — there's no cross-fade between two
 * splashes.
 *
 * RecoveryDialog stacks above this overlay via z-index, so we
 * intentionally do NOT include `recoveryDialogOpen` in the gate.
 *
 * The session-scoped `startScreenDismissed` flag prevents the
 * screen from re-appearing once the user has clicked through to
 * a project — including the empty "New Project" case where
 * currentFilePath is still null.
 */
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
  unregisterShortcuts?.()
  unregisterShortcuts = null
  window.removeEventListener('keydown', onGlobalShortcutKey, { capture: true })
  disconnectBridge()
  stopAutosaveManager()
  stopImportingWatcher()
  stopBridgeTimerWatcher()
  stopUnresolvedWatch()
  if (bridgeTimer) {
    clearTimeout(bridgeTimer)
    bridgeTimer = null
  }
  document.body.classList.remove('is-importing')
})

function handleMenuAction(action: string): void {
  log.info('menu', `action ${action}`)
  // The About dialog must remain reachable even before the bridge has
  // delivered its first PROJECT_STATE — it doesn't touch project state
  // and users may want to see version / licence info while diagnosing a
  // backend-startup problem. Same reasoning applies to Preferences.
  if (action === 'help.about') {
    aboutOpen.value = true
    return
  }
  if (action === 'edit.preferences') {
    preferencesOpen.value = true
    return
  }
  // Quitting / closing the window must work regardless of bridge
  // state — the user has to be able to give up on a stuck startup.
  // `project.isDirty` is reliably false until the bridge has
  // delivered at least one PROJECT_STATE, so the guard is a no-op
  // in that case anyway.
  if (action === 'file.exit') {
    guardAgainstUnsavedChanges(() => window.silverdaw.menuAction('file.exitConfirmed'))
    return
  }
  if (action === 'app.requestClose') {
    guardAgainstUnsavedChanges(() => window.silverdaw.menuAction('app.confirmClose'))
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
  // Adding a track is now just "create an empty track". Importing a file
  // into the track happens via the per-track Import button on the track
  // header panel (see TrackHeaderPanel.vue).
  if (action === 'file.addTrack') {
    project.addTrack()
    return
  }
  if (action === 'file.projectProperties') {
    projectPropertiesOpen.value = true
    return
  }
  if (action === 'file.exportMixdown') {
    exportMixdownOpen.value = true
    return
  }
  if (action === 'file.newProject') {
    guardAgainstUnsavedChanges(() => {
      project.requestNewProject()
      appStore.dismissStartScreen()
    })
    return
  }
  if (action === 'file.openProject') {
    guardAgainstUnsavedChanges(() => {
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
    openRecentPath(filePath)
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
          (result.error?.startsWith('Timed out') || result.error === 'Backend is not connected')
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
            (result.error?.startsWith('Timed out') || result.error === 'Backend is not connected')
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
      notifications.pushInfo('No clips on the timeline — nothing to crop.')
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

/**
 * Run `proceed` only after the user has either saved or chosen to
 * discard the current project's unsaved changes. If the project is
 * already clean, first flush view-only state (scroll/playhead) to disk
 * without opening the unsaved-changes prompt.
 *
 * Used to gate File > New, File > Open, and the app-close path.
 */
function guardAgainstUnsavedChanges(proceed: () => void): void {
  if (!project.isDirty) {
    void persistCleanViewState().then(proceed)
    return
  }
  pendingAfterDiscard = proceed
  unsavedPromptOpen.value = true
}

async function persistCleanViewState(): Promise<void> {
  if (!transport.bridgeReady || !project.currentFilePath || cleanViewStateSave) {
    return cleanViewStateSave ?? Promise.resolve()
  }
  cleanViewStateSave = project
    .saveViewStateAndWait()
    .then((result) => {
      if (!result.ok) {
        log.warn('project', `view-state save failed: ${result.error ?? 'unknown error'}`)
      }
    })
    .finally(() => {
      cleanViewStateSave = null
    })
  return cleanViewStateSave
}

/**
 * User picked "Save" in the unsaved-changes prompt. Save the project
 * (Save vs Save As depending on whether there's already a path) and,
 * on a successful ack, run the pending action. On failure or cancel
 * we don't proceed — the user can retry.
 */
async function onUnsavedPromptSave(): Promise<void> {
  unsavedPromptOpen.value = false
  const next = pendingAfterDiscard
  pendingAfterDiscard = null
  if (!next) return

  let filePath = project.currentFilePath
  let isSaveAs = false
  if (!filePath) {
    isSaveAs = true
    filePath = await window.silverdaw.chooseProjectSaveAs(project.projectName || 'Untitled')
    if (!filePath) return // user cancelled the Save As dialog → abort
  }

  const result = await project.saveAndWait(filePath, isSaveAs)
  if (!result.ok) {
    if (
      result.error?.startsWith('Timed out') ||
      result.error === 'Backend is not connected'
    ) {
      notifications.pushError(`Save failed: ${result.error}.`)
    }
    return // PROJECT_SAVED reported failures are shown by bridgeService
  }
  next()
}

async function onUnsavedPromptDiscard(): Promise<void> {
  unsavedPromptOpen.value = false
  const next = pendingAfterDiscard
  pendingAfterDiscard = null
  // The user explicitly chose to throw away their unsaved changes.
  // Delete this project's autosave bucket so the next launch's
  // recovery scanner doesn't resurrect them as a "we crashed, want
  // to restore?" prompt. We MUST await this before proceeding —
  // `next` is typically `app.confirmClose` / `file.exitConfirmed`
  // which synchronously calls `app.exit(0)` in main, terminating
  // the process before any in-flight IPC can land. Without the
  // await the autosave folder stays on disk and the next launch
  // still offers recovery.
  const projectId = project.projectId
  if (projectId) {
    await clearAutosaveBucket(projectId)
  }
  next?.()
}

function onUnsavedPromptCancel(): void {
  unsavedPromptOpen.value = false
  pendingAfterDiscard = null
}
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
      @close="onRecoveryClose"
    />

    <StartupScreen
      :open="startupScreenVisible"
      :startup-flow-complete="appStore.startupFlowComplete"
      :recovery-open="recoveryDialogOpen"
      @new-project="onStartScreenNew"
      @open-project="onStartScreenOpen"
      @open-recent="onStartScreenRecent"
    />
  </div>
</template>

<style>
/*
 * While the library is importing one or more files, force the OS "busy"
 * cursor everywhere — including over text inputs and interactive widgets
 * that would otherwise pick their own cursor. `!important` is required to
 * win against Tailwind utility classes (e.g. `cursor-pointer` on buttons)
 * and the browser default for inputs.
 *
 * `progress` is the standard "busy but still interactive" cursor; pick it
 * over `wait` so the user can keep navigating menus, scrolling the
 * timeline, etc. while a decode is in flight.
 */
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

/*
 * Shared dark scrollbar treatment. Apply `class="silverdaw-scroll"` to
 * any element whose `overflow-y: auto` chrome would otherwise inherit
 * the browser default (which on Windows is a bright grey track that
 * looks misplaced inside the dark zinc panels). The colours are the
 * same ones the library panel + library-item-info dialog use, lifted
 * here so dialogs, dropdowns and tabbed bodies share one rule instead
 * of each component re-declaring its own.
 *
 *   - Firefox: scrollbar-color / scrollbar-width (thin thumb).
 *   - Chromium / Electron: the ::-webkit-scrollbar pseudo-elements
 *     give us a 12-px chrome with a rounded pill thumb surrounded by
 *     a 3-px transparent ring so the thumb visually shrinks away from
 *     the track edge.
 */
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

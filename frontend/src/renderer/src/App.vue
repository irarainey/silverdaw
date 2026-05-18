<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AppTitleBar from '@/components/AppTitleBar.vue'
import TimelineView from '@/components/TimelineView.vue'
import TransportBar from '@/components/TransportBar.vue'
import LibraryPanel from '@/components/LibraryPanel.vue'
import StatusBar from '@/components/StatusBar.vue'
import NotificationToasts from '@/components/NotificationToasts.vue'
import BridgeReadyOverlay from '@/components/BridgeReadyOverlay.vue'
import AboutDialog from '@/components/AboutDialog.vue'
import PreferencesDialog from '@/components/PreferencesDialog.vue'
import UnsavedChangesDialog from '@/components/UnsavedChangesDialog.vue'
import { useProjectStore } from '@/stores/projectStore'
import { useTransportStore } from '@/stores/transportStore'
import { useUiStore } from '@/stores/uiStore'
import { useLibraryStore } from '@/stores/libraryStore'
import { connect as connectBridge, disconnect as disconnectBridge, send as sendBridge } from '@/lib/bridgeService'
import { log } from '@/lib/log'
import { registerMenuShortcuts } from '@/lib/menuShortcuts'
import { useAppStore } from '@/stores/appStore'

const project = useProjectStore()
const transport = useTransportStore()
const ui = useUiStore()
const library = useLibraryStore()
const appStore = useAppStore()

const aboutOpen = ref(false)
const preferencesOpen = ref(false)
// Unsaved-changes prompt state. `pendingAfterSave` is the action to
// run once the user has either saved or chosen to discard their
// changes. Set when the prompt opens; cleared when it closes.
const unsavedPromptOpen = ref(false)
let pendingAfterDiscard: (() => void) | null = null
// Template ref to the title bar so menu actions can reach into it
// (specifically `file.renameProject` → AppTitleBar.startRename()).
const titleBarRef = ref<InstanceType<typeof AppTitleBar> | null>(null)

let unsubscribeMenu: (() => void) | null = null
let unsubscribeOpenFromPath: (() => void) | null = null
let unregisterShortcuts: (() => void) | null = null

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

onMounted(() => {
  log.info('app', 'mounted')
  unsubscribeMenu = window.silverdaw.onMenuAction(handleMenuAction)
  // Warm-launch hand-offs: a second `Silverdaw.exe <file.silverdaw>`
  // collapses into this instance via the single-instance lock; main
  // pushes the path here.
  unsubscribeOpenFromPath = window.silverdaw.onOpenProjectFromPath((filePath) => {
    void openProjectByPath(filePath)
  })
  unregisterShortcuts = registerMenuShortcuts({ debugMode: appStore.debugMode })
  window.addEventListener('keydown', onTransportKey, { capture: true })
  connectBridge()
  startBridgeConnectionTimer()
  // Pull persisted panel sizes from the main-process preferences file so
  // the layout is correct from the very first paint. (Default values are
  // already in the store, so a slow hydrate just looks like a tiny size
  // tween rather than a jarring jump.)
  void ui.hydrate()
})

// ─── Transport keyboard shortcuts ─────────────────────────────────────────
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

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return target.isContentEditable
}

function onTransportKey(e: KeyboardEvent): void {
  // Don't fight text fields, and don't trigger before the bridge is up
  // (no point sending TRANSPORT_SEEK that the backend would just drop).
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return
  if (isEditableTarget(e.target)) return
  if (!transport.bridgeReady) return
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return

  const bpm = transport.bpm
  if (!Number.isFinite(bpm) || bpm <= 0) return
  const msPerSub = 60_000 / bpm / SUB_BEATS_PER_BEAT
  const cur = transport.positionMs
  // Subtracting 1 ms before flooring guarantees that pressing ← while
  // already sitting exactly on a grid line lands on the previous one
  // (not the current one); similarly + msPerSub after flooring forces
  // → to advance past the current line even when `cur` is on a
  // boundary.
  const target =
    e.key === 'ArrowLeft'
      ? Math.max(0, Math.floor((cur - 1) / msPerSub) * msPerSub)
      : (Math.floor(cur / msPerSub) + 1) * msPerSub
  if (target === cur) return

  e.preventDefault()
  e.stopPropagation()
  transport.setPosition(target)
  sendBridge('TRANSPORT_SEEK', { positionMs: target })
  log.debug('transport', `arrow-seek to ${target}ms (msPerSub=${msPerSub.toFixed(2)})`)
}

// ─── Initial bridge-connection timeout ────────────────────────────────
// Without this the BridgeReadyOverlay can sit on screen forever if the
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
    // Cold-launch hand-off from `Silverdaw.exe <file.silverdaw>`. We
    // can only safely send PROJECT_LOAD after the bridge has delivered
    // its first PROJECT_STATE; the renderer's menu-action gate enforces
    // the same rule for File > Open, so we defer the consume call until
    // here. Fire-and-forget — a `null` return just means the app was
    // launched normally.
    if (ready) {
      void window.silverdaw.consumePendingOpenPath().then((filePath) => {
        if (filePath) void openProjectByPath(filePath)
      })
    }
  }
)

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
  })
}

onBeforeUnmount(() => {
  log.info('app', 'beforeUnmount')
  unsubscribeMenu?.()
  unsubscribeMenu = null
  unsubscribeOpenFromPath?.()
  unsubscribeOpenFromPath = null
  unregisterShortcuts?.()
  unregisterShortcuts = null
  window.removeEventListener('keydown', onTransportKey, { capture: true })
  disconnectBridge()
  stopImportingWatcher()
  stopBridgeTimerWatcher()
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
  // <BridgeReadyOverlay> swallows mouse clicks but accelerators bypass
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
  if (action === 'file.newProject') {
    guardAgainstUnsavedChanges(() => project.requestNewProject())
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
      })
    })
    return
  }
  if (action === 'file.save') {
    // No current path → fall through to Save As so the user gets the
    // OS dialog rather than a confusing silent failure.
    if (!project.requestSave()) {
      handleMenuAction('file.saveAs')
    }
    return
  }
  if (action === 'file.saveAs') {
    void window.silverdaw
      .chooseProjectSaveAs(project.projectName || 'Untitled')
      .then((filePath) => {
        if (filePath) project.requestSaveAs(filePath)
      })
    return
  }
  if (action === 'file.renameProject') {
    // The rename input lives in AppTitleBar; switch it into edit mode
    // via the exposed `startRename` method. Works for both the menu
    // click and the F2 accelerator (which routes through main).
    void titleBarRef.value?.startRename()
    return
  }
}

/**
 * Run `proceed` only after the user has either saved or chosen to
 * discard the current project's unsaved changes. If the project is
 * already clean, `proceed` runs immediately.
 *
 * Used to gate File > New, File > Open, and the app-close path.
 */
function guardAgainstUnsavedChanges(proceed: () => void): void {
  if (!project.isDirty) {
    proceed()
    return
  }
  pendingAfterDiscard = proceed
  unsavedPromptOpen.value = true
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
  if (!result.ok) return // PROJECT_SAVED reported failure; toast is shown by bridgeService
  next()
}

function onUnsavedPromptDiscard(): void {
  unsavedPromptOpen.value = false
  const next = pendingAfterDiscard
  pendingAfterDiscard = null
  next?.()
}

function onUnsavedPromptCancel(): void {
  unsavedPromptOpen.value = false
  pendingAfterDiscard = null
}
</script>

<template>
  <div class="flex h-screen flex-col bg-zinc-950 text-zinc-100">
    <AppTitleBar ref="titleBarRef" />

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

    <BridgeReadyOverlay />

    <AboutDialog
      :open="aboutOpen"
      @close="aboutOpen = false"
    />

    <PreferencesDialog
      :open="preferencesOpen"
      @close="preferencesOpen = false"
    />

    <UnsavedChangesDialog
      :open="unsavedPromptOpen"
      :project-name="project.projectName"
      @save="onUnsavedPromptSave"
      @discard="onUnsavedPromptDiscard"
      @cancel="onUnsavedPromptCancel"
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
</style>

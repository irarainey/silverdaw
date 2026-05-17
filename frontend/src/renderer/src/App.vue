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
import { useProjectStore } from '@/stores/projectStore'
import { useTransportStore } from '@/stores/transportStore'
import { useUiStore } from '@/stores/uiStore'
import { useLibraryStore } from '@/stores/libraryStore'
import { connect as connectBridge, disconnect as disconnectBridge } from '@/lib/bridgeService'
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
// Template ref to the title bar so menu actions can reach into it
// (specifically `file.renameProject` → AppTitleBar.startRename()).
const titleBarRef = ref<InstanceType<typeof AppTitleBar> | null>(null)

let unsubscribeMenu: (() => void) | null = null
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
  unregisterShortcuts = registerMenuShortcuts({ debugMode: appStore.debugMode })
  connectBridge()
  startBridgeConnectionTimer()
  // Pull persisted panel sizes from the main-process preferences file so
  // the layout is correct from the very first paint. (Default values are
  // already in the store, so a slow hydrate just looks like a tiny size
  // tween rather than a jarring jump.)
  void ui.hydrate()
})

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
  }
)

// Auto-open the most recently saved/loaded project as soon as the bridge
// is live. Runs exactly once per app session — the `once` flag stops a
// later disconnect / reconnect cycle from re-opening it on top of the
// user's current edits.
let autoOpenAttempted = false
const stopAutoOpenWatcher = watch(
  () => transport.bridgeReady,
  async (ready) => {
    if (!ready || autoOpenAttempted) return
    autoOpenAttempted = true
    try {
      const lastPath = await window.silverdaw.getLastProjectPath()
      if (!lastPath) {
        log.info('app', 'no last project; staying on the new empty project')
        return
      }
      const exists = await window.silverdaw.projectFileExists(lastPath)
      if (!exists) {
        log.warn('app', `last project missing: ${lastPath}`)
        window.silverdaw.setLastProjectPath(null)
        return
      }
      log.info('app', `auto-opening last project: ${lastPath}`)
      // Bring referenced audio paths into the renderer's allow-list
      // before triggering the backend load — otherwise the post-load
      // metadata refresh (cover art, ID3 tags) is blocked by main.
      await window.silverdaw.prepareProjectOpen(lastPath)
      project.requestLoad(lastPath)
    } catch (err) {
      log.warn('app', `auto-open failed: ${String(err)}`)
    }
  }
)

onBeforeUnmount(() => {
  log.info('app', 'beforeUnmount')
  unsubscribeMenu?.()
  unsubscribeMenu = null
  unregisterShortcuts?.()
  unregisterShortcuts = null
  disconnectBridge()
  stopImportingWatcher()
  stopAutoOpenWatcher()
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
    project.requestNewProject()
    return
  }
  if (action === 'file.openProject') {
    void window.silverdaw.chooseProjectOpen().then(async (filePath) => {
      if (!filePath) return
      // Same allow-list seeding as the auto-open path. The metadata
      // refresh fired by `applyProjectStateSnapshot` runs as soon as
      // the backend echoes PROJECT_STATE, so the paths must be on the
      // whitelist by that point.
      await window.silverdaw.prepareProjectOpen(filePath)
      project.requestLoad(filePath)
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

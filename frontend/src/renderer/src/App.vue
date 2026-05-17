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
import { useProjectStore } from '@/stores/projectStore'
import { useTransportStore } from '@/stores/transportStore'
import { useUiStore } from '@/stores/uiStore'
import { useLibraryStore } from '@/stores/libraryStore'
import { connect as connectBridge, disconnect as disconnectBridge } from '@/lib/bridgeService'
import { log } from '@/lib/log'

const project = useProjectStore()
const transport = useTransportStore()
const ui = useUiStore()
const library = useLibraryStore()

const aboutOpen = ref(false)

let unsubscribeMenu: (() => void) | null = null

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
  connectBridge()
  // Pull persisted panel sizes from the main-process preferences file so
  // the layout is correct from the very first paint. (Default values are
  // already in the store, so a slow hydrate just looks like a tiny size
  // tween rather than a jarring jump.)
  void ui.hydrate()
})

onBeforeUnmount(() => {
  log.info('app', 'beforeUnmount')
  unsubscribeMenu?.()
  unsubscribeMenu = null
  disconnectBridge()
  stopImportingWatcher()
  document.body.classList.remove('is-importing')
})

function handleMenuAction(action: string): void {
  log.info('menu', `action ${action}`)
  // The About dialog must remain reachable even before the bridge has
  // delivered its first PROJECT_STATE — it doesn't touch project state
  // and users may want to see version / licence info while diagnosing a
  // backend-startup problem.
  if (action === 'help.about') {
    aboutOpen.value = true
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
  if (action === 'file.addTrack') project.addTrack()
}
</script>

<template>
  <div class="flex h-screen flex-col bg-zinc-950 text-zinc-100">
    <AppTitleBar />

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

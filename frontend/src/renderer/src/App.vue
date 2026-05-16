<script setup lang="ts">
import { onBeforeUnmount, onMounted, watch } from 'vue'
import AppTitleBar from '@/components/AppTitleBar.vue'
import TimelineView from '@/components/TimelineView.vue'
import TransportBar from '@/components/TransportBar.vue'
import LibraryPanel from '@/components/LibraryPanel.vue'
import StatusBar from '@/components/StatusBar.vue'
import NotificationToasts from '@/components/NotificationToasts.vue'
import { useProjectStore } from '@/stores/projectStore'
import { useUiStore } from '@/stores/uiStore'
import { useLibraryStore } from '@/stores/libraryStore'
import { connect as connectBridge, disconnect as disconnectBridge } from '@/lib/bridgeService'

const project = useProjectStore()
const ui = useUiStore()
const library = useLibraryStore()

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
  unsubscribeMenu = window.silverdaw.onMenuAction(handleMenuAction)
  connectBridge()
  // Pull persisted panel sizes from the main-process preferences file so
  // the layout is correct from the very first paint. (Default values are
  // already in the store, so a slow hydrate just looks like a tiny size
  // tween rather than a jarring jump.)
  void ui.hydrate()
})

onBeforeUnmount(() => {
  unsubscribeMenu?.()
  unsubscribeMenu = null
  disconnectBridge()
  stopImportingWatcher()
  document.body.classList.remove('is-importing')
})

function handleMenuAction(action: string): void {
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

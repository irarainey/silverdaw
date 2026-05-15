<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'
import AppTitleBar from '@/components/AppTitleBar.vue'
import TimelineView from '@/components/TimelineView.vue'
import TransportBar from '@/components/TransportBar.vue'
import LibraryPanel from '@/components/LibraryPanel.vue'
import StatusBar from '@/components/StatusBar.vue'
import { useProjectStore } from '@/stores/projectStore'
import { useUiStore } from '@/stores/uiStore'
import { connect as connectBridge, disconnect as disconnectBridge } from '@/lib/bridgeService'

const project = useProjectStore()
const ui = useUiStore()

let unsubscribeMenu: (() => void) | null = null

onMounted(() => {
  unsubscribeMenu = window.jackdaw.onMenuAction(handleMenuAction)
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
  </div>
</template>

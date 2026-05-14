<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import AppTitleBar from '@/components/AppTitleBar.vue'
import TimelineView from '@/components/TimelineView.vue'
import TransportBar from '@/components/TransportBar.vue'
import LibraryPanel from '@/components/LibraryPanel.vue'
import StatusBar from '@/components/StatusBar.vue'
import { useProjectStore } from '@/stores/projectStore'
import { useTransportStore } from '@/stores/transportStore'
import { connect as connectBridge, disconnect as disconnectBridge } from '@/lib/bridgeService'

const project = useProjectStore()
const transport = useTransportStore()

// Library-panel height in px. Persisted only in-memory for now; resized
// interactively via the drag handle along the panel's top edge.
const libraryHeight = ref(180)

let unsubscribeMenu: (() => void) | null = null

onMounted(() => {
  unsubscribeMenu = window.jackdaw.onMenuAction(handleMenuAction)
  connectBridge()
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
  // The backend connection indicator used to live on the transport bar;
  // it now lives behind Help → Status. The renderer holds the live state
  // in `transportStore`, so we hand it to main for the native dialog.
  else if (action === 'help.status') window.jackdaw.showStatusDialog(transport.connected)
}
</script>

<template>
  <div class="flex h-screen flex-col bg-zinc-950 text-zinc-100">
    <AppTitleBar />

    <TransportBar />

    <main class="flex-1 overflow-hidden">
      <TimelineView />
    </main>

    <LibraryPanel v-model:height="libraryHeight" />

    <StatusBar />
  </div>
</template>

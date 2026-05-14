<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'
import AppTitleBar from '@/components/AppTitleBar.vue'
import TimelineView from '@/components/TimelineView.vue'
import TransportBar from '@/components/TransportBar.vue'
import { useProjectStore } from '@/stores/projectStore'
import { connect as connectBridge, disconnect as disconnectBridge } from '@/lib/bridgeService'

const project = useProjectStore()

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
}
</script>

<template>
  <div class="flex h-screen flex-col bg-zinc-950 text-zinc-100">
    <AppTitleBar />

    <main class="flex-1 overflow-hidden">
      <TimelineView />
    </main>

    <TransportBar />
  </div>
</template>

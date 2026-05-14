<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'
import AppTitleBar from '@/components/AppTitleBar.vue'
import TimelineView from '@/components/TimelineView.vue'
import TransportBar from '@/components/TransportBar.vue'
import { useProjectStore } from '@/stores/projectStore'
import { decodeAudioToPeaks } from '@/lib/audio'
import { connect as connectBridge, disconnect as disconnectBridge, send as sendBridge } from '@/lib/bridgeService'

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

async function handleMenuAction(action: string): Promise<void> {
  if (action === 'file.addTrack') await addTrackFromFile()
}

async function addTrackFromFile(): Promise<void> {
  const opened = await window.jackdaw.openAudioFile().catch((err) => {
    console.error('[addTrack] dialog/read failed:', err)
    return null
  })
  if (!opened) return

  try {
    const decoded = await decodeAudioToPeaks(opened.data)
    const trackId = project.addTrackFromAudio({
      filePath: opened.filePath,
      fileName: opened.fileName,
      durationMs: decoded.durationMs,
      sampleRate: decoded.sampleRate,
      channelCount: decoded.channelCount,
      peaks: decoded.peaks
    })

    // Tell the backend so it can load the same file for playback.
    sendBridge('CLIP_ADD', {
      trackId,
      filePath: opened.filePath,
      positionMs: 0
    })
  } catch (err) {
    console.error('[addTrack] decode failed:', err)
  }
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

<script setup lang="ts">
// Modal channel picker shown when "Split Stereo Channels…" is chosen on a stereo
// clip. Lets the user pick Left and/or Right; each ticked channel is exported as
// its own stereo clip (that channel copied to both L+R) on a new track — just like
// a stem. Driven by the singleton `channelSplitSelection` ref.

import { computed } from 'vue'
import {
  useChannelSplitSelection,
  toggleChannelSelection,
  confirmChannelSplit,
  cancelChannelSplit
} from '@/lib/stems/channelSplitFlow'
import type { SplitChannel } from '@/lib/stems/createChannelSplitTracks'

const selection = useChannelSplitSelection()

const CHANNEL_ROWS: ReadonlyArray<{ channel: SplitChannel; label: string }> = [
  { channel: 'left', label: 'Left channel' },
  { channel: 'right', label: 'Right channel' }
]

const visible = computed(() => selection.value !== null)
const sourceName = computed(() => selection.value?.target.sourceName ?? '')
const canStart = computed(() =>
  CHANNEL_ROWS.some((row) => selection.value?.selected[row.channel])
)

function onToggle(channel: SplitChannel): void {
  toggleChannelSelection(channel)
}

function onStart(): void {
  confirmChannelSplit()
}

function onCancel(): void {
  cancelChannelSplit()
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible"
      class="dialog-backdrop z-1200"
      role="dialog"
      aria-modal="true"
      aria-labelledby="channel-split-title"
    >
      <div
        tabindex="-1"
        class="dialog-card w-[min(420px,88vw)]"
      >
        <div class="dialog-header">
          <h1
            id="channel-split-title"
            class="dialog-title"
          >
            Split Stereo Channels
          </h1>
        </div>

        <div class="dialog-body flex flex-col gap-3">
          <p class="text-sm text-zinc-300">
            Choose which channels to split out from
            <span class="font-medium text-zinc-100">{{ sourceName }}</span>. Each lands on its own new
            track as a stereo clip carrying only that channel.
          </p>
          <ul class="flex flex-col gap-1">
            <li
              v-for="row in CHANNEL_ROWS"
              :key="row.channel"
            >
              <label
                class="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800"
              >
                <input
                  type="checkbox"
                  class="accent-sky-500"
                  :checked="selection?.selected[row.channel] ?? false"
                  @change="onToggle(row.channel)"
                >
                {{ row.label }}
              </label>
            </li>
          </ul>
        </div>

        <div class="dialog-footer">
          <button
            type="button"
            class="dialog-btn-cancel"
            @click="onCancel"
          >
            Cancel
          </button>
          <button
            type="button"
            class="dialog-btn-primary"
            :disabled="!canStart"
            @click="onStart"
          >
            Split
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

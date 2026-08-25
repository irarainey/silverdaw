<script setup lang="ts">
// Plugins surface in the bottom panel, immediately after Track FX: these inserts belong to the
// selected track, so the tab sits with the other per-track surfaces rather than beside the
// project-wide ones. Shows the selected track's VST3 inserts in chain order and lets the user
// add, reorder, bypass, open and remove them (ADR 0025).
//
// The backend owns the chain, so every control here is fire-and-forget: rows only change when
// the backend confirms them — a PROJECT_STATE broadcast for add, remove and reorder, and the
// narrower TRACK_PLUGIN_BYPASS_APPLIED ack for bypass, which avoids repainting the timeline
// mid-playback just to tick a checkbox. Plugin parameters are edited in the plugin's own
// window, which the backend opens and draws — this panel never renders plugin UI.
//
// A plugin already on the track stays in the chooser but is disabled, greyed out by
// `.app-select option:disabled`, so the user can see it is present rather than wondering
// where it went.

import { computed, onMounted, ref } from 'vue'
import { useProjectStore } from '@/stores/projectStore'

const project = useProjectStore()

const selectedIdentifier = ref('')

const selectedTrack = computed(
  () => project.tracks.find((track) => track.id === project.selectedTrackId) ?? null
)

const slots = computed(() => selectedTrack.value?.plugins ?? [])

const usedIdentifiers = computed(() => new Set(slots.value.map((slot) => slot.identifier)))

const catalogue = computed(() =>
  [...project.pluginCatalogue].sort((a, b) => a.name.localeCompare(b.name))
)

const canAdd = computed(
  () =>
    selectedTrack.value !== null &&
    selectedIdentifier.value.length > 0 &&
    !usedIdentifiers.value.has(selectedIdentifier.value)
)

onMounted(() => {
  // Cheap on the backend and always current: the catalogue is only read from memory.
  project.requestPluginList()
})

function addSelected(): void {
  const track = selectedTrack.value
  if (!track || !canAdd.value) return
  project.addTrackPlugin(track.id, selectedIdentifier.value)
  // The chosen entry is about to become unavailable, so return the chooser to its prompt
  // rather than leaving it pointing at an option the user can no longer act on.
  selectedIdentifier.value = ''
}

function move(slotId: string, delta: number): void {
  const track = selectedTrack.value
  if (!track) return
  const index = slots.value.findIndex((slot) => slot.slotId === slotId)
  const target = index + delta
  if (index < 0 || target < 0 || target >= slots.value.length) return
  project.reorderTrackPlugin(track.id, slotId, target)
}
</script>

<template>
  <section
    class="flex h-full min-h-0 w-full flex-col gap-2 px-3 py-2"
    aria-label="Plugins"
  >
    <div class="flex shrink-0 flex-wrap items-center gap-2">
      <select
        v-model="selectedIdentifier"
        class="app-select app-select-dense w-72"
        aria-label="Choose a plugin to add"
        :disabled="catalogue.length === 0"
      >
        <option value="">
          {{ catalogue.length === 0 ? 'No plugins found' : 'Choose a plugin…' }}
        </option>
        <option
          v-for="entry in catalogue"
          :key="entry.identifier"
          :value="entry.identifier"
          :disabled="usedIdentifiers.has(entry.identifier)"
        >
          {{ entry.name }}{{ entry.manufacturer ? ` — ${entry.manufacturer}` : '' }}
        </option>
      </select>
      <button
        type="button"
        class="rounded bg-sky-600 px-3 py-1 text-[11px] font-medium text-zinc-50 hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
        :disabled="!canAdd"
        @click="addSelected"
      >
        Add Plugin
      </button>
      <button
        type="button"
        class="rounded bg-zinc-800 px-3 py-1 text-[11px] font-medium text-zinc-200 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
        :disabled="project.pluginScanning"
        @click="project.scanPlugins(true)"
      >
        Scan Plugins
      </button>
      <span
        v-if="project.pluginScanStatus"
        class="text-[11px] text-zinc-400"
      >{{ project.pluginScanStatus }}</span>
    </div>

    <div
      v-if="!selectedTrack"
      class="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-xs text-zinc-500"
    >
      Select a track to add plugins to it.
    </div>

    <div
      v-else-if="slots.length === 0"
      class="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-xs text-zinc-500"
    >
      No plugins on this track yet. Choose one above and select Add Plugin.
    </div>

    <ul
      v-else
      class="min-h-0 flex-1 space-y-1 overflow-y-auto"
    >
      <li
        v-for="(slot, index) in slots"
        :key="slot.slotId"
        class="flex items-center gap-2 rounded border border-zinc-800 bg-zinc-950/40 px-2 py-1.5"
      >
        <span class="w-6 shrink-0 text-center font-mono text-[11px] tabular-nums text-zinc-500">
          {{ index + 1 }}
        </span>
        <span class="min-w-0 flex-1 truncate text-xs leading-tight">
          <span
            class="font-medium"
            :class="slot.unresolved ? 'text-amber-300' : 'text-zinc-200'"
          >{{ slot.name }}</span>
          <span
            v-if="slot.manufacturer"
            class="text-zinc-500"
          > — {{ slot.manufacturer }}</span>
          <span
            v-if="slot.unresolved"
            class="text-amber-400"
          > — not installed on this computer</span>
        </span>
        <button
          type="button"
          class="rounded bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
          :disabled="index === 0"
          aria-label="Move plugin earlier in the chain"
          @click="move(slot.slotId, -1)"
        >
          ↑
        </button>
        <button
          type="button"
          class="rounded bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
          :disabled="index === slots.length - 1"
          aria-label="Move plugin later in the chain"
          @click="move(slot.slotId, 1)"
        >
          ↓
        </button>
        <button
          type="button"
          class="rounded px-2 py-0.5 text-[11px] font-medium"
          :class="
            slot.bypassed
              ? 'border border-amber-500 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25'
              : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
          "
          :aria-pressed="slot.bypassed"
          @click="project.setTrackPluginBypassed(selectedTrack.id, slot.slotId, !slot.bypassed)"
        >
          Bypass
        </button>
        <button
          type="button"
          class="rounded bg-sky-600 px-2 py-0.5 text-[11px] font-medium text-zinc-50 hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
          :disabled="slot.unresolved"
          @click="project.openTrackPluginEditor(selectedTrack.id, slot.slotId)"
        >
          Open
        </button>
        <button
          type="button"
          class="rounded bg-red-700 px-2 py-0.5 text-[11px] font-medium text-zinc-50 hover:bg-red-600"
          @click="project.removeTrackPlugin(selectedTrack.id, slot.slotId)"
        >
          Remove
        </button>
      </li>
    </ul>
  </section>
</template>

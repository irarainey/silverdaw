<script setup lang="ts">
// Warp / tempo controls inside the Clip Editor effects rack. Pure
// presentation: the draft state lives in `useClipEditorWarpDraft` and is
// passed in via props (shared with the sibling pitch panel) so this
// component stays trivially testable.

import type { ClipEditorWarpDraft } from '@/lib/clipEditor/useClipEditorWarpDraft'
import type { ClipWarpMode } from '@shared/bridge-protocol'

const props = defineProps<{
  draft: ClipEditorWarpDraft
  sourceBpm: number | undefined
  projectBpm: number
}>()

const WARP_MODES: ClipWarpMode[] = ['rhythmic', 'tonal', 'complex']

// Alias the draft's refs into local consts so the template never reaches
// through the `draft` prop directly, keeping `vue/no-mutating-props` happy.
const draftTempoEnabled = props.draft.draftTempoEnabled
const draftMode = props.draft.draftMode
const draftPinnedBpm = props.draft.draftPinnedBpm
const draftEffectiveBpm = props.draft.draftEffectiveBpm
const draftEffectiveRatio = props.draft.draftEffectiveRatio
const tempoFollowsProject = props.draft.tempoFollowsProject
const followProjectBpm = props.draft.followProjectBpm
const pinTempo = props.draft.pinTempo
</script>

<template>
  <div class="flex w-full flex-col gap-3 text-xs">
    <label class="flex items-center gap-2 text-zinc-200">
      <input
        v-model="draftTempoEnabled"
        type="checkbox"
        class="h-3.5 w-3.5 cursor-pointer"
      >
      <span class="font-medium">Enable Warp</span>
    </label>

    <div class="rounded border border-zinc-800 bg-zinc-950/50 px-3 py-2 text-zinc-400">
      <div class="text-[10px] uppercase tracking-wider text-zinc-500">
        Playback BPM
      </div>
      <div class="font-mono text-zinc-200">
        {{ draftEffectiveBpm !== null ? draftEffectiveBpm.toFixed(2) : '—' }}
        <span class="ml-1 text-[10px] text-zinc-500">
          ({{ draftEffectiveRatio.toFixed(2) }}×)
        </span>
      </div>
    </div>

    <fieldset
      class="flex flex-col gap-1"
      :disabled="!draftTempoEnabled"
      :class="!draftTempoEnabled ? 'opacity-50' : ''"
    >
      <legend class="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">
        Mode
      </legend>
      <div class="flex gap-1">
        <button
          v-for="m in WARP_MODES"
          :key="m"
          type="button"
          class="flex-1 rounded border px-2 py-1 text-xs capitalize transition-colors"
          :class="draftMode === m
            ? 'border-sky-500 bg-sky-600/30 text-zinc-100'
            : 'border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200'
          "
          @click="draftMode = m"
        >
          {{ m }}
        </button>
      </div>
    </fieldset>

    <fieldset
      class="flex flex-col gap-1"
      :disabled="!draftTempoEnabled || !sourceBpm"
      :class="!draftTempoEnabled || !sourceBpm ? 'opacity-50' : ''"
    >
      <legend class="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">
        Playback tempo
      </legend>
      <label class="flex items-center gap-2">
        <input
          type="radio"
          :checked="tempoFollowsProject"
          @change="followProjectBpm()"
        >
        <span class="text-zinc-200">Follow project BPM</span>
        <span class="ml-auto text-[10px] text-zinc-500">
          ({{ projectBpm.toFixed(2) }})
        </span>
      </label>
      <label class="flex items-center gap-2">
        <input
          type="radio"
          :checked="!tempoFollowsProject"
          @change="pinTempo()"
        >
        <span class="text-zinc-200">Pin to</span>
        <input
          v-model.number="draftPinnedBpm"
          type="number"
          min="20"
          max="300"
          step="0.01"
          :disabled="tempoFollowsProject"
          class="w-20 rounded border border-zinc-700 bg-zinc-950 px-1.5 py-0.5 text-right font-mono text-xs text-zinc-100 focus:border-sky-500 focus:outline-none disabled:opacity-50"
        >
        <span class="text-[10px] text-zinc-500">BPM</span>
      </label>
    </fieldset>
  </div>
</template>

<script setup lang="ts">
// Vertical column of track headers sitting on top of the timeline canvas.
//
// Each header shows the track name + id, plus the three primary controls:
//
//   M  — mute       (yellow when active, sends TRACK_GAIN=0)
//   S  — solo       (cyan when active, mutes every non-soloed track)
//   X  — remove     (sends TRACK_REMOVE and drops the track locally)
//
// Layout is absolute-positioned so it stays in sync with the PixiJS-drawn
// row backgrounds. RULER_HEIGHT / TRACK_HEIGHT / TRACK_GAP must match the
// values in TimelineView.vue.

import { useProjectStore } from '@/stores/projectStore'

const project = useProjectStore()

// Keep in sync with TimelineView.vue layout constants.
const RULER_HEIGHT = 28
const TRACK_HEIGHT = 96
const TRACK_GAP = 4
const HEADER_WIDTH = 140
</script>

<template>
    <div class="absolute left-0 top-0 select-none" :style="{ width: HEADER_WIDTH + 'px' }">
        <div v-for="(track, i) in project.tracks" :key="track.id"
            class="absolute flex flex-col justify-between px-2 py-1.5 text-xs" :class="{
                'opacity-50': track.muted || (project.anySoloed && !track.soloed),
                'ring-1 ring-inset ring-cyan-500/60': track.soloed
            }" :style="{
                top: RULER_HEIGHT + i * (TRACK_HEIGHT + TRACK_GAP) + 'px',
                height: TRACK_HEIGHT + 'px',
                width: HEADER_WIDTH + 'px'
            }">
            <!-- Top row: name + close button. -->
            <div class="flex items-start justify-between gap-1">
                <div class="min-w-0 flex-1">
                    <div class="truncate font-medium text-zinc-100" :title="track.name">
                        {{ track.name }}
                    </div>
                    <div class="truncate text-[10px] uppercase tracking-wide text-zinc-500">
                        {{ track.id }}
                    </div>
                </div>
                <button type="button"
                    class="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-red-500 hover:bg-red-600 hover:text-white"
                    title="Remove track" @click="project.removeTrack(track.id)">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                        stroke-width="2.5" stroke-linecap="round" class="h-3 w-3">
                        <path d="M6 6l12 12M18 6L6 18" />
                    </svg>
                </button>
            </div>

            <!-- Bottom row: mute / solo. -->
            <div class="flex items-center gap-1">
                <button type="button"
                    class="flex h-6 w-6 items-center justify-center rounded border text-[11px] font-bold transition-colors disabled:cursor-not-allowed"
                    :class="(track.muted || (project.anySoloed && !track.soloed))
                        ? 'border-amber-400 bg-amber-500 text-zinc-950 hover:bg-amber-400'
                        : 'border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-zinc-500 hover:bg-zinc-700 hover:text-zinc-100'
                        "
                    :title="project.anySoloed && !track.soloed ? 'Muted by solo on another track' : (track.muted ? 'Unmute' : 'Mute')"
                    :disabled="project.anySoloed && !track.soloed" @click="project.toggleMute(track.id)">
                    M
                </button>
                <button type="button"
                    class="flex h-6 w-6 items-center justify-center rounded border text-[11px] font-bold transition-colors disabled:cursor-not-allowed"
                    :class="track.soloed
                        ? 'border-cyan-400 bg-cyan-500 text-zinc-950 hover:bg-cyan-400'
                        : 'border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-zinc-500 hover:bg-zinc-700 hover:text-zinc-100'
                        "
                    :title="project.anySoloed && !track.soloed ? 'Another track is soloed' : (track.soloed ? 'Un-solo' : 'Solo')"
                    :disabled="project.anySoloed && !track.soloed" @click="project.toggleSolo(track.id)">
                    S
                </button>
            </div>
        </div>
    </div>
</template>

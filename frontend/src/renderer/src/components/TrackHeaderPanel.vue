<script setup lang="ts">
// Vertical column of track headers sitting on top of the timeline canvas.
//
// Each header shows the track name + id, plus its primary controls:
//
//   M  — mute       (yellow when active, sends TRACK_GAIN=0)
//   S  — solo       (cyan when active, mutes every non-soloed track)
//   ↓  — import     (opens an audio file and adds it as a clip on the track)
//   X  — remove     (sends TRACK_REMOVE and drops the track locally)
//
// Layout is absolute-positioned so it stays in sync with the PixiJS-drawn
// row backgrounds. RULER_HEIGHT / TRACK_HEIGHT / TRACK_GAP must match the
// values in TimelineView.vue.

import { useProjectStore } from '@/stores/projectStore'
import { importAudioIntoTrack } from '@/lib/importAudio'

withDefaults(defineProps<{ scrollY?: number }>(), { scrollY: 0 })

const project = useProjectStore()

function onImportClick(trackId: string): void {
    // Fire-and-forget; failures are logged inside the helper.
    void importAudioIntoTrack(trackId)
}

// Keep in sync with TimelineView.vue layout constants.
const RULER_HEIGHT = 28
const TRACK_HEIGHT = 96
const TRACK_GAP = 4
const HEADER_WIDTH = 175
</script>

<template>
    <!--
      `inset-y-0` makes the container span the full timeline height so the
      track-row contents stay aligned with the PixiJS-drawn rows. The vertical
      divider line that visually separates the column from the waveform area
      is drawn by PixiJS (see `drawHeaderDivider` in TimelineView.vue) so the
      playhead can render *above* it \u2014 an HTML `border-r` here would always
      sit on top of the canvas and cover the playhead at t=0.
    -->
    <div class="pointer-events-none absolute inset-y-0 left-0 select-none" :style="{ width: HEADER_WIDTH + 'px' }">
        <!--
          Add-track button sits in the strip above the first track, aligned
          with the ruler row. Clicking it appends a new empty track via the
          project store (matching the File ▸ Add Track menu action).
        -->
        <button type="button"
            class="pointer-events-auto absolute left-0 right-0 top-0 flex items-center justify-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
            :style="{ height: RULER_HEIGHT + 'px' }" title="Add a new track" @click="project.addTrack()">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                stroke-width="2.5" stroke-linecap="round" class="h-3.5 w-3.5">
                <path d="M12 5v14M5 12h14" />
            </svg>
            Add Track
        </button>

        <!--
          Rows container clipped to the area below the ruler so that vertical
          scrolling of tracks doesn't reveal row headers on top of the ruler.
          The inner div applies the actual translation, matching the PixiJS
          tracks-layer scroll offset.
        -->
        <div class="absolute left-0 right-0 overflow-hidden" :style="{ top: RULER_HEIGHT + 'px', bottom: '0px' }">
            <div :style="{ transform: 'translateY(' + (-scrollY) + 'px)' }">
                <div v-for="(track, i) in project.tracks" :key="track.id"
                    class="pointer-events-auto absolute flex flex-col justify-between rounded border border-zinc-700 px-2 py-1.5 text-xs"
                    :class="{
                        'opacity-50': track.muted || (project.anySoloed && !track.soloed),
                        'ring-1 ring-inset ring-cyan-500/60': track.soloed
                    }" :style="{
                        top: (i * (TRACK_HEIGHT + TRACK_GAP)) + 'px',
                        height: TRACK_HEIGHT + 'px',
                        width: HEADER_WIDTH + 'px'
                    }">
                    <!-- Top row: name. -->
                    <div class="flex items-start gap-1">
                        <div class="min-w-0 flex-1">
                            <div class="truncate font-medium text-zinc-100" :title="track.name">
                                {{ track.name }}
                            </div>
                        </div>
                    </div>

                    <!-- Bottom row: close / import / mute / solo. -->
                    <div class="flex items-center gap-1">
                        <button type="button"
                            class="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-zinc-700 bg-zinc-800 text-zinc-400 transition-colors hover:border-red-500 hover:bg-red-600 hover:text-white"
                            title="Remove track" @click="project.removeTrack(track.id)">
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
                                stroke="currentColor" stroke-width="2.5" stroke-linecap="round" class="h-3.5 w-3.5">
                                <path d="M6 6l12 12M18 6L6 18" />
                            </svg>
                        </button>

                        <!-- Import: opens an audio file and adds it as a clip
                             on this track. Disabled once a clip already
                             exists — multi-clip editing comes later. -->
                        <button type="button"
                            class="flex h-6 w-6 items-center justify-center rounded border border-zinc-700 bg-zinc-800 text-zinc-400 transition-colors hover:border-zinc-500 hover:bg-zinc-700 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
                            :title="track.clipIds.length > 0 ? 'Track already has a clip' : 'Import audio file...'"
                            :disabled="track.clipIds.length > 0" @click="onImportClick(track.id)">
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
                                stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"
                                class="h-3.5 w-3.5">
                                <path d="M12 4v10" />
                                <path d="M8 10l4 4 4-4" />
                                <path d="M5 18h14" />
                            </svg>
                        </button>

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
        </div>
    </div>
</template>

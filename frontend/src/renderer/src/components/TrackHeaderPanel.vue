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
// values in TimelineView.vue. The column WIDTH is user-resizable and lives
// on `uiStore.trackHeaderWidth`; the drag handle is in TimelineView (it
// straddles the seam between this column and the canvas).

import { computed, nextTick, ref, type ComponentPublicInstance } from 'vue'
import { useProjectStore } from '@/stores/projectStore'
import { useUiStore } from '@/stores/uiStore'
import { importAudioIntoTrack } from '@/lib/importAudio'
import { RULER_HEIGHT, TRACK_GAP, TRACK_HEIGHT } from '@/lib/timeline/constants'

withDefaults(defineProps<{ scrollY?: number }>(), { scrollY: 0 })

const project = useProjectStore()
const ui = useUiStore()

const headerWidth = computed(() => ui.trackHeaderWidth)

function onImportClick(trackId: string): void {
  // Fire-and-forget; failures are logged inside the helper.
  void importAudioIntoTrack(trackId)
}

// ─── Inline rename ────────────────────────────────────────────────────────
// Clicking the track name swaps it for a text input. Enter / blur commits;
// Escape cancels. The input is auto-focused and pre-selects the current
// name so the user can either retype from scratch or tweak a few chars.
// Only one row can be in edit mode at a time, so a single ref is enough.

const editingTrackId = ref<string | null>(null)
const editingValue = ref('')
let nameInputEl: HTMLInputElement | null = null

function setNameInputEl(el: Element | ComponentPublicInstance | null): void {
  // Function-style template ref — avoids the Vue-3-inside-v-for array
  // behaviour, since at most one input is rendered at a time anyway.
  // Vue's VNodeRef signature passes either an Element or a
  // ComponentPublicInstance (the latter for components, not raw DOM
  // nodes); for a plain <input> we only ever get an HTMLInputElement.
  nameInputEl = el as HTMLInputElement | null
}

async function startRename(trackId: string, currentName: string): Promise<void> {
  editingTrackId.value = trackId
  editingValue.value = currentName
  await nextTick()
  if (nameInputEl) {
    nameInputEl.focus()
    nameInputEl.select()
  }
}

function commitRename(trackId: string): void {
  if (editingTrackId.value !== trackId) return
  project.setTrackName(trackId, editingValue.value)
  editingTrackId.value = null
}

function cancelRename(): void {
  editingTrackId.value = null
}

function onRenameKeydown(e: KeyboardEvent, trackId: string): void {
  if (e.key === 'Enter') {
    e.preventDefault()
    commitRename(trackId)
  } else if (e.key === 'Escape') {
    e.preventDefault()
    cancelRename()
  }
}

// Layout constants (RULER_HEIGHT / TRACK_HEIGHT / TRACK_GAP) are imported
// above from `@/lib/timeline/constants` so the column stays aligned with
// the PixiJS-drawn rows regardless of any future height tweaks.
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
  <div
    class="pointer-events-none absolute inset-y-0 left-0 select-none"
    :style="{ width: headerWidth + 'px' }"
  >
    <!--
          Add-track button sits in the strip above the first track, aligned
          with the ruler row. Clicking it appends a new empty track via the
          project store (matching the File ▸ Add Track menu action).
        -->
    <button
      type="button"
      data-borderless-button="true"
      class="pointer-events-auto absolute left-0 right-0 top-0 flex items-center justify-center gap-1.5 bg-zinc-900 text-[11px] font-medium uppercase tracking-wide text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
      :style="{ height: RULER_HEIGHT + 'px' }"
      title="Add a new track"
      @click="project.addTrack()"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.5"
        stroke-linecap="round"
        class="h-3.5 w-3.5"
      >
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
    <div
      class="absolute left-0 right-0 overflow-hidden"
      :style="{ top: RULER_HEIGHT + 'px', bottom: '0px' }"
    >
      <div :style="{ transform: 'translateY(' + (-scrollY) + 'px)' }">
        <div
          v-for="(track, i) in project.tracks"
          :key="track.id"
          class="pointer-events-auto absolute flex flex-col justify-between rounded border border-zinc-700 px-2 py-1.5 text-xs"
          :class="{
            'opacity-50': track.muted || (project.anySoloed && !track.soloed),
            'ring-1 ring-inset ring-cyan-500/60': track.soloed
          }"
          :style="{
            top: (i * (TRACK_HEIGHT + TRACK_GAP)) + 'px',
            height: TRACK_HEIGHT + 'px',
            width: headerWidth + 'px'
          }"
        >
          <!-- Top row: name. Click to rename inline; Enter / blur
                         commits, Escape cancels. Only the track header is
                         renamed — clip labels keep their own names. -->
          <div class="flex items-start gap-1">
            <div class="min-w-0 flex-1">
              <input
                v-if="editingTrackId === track.id"
                :ref="setNameInputEl"
                v-model="editingValue"
                type="text"
                spellcheck="false"
                class="w-full rounded border border-zinc-600 bg-zinc-950 px-1 py-px text-xs font-medium text-zinc-100 outline-none focus:border-cyan-500"
                @blur="commitRename(track.id)"
                @keydown="(e) => onRenameKeydown(e, track.id)"
              >
              <div
                v-else
                class="truncate font-medium text-zinc-100"
                :title="track.name + ' \u2014 click to rename'"
                @click="startRename(track.id, track.name)"
              >
                {{ track.name }}
              </div>
            </div>
          </div>

          <!-- Middle: volume slider. Controls the track's overall
                         level (linear gain 0\u20131); mute / solo still
                         override to silence. -->
          <div class="flex items-center gap-2">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              class="h-3.5 w-3.5 shrink-0 text-zinc-500"
              aria-hidden="true"
            >
              <path d="M11 5L6 9H2v6h4l5 4V5z" />
              <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
            </svg>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              :value="track.volume"
              :title="'Volume ' + Math.round(track.volume * 100) + '%'"
              class="track-volume h-1 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-zinc-700"
              @input="(e) => project.setTrackVolumeLocal(track.id, Number((e.target as HTMLInputElement).value))"
              @change="(e) => project.setTrackVolume(track.id, Number((e.target as HTMLInputElement).value))"
            >
            <span class="w-7 shrink-0 text-right font-mono text-[10px] tabular-nums text-zinc-500">
              {{ Math.round(track.volume * 100) }}
            </span>
          </div>

          <!-- Bottom row: close / import / mute / solo. -->
          <div class="flex items-center gap-1">
            <button
              type="button"
              class="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-zinc-700 bg-zinc-800 text-zinc-400 transition-colors hover:border-red-500 hover:bg-red-600 hover:text-white"
              title="Remove track"
              @click="project.removeTrack(track.id)"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2.5"
                stroke-linecap="round"
                class="h-3.5 w-3.5"
              >
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>

            <!-- Import: opens an audio file and adds it as a clip
                             on this track. Disabled once a clip already
                             exists — multi-clip editing comes later. -->
            <button
              type="button"
              class="flex h-6 w-6 items-center justify-center rounded border border-zinc-700 bg-zinc-800 text-zinc-400 transition-colors hover:border-zinc-500 hover:bg-zinc-700 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
              :title="track.clipIds.length > 0 ? 'Track already has a clip' : 'Import audio file...'"
              :disabled="track.clipIds.length > 0"
              @click="onImportClick(track.id)"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                class="h-3.5 w-3.5"
              >
                <path d="M9 18V5l12-2v13" />
                <circle
                  cx="6"
                  cy="18"
                  r="3"
                />
                <circle
                  cx="18"
                  cy="16"
                  r="3"
                />
              </svg>
            </button>

            <button
              type="button"
              class="flex h-6 w-6 items-center justify-center rounded border text-[11px] font-bold transition-colors disabled:cursor-not-allowed"
              :class="(track.muted || (project.anySoloed && !track.soloed))
                ? 'border-amber-400 bg-amber-500 text-zinc-950 hover:bg-amber-400'
                : 'border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-zinc-500 hover:bg-zinc-700 hover:text-zinc-100'
              "
              :title="project.anySoloed && !track.soloed ? 'Muted by solo on another track' : (track.muted ? 'Unmute' : 'Mute')"
              :disabled="project.anySoloed && !track.soloed"
              @click="project.toggleMute(track.id)"
            >
              M
            </button>
            <button
              type="button"
              class="flex h-6 w-6 items-center justify-center rounded border text-[11px] font-bold transition-colors disabled:cursor-not-allowed"
              :class="track.soloed
                ? 'border-cyan-400 bg-cyan-500 text-zinc-950 hover:bg-cyan-400'
                : 'border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-zinc-500 hover:bg-zinc-700 hover:text-zinc-100'
              "
              :title="project.anySoloed && !track.soloed ? 'Another track is soloed' : (track.soloed ? 'Un-solo' : 'Solo')"
              :disabled="project.anySoloed && !track.soloed"
              @click="project.toggleSolo(track.id)"
            >
              S
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Compact range slider styled to match the dark zinc chrome. The default
   browser thumb is too tall for our 1px track, so we shrink it and
   colour it to match the track palette. */
.track-volume {
  outline: none;
}

.track-volume::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 12px;
  height: 12px;
  border-radius: 9999px;
  background: #e4e4e7;
  /* zinc-200 */
  border: 1px solid #71717a;
  /* zinc-500 */
  cursor: pointer;
  margin-top: -5px;
}

.track-volume::-moz-range-thumb {
  width: 12px;
  height: 12px;
  border-radius: 9999px;
  background: #e4e4e7;
  border: 1px solid #71717a;
  cursor: pointer;
}

.track-volume::-webkit-slider-runnable-track {
  height: 3px;
  border-radius: 9999px;
  background: #3f3f46;
  /* zinc-700 */
}

.track-volume::-moz-range-track {
  height: 3px;
  border-radius: 9999px;
  background: #3f3f46;
}
</style>

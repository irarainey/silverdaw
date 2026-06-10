<script setup lang="ts">
import { ref } from 'vue'
import { useLibraryItemInfoController, type LibraryItemInfoEmit, type LibraryItemInfoProps } from '@/lib/library/useLibraryItemInfoController'

const props = defineProps<LibraryItemInfoProps>()
const emit = defineEmits<LibraryItemInfoEmit>()

const dialogEl = ref<HTMLDivElement | null>(null)

const {
  clip,
  sourceItem,
  displayTitle,
  isStem,
  stemSummary,
  typeLabel,
  coverArtUrl,
  headerArtist,
  isSample,
  classificationMode,
  setClassification,
  instanceRows,
  usages,
  displayKey,
  warpedBpm,
  bpmLabel,
  keyLabel,
  displayDecodedCachePath,
  metadataRows,
  libraryItemDisplayName,
  keyBadgeClass,
  formatDuration,
  formatPreciseDuration,
  formatTime,
  channelLabel
} = useLibraryItemInfoController(props, emit, dialogEl)
</script>

<template>
  <Transition
    enter-active-class="transition-opacity duration-150"
    enter-from-class="opacity-0"
    enter-to-class="opacity-100"
    leave-active-class="transition-opacity duration-100"
    leave-from-class="opacity-100"
    leave-to-class="opacity-0"
  >
    <div
      v-if="open && item"
      class="dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="clip-info-title"
    >
      <div
        ref="dialogEl"
        tabindex="-1"
        class="dialog-card w-[min(680px,94vw)]"
      >
        <header class="flex items-start justify-between gap-4 border-b border-zinc-800 px-6 py-4">
          <div class="min-w-0">
            <h2
              id="clip-info-title"
              class="dialog-title truncate"
            >
              {{ displayTitle }}
            </h2>
            <p
              v-if="headerArtist"
              class="mt-0.5 truncate text-xs text-zinc-400"
            >
              {{ headerArtist }}
            </p>
          </div>
        </header>

        <div class="silverdaw-scroll min-h-0 overflow-y-auto px-5 py-4 text-xs">
          <p
            v-if="isStem"
            class="mb-3 flex items-center gap-2 rounded border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-zinc-300"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="currentColor"
              class="h-4 w-4 shrink-0 text-zinc-400"
              aria-hidden="true"
            >
              <path d="M11.99 18.54l-7.37-5.73L3 14.07l9 7 9-7-1.63-1.27-7.38 5.74zM12 16l7.36-5.73L21 9l-9-7-9 7 1.63 1.27L12 16z" />
            </svg>
            <span class="min-w-0">{{ stemSummary }}</span>
          </p>
          <section class="grid gap-3 md:grid-cols-[160px_1fr]">
            <div
              class="relative flex h-36 items-center justify-center overflow-hidden rounded border border-zinc-800 bg-zinc-950"
            >
              <img
                v-if="coverArtUrl"
                :src="coverArtUrl"
                alt=""
                class="h-full w-full object-cover"
                draggable="false"
              >
              <svg
                v-else
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="currentColor"
                class="h-10 w-10 text-zinc-700"
                aria-hidden="true"
              >
                <path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6zm0 16a2 2 0 1 1 0-4 2 2 0 0 1 0 4z" />
              </svg>
              <span
                v-if="isStem"
                class="absolute bottom-1 right-1 flex items-center gap-1 rounded bg-zinc-950/85 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-100"
                title="This is a separated stem"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  class="h-3 w-3"
                  aria-hidden="true"
                >
                  <path d="M11.99 18.54l-7.37-5.73L3 14.07l9 7 9-7-1.63-1.27-7.38 5.74zM12 16l7.36-5.73L21 9l-9-7-9 7 1.63 1.27L12 16z" />
                </svg>
                Stem
              </span>
            </div>

            <dl class="grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-1.5">
              <dt class="text-zinc-500">
                Type
              </dt>
              <dd>{{ typeLabel }}</dd>
              <template v-if="clip">
                <template
                  v-for="row in instanceRows"
                  :key="row[0]"
                >
                  <dt class="text-zinc-500">
                    {{ row[0] }}
                  </dt>
                  <dd>{{ row[1] }}</dd>
                </template>
              </template>
              <dt
                v-if="sourceItem"
                class="text-zinc-500"
              >
                {{ isStem ? 'Separated from' : 'Source' }}
              </dt>
              <dd
                v-if="sourceItem"
                :class="isStem ? 'text-zinc-100' : undefined"
              >
                {{ libraryItemDisplayName(sourceItem) }}
              </dd>
              <dt
                v-if="item.derivedFrom && !isStem"
                class="text-zinc-500"
              >
                Source window
              </dt>
              <dd v-if="item.derivedFrom && !isStem">
                {{ formatTime(item.derivedFrom.inMs) }} - {{ formatTime(item.derivedFrom.inMs + item.derivedFrom.durationMs) }}
              </dd>
              <dt class="text-zinc-500">
                Duration
              </dt>
              <dd>{{ item.kind === 'saved-clip' ? formatPreciseDuration(item.durationMs) : formatDuration(item.durationMs) }}</dd>
              <dt class="text-zinc-500">
                Sample rate
              </dt>
              <dd>{{ item.sampleRate > 0 ? `${item.sampleRate.toLocaleString()} Hz` : 'Unknown' }}</dd>
              <dt class="text-zinc-500">
                Channels
              </dt>
              <dd>{{ channelLabel(item.channelCount) }}</dd>
              <template v-if="!isSample">
                <dt class="text-zinc-500">
                  {{ bpmLabel }}
                </dt>
                <dd>
                  <span v-if="warpedBpm ?? item.bpm">
                    {{ (warpedBpm ?? item.bpm)?.toFixed(2) }}
                    <span
                      v-if="!warpedBpm && item.variableTempo"
                      class="text-amber-300"
                    >(variable)</span>
                  </span>
                  <span v-else>Not analysed</span>
                </dd>
                <dt
                  v-if="displayKey"
                  class="text-zinc-500"
                >
                  {{ keyLabel }}
                </dt>
                <dd v-if="displayKey">
                  <span
                    :class="keyBadgeClass(displayKey)"
                    :title="keyLabel"
                  >
                    {{ displayKey }}
                  </span>
                </dd>
                <dt
                  v-if="item.kind !== 'saved-clip'"
                  class="text-zinc-500"
                >
                  Beat markers
                </dt>
                <dd v-if="item.kind !== 'saved-clip'">
                  {{ item.beats?.length ?? 0 }}
                </dd>
                <dt
                  v-if="item.kind !== 'saved-clip'"
                  class="text-zinc-500"
                >
                  Beat anchor
                </dt>
                <dd v-if="item.kind !== 'saved-clip'">
                  {{ item.beatAnchorSec !== undefined ? `${item.beatAnchorSec.toFixed(3)} s` : 'None' }}
                </dd>
              </template>
              <template v-else>
                <dt class="text-zinc-500">
                  Classification
                </dt>
                <dd class="text-indigo-300">
                  Sample — tempo / key / beat analysis hidden
                </dd>
              </template>
            </dl>
          </section>

          <!-- Sample / music classification (audio-file items only).
               Saved clips inherit from their source; toggling the
               source flows through to all derived saved clips.
               Full dialog width so the three options spread evenly. -->
          <section
            v-if="item.kind === 'audio-file'"
            class="mt-5"
          >
            <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">
              Treat as
            </h3>
            <div class="rounded border border-zinc-800 bg-zinc-950/40 px-3 py-2.5">
              <div class="flex gap-1">
                <button
                  type="button"
                  class="flex flex-1 items-center justify-center gap-1 rounded border px-2 py-1.5 text-xs transition-colors"
                  :class="classificationMode === 'auto'
                    ? 'border-sky-500 bg-sky-600/30 text-zinc-100'
                    : 'border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200'
                  "
                  :aria-pressed="classificationMode === 'auto'"
                  @click="setClassification('auto')"
                >
                  Auto
                  <span class="opacity-70">({{ item.lowConfidence ? 'sample' : 'music' }})</span>
                </button>
                <button
                  type="button"
                  class="flex-1 rounded border px-2 py-1.5 text-xs transition-colors"
                  :class="classificationMode === 'music'
                    ? 'border-sky-500 bg-sky-600/30 text-zinc-100'
                    : 'border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200'
                  "
                  :aria-pressed="classificationMode === 'music'"
                  @click="setClassification('music')"
                >
                  Music
                </button>
                <button
                  type="button"
                  class="flex-1 rounded border px-2 py-1.5 text-xs transition-colors"
                  :class="classificationMode === 'sample'
                    ? 'border-sky-500 bg-sky-600/30 text-zinc-100'
                    : 'border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200'
                  "
                  :aria-pressed="classificationMode === 'sample'"
                  @click="setClassification('sample')"
                >
                  Sample
                </button>
              </div>
              <p class="mt-2 truncate text-[10px] text-zinc-500">
                Samples hide tempo / key / beat markers and skip auto-warp on drop. Warp and Pitch dialogs still work manually.
              </p>
            </div>
          </section>

          <section
            v-if="!clip"
            class="mt-5"
          >
            <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">
              Used on tracks
            </h3>
            <div
              v-if="usages.length === 0"
              class="rounded border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-zinc-500"
            >
              This library clip is not currently used on any track.
            </div>
            <div
              v-else
              class="overflow-hidden rounded border border-zinc-800"
            >
              <table class="w-full text-left">
                <thead class="bg-zinc-950 text-[11px] uppercase tracking-wide text-zinc-500">
                  <tr>
                    <th class="px-3 py-2 font-medium">
                      Track
                    </th>
                    <th class="px-3 py-2 font-medium">
                      Clips
                    </th>
                    <th class="px-3 py-2 font-medium">
                      Start positions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="usage in usages"
                    :key="usage.trackId"
                    class="border-t border-zinc-800"
                  >
                    <td class="px-3 py-2 text-zinc-200">
                      {{ usage.trackName }}
                    </td>
                    <td class="px-3 py-2 tabular-nums">
                      {{ usage.clipCount }}
                    </td>
                    <td class="px-3 py-2 font-mono text-[11px] text-zinc-400">
                      {{ usage.starts.join(', ') }}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section
            v-if="item.kind === 'audio-file' || isStem"
            class="mt-5"
          >
            <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">
              Metadata{{ isStem ? ' (from original)' : '' }}
            </h3>
            <dl
              v-if="metadataRows.length > 0"
              class="grid grid-cols-[120px_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded border border-zinc-800 bg-zinc-950/40 px-3 py-2"
            >
              <template
                v-for="[label, value] in metadataRows"
                :key="label"
              >
                <dt class="text-zinc-500">
                  {{ label }}
                </dt>
                <dd class="break-words text-zinc-200">
                  {{ value }}
                </dd>
              </template>
            </dl>
            <div
              v-else
              class="rounded border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-zinc-500"
            >
              No tag metadata was found for this file.
            </div>
          </section>

          <section
            v-if="item.kind === 'audio-file'"
            class="mt-5"
          >
            <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">
              Library details
            </h3>
            <dl class="grid grid-cols-[120px_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded border border-zinc-800 bg-zinc-950/40 px-3 py-2">
              <dt class="text-zinc-500">
                Library ID
              </dt>
              <dd class="break-all font-mono text-[11px] text-zinc-300">
                {{ item.id }}
              </dd>
              <dt class="text-zinc-500">
                File name
              </dt>
              <dd class="break-all text-zinc-200">
                {{ item.fileName }}
              </dd>
              <dt class="text-zinc-500">
                Source file
              </dt>
              <dd class="break-all font-mono text-[11px] text-zinc-300">
                {{ item.filePath }}
              </dd>
              <dt class="text-zinc-500">
                Playback cache
              </dt>
              <dd class="break-all font-mono text-[11px] text-zinc-300">
                {{ displayDecodedCachePath }}
              </dd>
            </dl>
          </section>
        </div>

        <footer class="dialog-footer">
          <button
            type="button"
            class="dialog-btn-primary"
            @click="emit('close')"
          >
            Close
          </button>
        </footer>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
/*
 * Scrollbar styling now comes from the global `silverdaw-scroll`
 * utility in App.vue — the class is applied directly on the dialog
 * body. No component-scoped overrides needed here.
 */
</style>

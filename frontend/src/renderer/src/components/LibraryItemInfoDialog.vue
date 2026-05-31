<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useProjectStore, type Clip } from '@/stores/projectStore'
import { libraryItemDisplayName, libraryItemIsSample, useLibraryStore, type LibraryItem } from '@/stores/libraryStore'
import { useTransportStore } from '@/stores/transportStore'
import { keyBadgeClass } from '@/lib/keyBadge'
import { shiftedKey } from '@/lib/pitchKey'
import { effectiveTempoRatio } from '@/lib/warp'

const props = defineProps<{
  open: boolean
  item: LibraryItem | null
  clipId?: string | null
}>()

const emit = defineEmits<{ (e: 'close'): void }>()

const project = useProjectStore()
const library = useLibraryStore()
const transport = useTransportStore()
const dialogEl = ref<HTMLDivElement | null>(null)
const clip = computed(() => props.clipId ? project.clips[props.clipId] ?? null : null)
const sourceItem = computed(() => {
  const item = props.item
  if (!item?.derivedFrom?.sourceItemId) return null
  return library.byId[item.derivedFrom?.sourceItemId] ?? null
})
const displayTitle = computed(() => {
  const item = props.item
  if (!item) return ''
  if (clip.value?.name?.trim()) return clip.value.name.trim()
  return libraryItemDisplayName(item)
})
const infoSettings = computed(() => clip.value ?? props.item)

/**
 * Whether this library item is currently treated as a non-musical sample.
 * Used to (a) gate BPM/key/beats rows in the analysis section, and
 * (b) preselect the right radio in the classification control.
 */
const isSample = computed(() => {
  const item = props.item
  if (!item) return false
  return libraryItemIsSample(item, library.byId)
})

/** Current classification mode for the radio control: 'auto' when no
 *  override is set, otherwise the explicit choice. */
const classificationMode = computed<'auto' | 'sample' | 'music'>(() => {
  const item = props.item
  if (!item) return 'auto'
  return item.sampleMode ?? 'auto'
})

function setClassification(mode: 'auto' | 'sample' | 'music'): void {
  const item = props.item
  if (!item || item.kind !== 'audio-file') return
  library.setItemSampleMode(item.id, mode)
}
const instanceRows = computed(() => {
  const c = clip.value
  if (!c) return []
  const track = project.tracks.find((candidate) => candidate.id === c.trackId)
  return [
    ['Track', track?.name],
    ['Start', formatTime(c.startMs)],
    ['Source window', `${formatTime(c.inMs)} - ${formatTime(c.inMs + c.durationMs)}`],
    ['Clip duration', formatPreciseDuration(c.durationMs)]
  ].filter((row): row is [string, string] => typeof row[1] === 'string' && row[1].length > 0)
})

const usages = computed(() => {
  const item = props.item
  if (!item) return []
  // Truth lives in the project file: each timeline clip records the
  // `libraryItemId` of its parent library entry. Match on that.
  //
  // Audio-file sources additionally count timeline clips whose
  // libraryItemId references any saved-clip derived FROM this
  // source — that's a structural relationship recorded by
  // `derivedFrom.sourceItemId` on the saved-clip, not a heuristic.
  const derivedSavedClipIds =
    item.kind === 'audio-file'
      ? new Set(
          library.items
            .filter((i) => i.derivedFrom?.sourceItemId === item.id)
            .map((i) => i.id)
        )
      : null
  const rows: { trackId: string; trackName: string; clipCount: number; starts: string[] }[] = []
  for (const track of project.tracks) {
    const matching = track.clipIds
      .map((clipId) => project.clips[clipId])
      .filter((clip): clip is Clip => {
        if (!clip) return false
        if (clip.libraryItemId === item.id) return true
        if (derivedSavedClipIds?.has(clip.libraryItemId)) return true
        return false
      })
    if (matching.length === 0) continue
    rows.push({
      trackId: track.id,
      trackName: track.name,
      clipCount: matching.length,
      starts: matching.map((clip) => formatTime(clip.startMs))
    })
  }
  return rows
})

const pitchShifted = computed(() => {
  const current = infoSettings.value
  return !!current && ((current.semitones ?? 0) !== 0 || (current.cents ?? 0) !== 0)
})
const displayKey = computed(() => {
  const item = props.item
  if (!item) return undefined
  const current = infoSettings.value
  if (pitchShifted.value) {
    return shiftedKey(
      sourceItem.value?.key ?? sourceItem.value?.metadata?.key ?? item.key ?? item.metadata?.key,
      current?.semitones,
      current?.cents
    )
  }
  return item.key ?? item.metadata?.key
})
const warpedBpm = computed(() => {
  const item = props.item
  const current = infoSettings.value
  if (!item || !current || current.warpEnabled !== true) return undefined
  const sourceBpm = item.bpm ?? sourceItem.value?.bpm
  if (typeof sourceBpm !== 'number' || sourceBpm <= 0) return undefined
  // The "warped BPM" for an auto-warped clip follows the project tempo
  // (effective ratio = projectBpm / sourceBpm); for a pinned-ratio
  // clip it is sourceBpm × tempoRatio. Passing `sourceBpm` as the
  // projectBpm — which the previous code did — degenerated the ratio
  // to 1 and made the display always equal the source BPM. Use the
  // real project BPM instead.
  const ratio = effectiveTempoRatio({
    tempoRatio: current.tempoRatio,
    sourceBpm,
    projectBpm: transport.bpm
  })
  return sourceBpm * ratio
})
const bpmLabel = computed(() => warpedBpm.value ? 'Warped BPM' : 'Detected BPM')
const keyLabel = computed(() => pitchShifted.value ? 'Shifted key' : 'Detected key')
const displayDecodedCachePath = computed(() => {
  const item = props.item
  if (!item) return 'Not available yet'
  // Saved-clip items don't carry their own decoded-WAV cache —
  // they play through their source's cache. Inherit the source's
  // value so the info dialog shows the same path that's actually
  // serving audio for this clip.
  return (
    item.decodedCacheFilePath ?? sourceItem.value?.decodedCacheFilePath ?? 'Not available yet'
  )
})

const metadataRows = computed(() => {
  const item = props.item
  if (!item) return []
  const m = props.item?.metadata
  return [
    ['Title', m?.title],
    ['Artist', m?.artist],
    ['Album artist', m?.albumArtist],
    ['Album', m?.album],
    ['Year', formatNumber(m?.year)],
    ['Track', formatPartTotal(m?.trackNumber, m?.trackTotal)],
    ['Disc', formatPartTotal(m?.discNumber, m?.discTotal)],
    ['Genre', m?.genre?.join(', ')],
    ['Composer', m?.composer],
    ['BPM tag', formatNumber(m?.bpm)],
    ['Comment', m?.comment],
    ['Codec', m?.codec],
    ['Container', m?.container],
    ['Bitrate', typeof m?.bitrate === 'number' ? `${Math.round(m.bitrate / 1000)} kbps` : undefined],
    ['Encoding', typeof m?.lossless === 'boolean' ? (m.lossless ? 'Lossless' : 'Lossy') : undefined],
    ['Tag types', m?.tagTypes?.join(', ')]
  ].filter((row): row is [string, string] => typeof row[1] === 'string' && row[1].length > 0)
})

function onKeyDown(e: KeyboardEvent): void {
  if (!props.open) return
  if (e.key === 'Escape') {
    e.preventDefault()
    emit('close')
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeyDown)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeyDown)
})

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) requestAnimationFrame(() => dialogEl.value?.focus())
  }
)

function formatNumber(value: number | undefined): string | undefined {
  return typeof value === 'number' ? String(value) : undefined
}

function formatPartTotal(value: number | undefined, total: number | undefined): string | undefined {
  if (typeof value !== 'number') return undefined
  return typeof total === 'number' ? `${value} of ${total}` : String(value)
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`
}

function formatPreciseDuration(ms: number): string {
  const safe = Math.max(0, ms)
  if (safe < 1000) return `${Math.round(safe)} ms`
  if (safe < 60_000) return `${(safe / 1000).toFixed(safe < 10_000 ? 3 : 2)} s`
  return formatDuration(safe)
}

function formatTime(ms: number): string {
  return `${formatDuration(ms)}.${String(Math.floor(ms % 1000)).padStart(3, '0')}`
}

function channelLabel(count: number): string {
  if (count === 1) return 'Mono'
  if (count === 2) return 'Stereo'
  return `${count} channels`
}
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
              v-if="item.metadata?.artist"
              class="mt-0.5 truncate text-xs text-zinc-400"
            >
              {{ item.metadata.artist }}
            </p>
          </div>
        </header>

        <div class="silverdaw-scroll min-h-0 overflow-y-auto px-5 py-4 text-xs">
          <section class="grid gap-3 md:grid-cols-[160px_1fr]">
            <div
              class="flex h-36 items-center justify-center overflow-hidden rounded border border-zinc-800 bg-zinc-950"
            >
              <img
                v-if="item.coverArtUrl"
                :src="item.coverArtUrl"
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
            </div>

            <dl class="grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-1.5">
              <dt class="text-zinc-500">
                Type
              </dt>
              <dd>{{ item.kind === 'saved-clip' ? 'Saved clip' : 'Audio file' }}</dd>
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
                Source
              </dt>
              <dd v-if="sourceItem">
                {{ libraryItemDisplayName(sourceItem) }}
              </dd>
              <dt
                v-if="item.derivedFrom"
                class="text-zinc-500"
              >
                Source window
              </dt>
              <dd v-if="item.derivedFrom">
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
            v-if="item.kind === 'audio-file'"
            class="mt-5"
          >
            <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">
              Metadata
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

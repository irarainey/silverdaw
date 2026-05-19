<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useProjectStore, type Clip } from '@/stores/projectStore'
import type { LibraryItem } from '@/stores/libraryStore'

const props = defineProps<{
  open: boolean
  item: LibraryItem | null
}>()

const emit = defineEmits<{ (e: 'close'): void }>()

const project = useProjectStore()
const dialogEl = ref<HTMLDivElement | null>(null)

const usages = computed(() => {
  const item = props.item
  if (!item) return []
  const rows: { trackId: string; trackName: string; clipCount: number; starts: string[] }[] = []
  for (const track of project.tracks) {
    const matching = track.clipIds
      .map((clipId) => project.clips[clipId])
      .filter(
        (clip): clip is Clip =>
          clip?.filePath === item.filePath ||
          clip?.filePath === item.playbackFilePath ||
          clip?.playbackFilePath === item.filePath
      )
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
    ['Key', item.key ?? m?.key],
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
      class="fixed inset-0 z-[1100] flex items-center justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-labelledby="clip-info-title"
    >
      <div
        ref="dialogEl"
        tabindex="-1"
        class="flex max-h-[86vh] w-[min(680px,94vw)] flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-200 shadow-2xl outline-none"
      >
        <header class="flex items-start justify-between gap-4 border-b border-zinc-800 px-5 py-4">
          <div class="min-w-0">
            <h2
              id="clip-info-title"
              class="truncate text-base font-semibold text-zinc-100"
            >
              {{ item.metadata?.title ?? item.fileName }}
            </h2>
            <p
              v-if="item.metadata?.artist"
              class="mt-0.5 truncate text-xs text-zinc-400"
            >
              {{ item.metadata.artist }}
            </p>
          </div>
        </header>

        <div class="library-info-body min-h-0 overflow-y-auto px-5 py-4 text-xs">
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
                Library id
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
                Path
              </dt>
              <dd class="break-all font-mono text-[11px] text-zinc-300">
                {{ item.filePath }}
              </dd>
              <dt class="text-zinc-500">
                Duration
              </dt>
              <dd>{{ formatDuration(item.durationMs) }}</dd>
              <dt class="text-zinc-500">
                Sample rate
              </dt>
              <dd>{{ item.sampleRate > 0 ? `${item.sampleRate.toLocaleString()} Hz` : 'Unknown' }}</dd>
              <dt class="text-zinc-500">
                Channels
              </dt>
              <dd>{{ channelLabel(item.channelCount) }}</dd>
              <dt class="text-zinc-500">
                Detected BPM
              </dt>
              <dd>
                <span v-if="item.bpm">
                  {{ item.bpm.toFixed(2) }}
                  <span
                    v-if="item.variableTempo"
                    class="text-amber-300"
                  >(variable)</span>
                </span>
                <span v-else>Not analysed</span>
              </dd>
              <dt class="text-zinc-500">
                Beat markers
              </dt>
              <dd>{{ item.beats?.length ?? 0 }}</dd>
              <dt class="text-zinc-500">
                Beat anchor
              </dt>
              <dd>{{ item.beatAnchorSec !== undefined ? `${item.beatAnchorSec.toFixed(3)} s` : 'None' }}</dd>
              <dt class="text-zinc-500">
                Playback file
              </dt>
              <dd class="break-all font-mono text-[11px] text-zinc-300">
                {{ item.playbackFilePath }}
              </dd>
            </dl>
          </section>

          <section class="mt-5">
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

          <section class="mt-5">
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
        </div>

        <footer class="flex shrink-0 justify-end border-t border-zinc-800 bg-zinc-900/60 px-5 py-2">
          <button
            type="button"
            class="rounded bg-zinc-800 px-4 py-1 text-xs font-medium text-zinc-100 hover:bg-zinc-700 focus:ring-2 focus:ring-sky-500 focus:outline-none"
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
.library-info-body {
  scrollbar-color: rgb(113 113 122) rgb(24 24 27 / 0.8);
  scrollbar-width: thin;
}

.library-info-body::-webkit-scrollbar {
  width: 12px;
}

.library-info-body::-webkit-scrollbar-track {
  background: rgb(24 24 27 / 0.8);
}

.library-info-body::-webkit-scrollbar-thumb {
  background-color: rgb(113 113 122);
  border: 3px solid rgb(24 24 27 / 0.8);
  border-radius: 9999px;
}

.library-info-body::-webkit-scrollbar-thumb:hover {
  background-color: rgb(161 161 170);
}
</style>

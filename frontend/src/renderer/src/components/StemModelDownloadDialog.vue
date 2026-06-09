<script setup lang="ts">
// Modal dialog for the one-time stem-separation model download. Three phases off
// the singleton `stemModelFlow` ref: confirm (first use), downloading (streamed
// progress + cancel), and error. On success the flow clears itself and the
// separation starts, so this dialog only covers the model-acquisition step.

import { computed } from 'vue'
import {
  useStemModelFlow,
  confirmModelDownload,
  cancelModelFlow
} from '@/lib/stems/stemSeparationFlow'

const flow = useStemModelFlow()

const visible = computed(() => flow.value !== null)
const phase = computed(() => flow.value?.phase ?? 'confirm')
const percent = computed(() => {
  const f = flow.value
  if (!f || f.totalBytes <= 0) return 0
  return Math.min(100, Math.round((f.receivedBytes / f.totalBytes) * 100))
})

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const mb = bytes / (1024 * 1024)
  if (mb < 1024) return `${mb.toFixed(0)} MB`
  return `${(mb / 1024).toFixed(2)} GB`
}

const totalLabel = computed(() => formatBytes(flow.value?.totalBytes ?? 0))
const receivedLabel = computed(() => formatBytes(flow.value?.receivedBytes ?? 0))
const fileCount = computed(() => flow.value?.fileCount ?? 0)
const currentFileName = computed(() => flow.value?.fileName ?? '')
const errorText = computed(() => flow.value?.error ?? '')

function onConfirm(): void {
  void confirmModelDownload()
}

function onCancel(): void {
  cancelModelFlow()
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible"
      class="dialog-backdrop z-1200"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="stem-model-title"
    >
      <div
        tabindex="-1"
        class="dialog-card w-[min(460px,90vw)]"
      >
        <div class="dialog-header">
          <h1
            id="stem-model-title"
            class="dialog-title"
          >
            Stem separation model
          </h1>
        </div>

        <div class="dialog-body flex flex-col gap-3">
          <template v-if="phase === 'confirm'">
            <p class="text-sm text-zinc-300">
              Separating stems needs a one-time download of the separation model
              ({{ fileCount }} files, {{ totalLabel }}). It is stored on this
              computer and reused for every future separation.
            </p>
          </template>

          <template v-else-if="phase === 'downloading'">
            <div class="flex items-baseline justify-between gap-3">
              <span class="text-zinc-300">Downloading model…</span>
              <span class="font-mono text-xs tabular-nums text-zinc-400">{{ percent }}%</span>
            </div>
            <div
              class="h-2 w-full overflow-hidden rounded bg-zinc-800"
              role="progressbar"
              :aria-valuenow="percent"
              aria-valuemin="0"
              aria-valuemax="100"
            >
              <div
                class="h-full bg-cyan-500 transition-[width] duration-150 ease-out"
                :style="{ width: `${percent}%` }"
              />
            </div>
            <div class="flex items-baseline justify-between gap-3">
              <span
                class="truncate font-mono text-[10px] text-zinc-500"
                :title="currentFileName"
              >
                {{ currentFileName }}
              </span>
              <span class="shrink-0 font-mono text-[10px] tabular-nums text-zinc-500">
                {{ receivedLabel }} / {{ totalLabel }}
              </span>
            </div>
          </template>

          <template v-else>
            <p class="text-sm text-red-400">
              The model download failed: {{ errorText }}
            </p>
          </template>
        </div>

        <div class="dialog-footer">
          <template v-if="phase === 'confirm'">
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
              @click="onConfirm"
            >
              Download
            </button>
          </template>
          <template v-else-if="phase === 'downloading'">
            <button
              type="button"
              class="dialog-btn-cancel"
              @click="onCancel"
            >
              Cancel
            </button>
          </template>
          <template v-else>
            <button
              type="button"
              class="dialog-btn-primary"
              @click="onCancel"
            >
              Close
            </button>
          </template>
        </div>
      </div>
    </div>
  </Teleport>
</template>

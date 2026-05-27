<script setup lang="ts">
// Project properties dialog. Consolidated edit surface for the three
// top-level project fields (name, tempo, duration) that are otherwise
// scattered across the title bar (rename) and the transport bar (BPM +
// length).
//
// Transactional: changes are held in local draft refs until Save. Cancel
// (and Esc / backdrop click) discard pending edits. Save dispatches only
// the bridge envelopes for the fields that actually changed; clamping
// rules mirror the source-of-truth setters (`transport.setBpm` clamps
// to 20..300, project length cannot drop below the longest clip's
// effective end).

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useProjectStore } from '@/stores/projectStore'
import { useTransportStore } from '@/stores/transportStore'
import { useNotificationsStore } from '@/stores/notificationsStore'
import { useUiStore } from '@/stores/uiStore'
import { send as sendBridge } from '@/lib/bridgeService'
import { formatTime, parseTime } from '@/lib/musicTime'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const project = useProjectStore()
const transport = useTransportStore()
const notifications = useNotificationsStore()
const ui = useUiStore()

const dialogEl = ref<HTMLDivElement | null>(null)
const nameInputRef = ref<HTMLInputElement | null>(null)

const BPM_MIN = 20
const BPM_MAX = 300

// Draft state — reseeded from the store every time the dialog opens.
// Kept independent of the store so cancel really does cancel.
const draftName = ref('')
const draftBpm = ref(120)
const draftDurationText = ref('')

const minDurationMs = computed(() => project.longestClipEndMs)
const minDurationLabel = computed(() => formatTime(minDurationMs.value))

const parsedDurationMs = computed(() => parseTime(draftDurationText.value))

const nameError = computed(() => {
  if (draftName.value.trim().length === 0) return 'Project name cannot be empty.'
  return null
})
const bpmError = computed(() => {
  const n = draftBpm.value
  if (!Number.isFinite(n)) return 'Tempo must be a number.'
  if (n < BPM_MIN || n > BPM_MAX) return `Tempo must be between ${BPM_MIN} and ${BPM_MAX} BPM.`
  return null
})
const durationError = computed(() => {
  const ms = parsedDurationMs.value
  if (ms === null) return 'Use mm:ss or h:mm:ss.'
  if (ms < minDurationMs.value) {
    return `Duration cannot be shorter than the last clip (${minDurationLabel.value}).`
  }
  return null
})

const hasNameChange = computed(() => draftName.value.trim() !== project.projectName)
const hasBpmChange = computed(() => {
  if (bpmError.value) return false
  return Math.abs(draftBpm.value - transport.bpm) > 0.001
})
const hasDurationChange = computed(() => {
  const ms = parsedDurationMs.value
  if (ms === null) return false
  return Math.abs(ms - project.durationMs) > 0.5
})

const hasAnyChange = computed(() =>
  hasNameChange.value || hasBpmChange.value || hasDurationChange.value
)
const hasError = computed(() => !!(nameError.value || bpmError.value || durationError.value))
const canSave = computed(() => hasAnyChange.value && !hasError.value)

function initialiseDraft(): void {
  draftName.value = project.projectName
  draftBpm.value = Math.round(transport.bpm * 100) / 100
  draftDurationText.value = formatTime(project.durationMs)
}

function onSave(): void {
  if (!canSave.value) return
  const nextName = draftName.value.trim()
  const nextBpm = draftBpm.value
  const nextDurationMs = parsedDurationMs.value

  if (hasNameChange.value && nextName.length > 0) {
    project.requestRename(nextName)
  }
  if (hasBpmChange.value) {
    transport.setBpm(nextBpm)
    // `transport.setBpm` clamps internally; resend the clamped value
    // so the backend mirrors what the renderer settled on.
    sendBridge('PROJECT_SET_BPM', { bpm: transport.bpm })
  }
  if (hasDurationChange.value && nextDurationMs !== null) {
    project.setProjectLengthMs(nextDurationMs)
    sendBridge('PROJECT_SET_LENGTH', { lengthMs: project.durationMs })
  }
  notifications.pushInfo('Project properties saved.')
  emit('close')
}

function onCancel(): void {
  emit('close')
}

watch(
  () => props.open,
  async (now) => {
    // `clipEditorOpen` doubles as the suppression flag for the global
    // Spacebar (play / pause) and the menu accelerators — repurposed
    // for any modal dialog that hosts text input so typing 'p' / space
    // doesn't trigger transport actions.
    ui.clipEditorOpen = now
    if (now) {
      initialiseDraft()
      // Wait for the next tick so the input is in the DOM before we
      // try to focus + select it.
      await Promise.resolve()
      nameInputRef.value?.focus()
      nameInputRef.value?.select()
    }
  }
)

onMounted(() => {
  if (props.open) {
    ui.clipEditorOpen = true
    initialiseDraft()
  }
})

onBeforeUnmount(() => {
  if (props.open) ui.clipEditorOpen = false
})

function onKeydown(ev: KeyboardEvent): void {
  if (ev.key === 'Escape') {
    ev.preventDefault()
    onCancel()
  } else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
    ev.preventDefault()
    onSave()
  }
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
      v-if="open"
      class="fixed inset-0 z-[1100] flex items-center justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-labelledby="project-properties-title"
      @click.self="onCancel"
    >
      <div
        ref="dialogEl"
        tabindex="-1"
        class="flex w-[min(480px,92vw)] flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-200 shadow-2xl outline-none"
        @keydown="onKeydown"
      >
        <!-- Header -->
        <div class="border-b border-zinc-800 px-6 py-4">
          <h1
            id="project-properties-title"
            class="text-base font-semibold tracking-tight text-zinc-100"
          >
            Project Properties
          </h1>
        </div>

        <!-- Body -->
        <div class="flex flex-col gap-4 px-6 py-5">
          <!-- Name -->
          <label class="flex flex-col gap-1.5">
            <span class="text-xs font-medium text-zinc-300">Project name</span>
            <input
              ref="nameInputRef"
              v-model="draftName"
              type="text"
              maxlength="120"
              class="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-100 focus:border-sky-500 focus:outline-none"
              :class="nameError ? 'border-red-500' : ''"
              @keydown.enter.prevent="onSave"
            >
            <span
              v-if="nameError"
              class="text-[11px] text-red-400"
            >{{ nameError }}</span>
          </label>

          <!-- Tempo -->
          <label class="flex flex-col gap-1.5">
            <span class="text-xs font-medium text-zinc-300">Tempo (BPM)</span>
            <input
              v-model.number="draftBpm"
              type="number"
              :min="BPM_MIN"
              :max="BPM_MAX"
              step="0.01"
              class="no-spinner w-20 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-right font-mono text-sm text-zinc-100 focus:border-sky-500 focus:outline-none"
              :class="bpmError ? 'border-red-500' : ''"
              @keydown.enter.prevent="onSave"
            >
            <span
              v-if="bpmError"
              class="text-[11px] text-red-400"
            >{{ bpmError }}</span>
            <span
              v-else
              class="text-[11px] text-zinc-500"
            >Range {{ BPM_MIN }} – {{ BPM_MAX }}. Affects warp + grid layout immediately.</span>
          </label>

          <!-- Duration -->
          <label class="flex flex-col gap-1.5">
            <span class="text-xs font-medium text-zinc-300">Project duration</span>
            <input
              v-model="draftDurationText"
              type="text"
              inputmode="numeric"
              placeholder="mm:ss or h:mm:ss"
              class="w-20 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-right font-mono text-sm text-zinc-100 focus:border-sky-500 focus:outline-none"
              :class="durationError ? 'border-red-500' : ''"
              @keydown.enter.prevent="onSave"
            >
            <span
              v-if="durationError"
              class="text-[11px] text-red-400"
            >{{ durationError }}</span>
            <span
              v-else
              class="text-[11px] text-zinc-500"
            >Minimum {{ minDurationLabel }} (the end of the last clip).</span>
          </label>
        </div>

        <!-- Footer -->
        <div class="flex items-center justify-end gap-2 border-t border-zinc-800 bg-zinc-900/60 px-5 py-2">
          <button
            type="button"
            class="rounded bg-zinc-800 px-4 py-1 text-xs font-medium text-zinc-100 hover:bg-zinc-700 focus:ring-2 focus:ring-sky-500 focus:outline-none"
            @click="onCancel"
          >
            Cancel
          </button>
          <button
            type="button"
            class="rounded bg-sky-600 px-4 py-1 text-xs font-medium text-zinc-100 enabled:hover:bg-sky-500 focus:ring-2 focus:ring-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="!canSave"
            @click="onSave"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
/* Hide the WebKit / Blink number-input spinners. Vue's `v-model.number`
 * still parses the typed value, but the up/down arrows clutter the
 * narrow BPM input and the user can already nudge the value from the
 * TransportBar's dedicated BPM control. */
.no-spinner::-webkit-outer-spin-button,
.no-spinner::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}
.no-spinner {
  -moz-appearance: textfield;
  appearance: textfield;
}
</style>

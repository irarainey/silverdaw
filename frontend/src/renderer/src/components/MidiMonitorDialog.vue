<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { MidiInputDevice, MidiMessagePayload } from '@shared/bridge-protocol'

const props = defineProps<{
  open: boolean
  inputs: readonly MidiInputDevice[]
  messages: readonly MidiMessagePayload[]
  clear: () => void
}>()
const emit = defineEmits<{ (e: 'close'): void }>()
const dialogEl = ref<HTMLDivElement | null>(null)
const logEl = ref<HTMLTextAreaElement | null>(null)

const namesByIdentifier = computed(() => new Map(props.inputs.map((input) => [input.identifier, input.name])))
const monitorText = computed(() => {
  if (props.messages.length === 0) {
    return 'Waiting for MIDI messages. Enable an input in Preferences > MIDI, then operate a control.'
  }
  return [...props.messages]
    .reverse()
    .map((message) => {
      const time = new Date(message.timestampMs).toLocaleTimeString()
      const device = namesByIdentifier.value.get(message.deviceIdentifier) ?? 'MIDI input'
      return `${time}  ${device}  ${messageKind(message.statusByte)}  Code ${message.data1 ?? '—'}  Value ${message.data2 ?? '—'}`
    })
    .join('\n')
})

function messageKind(statusByte: number): string {
  const type = statusByte & 0xf0
  if (type === 0xb0) return 'Control Change'
  if (type === 0x90) return 'Note On'
  if (type === 0x80) return 'Note Off'
  if (type === 0xe0) return 'Pitch Bend'
  return 'MIDI'
}

function onKeyDown(event: KeyboardEvent): void {
  if (props.open && event.key === 'Escape') emit('close')
}

onMounted(() => window.addEventListener('keydown', onKeyDown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeyDown))
watch(() => props.open, (open) => {
  if (open) requestAnimationFrame(() => dialogEl.value?.focus())
})
watch(
  () => props.messages.length,
  () => {
    void nextTick(() => {
      if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight
    })
  }
)
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
      class="dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="midi-monitor-title"
    >
      <div
        ref="dialogEl"
        tabindex="-1"
        class="dialog-card w-[min(760px,94vw)]"
      >
        <div class="dialog-header">
          <h1
            id="midi-monitor-title"
            class="dialog-title"
          >
            MIDI Monitor
          </h1>
        </div>
        <div class="px-6 py-5 text-xs">
          <p class="mb-3 text-zinc-500">
            Shows the latest messages from enabled MIDI inputs. Control Change rows show controller code and value.
          </p>
          <textarea
            ref="logEl"
            :value="monitorText"
            readonly
            aria-label="MIDI message log"
            class="silverdaw-scroll h-80 w-full resize-none rounded border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-xs leading-relaxed text-zinc-200 outline-none focus:border-sky-500"
          />
        </div>
        <div class="dialog-footer">
          <button
            type="button"
            class="dialog-btn-cancel"
            @click="clear"
          >
            Clear
          </button>
          <button
            type="button"
            class="dialog-btn-primary"
            @click="emit('close')"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>

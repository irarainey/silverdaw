<script setup lang="ts">
// Editing the tempo of a library item (ADR 0027).
//
// This is its own dialog rather than a field inside the item's information because the
// two screens make different promises. Information is a read-only statement of what a
// file is; editing is a transaction with a Cancel and a Save. Putting a live input and
// a second commit button inside a dialog whose only footer button was Close left it
// ambiguous which control actually wrote anything, and offered no way to back out.
//
// Everything typed here means "detection read the wrong number", never "play this
// faster": the correction leaves every clip start, marker and automation point exactly
// where it is, and leaves the project tempo alone — that number is the user's, set in
// the transport. Taking it from the first clip dropped is merely a convenience, with no
// linkage and no history.

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import TempoCorrectionFields from '@/components/TempoCorrectionFields.vue'
import { useLibraryItemTempoCorrection } from '@/lib/library/useLibraryItemTempoCorrection'
import { libraryItemDisplayName } from '@/stores/libraryItemHelpers'
import type { LibraryItem } from '@/stores/libraryTypes'

const props = defineProps<{
  open: boolean
  item: LibraryItem | null
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

const bpmInputEl = ref<HTMLInputElement | null>(null)

const tempo = useLibraryItemTempoCorrection(() => (props.open ? props.item : null))

const itemName = computed(() => (props.item ? libraryItemDisplayName(props.item) : ''))

const isVariable = computed(() => props.item?.variableTempo === true)

function onKeyDown(e: KeyboardEvent): void {
  if (!props.open) return
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    emit('close')
  }
}

// Capture phase, so a dialog underneath this one cannot close itself on the same
// Escape: the topmost dialog is the one the key belongs to.
onMounted(() => window.addEventListener('keydown', onKeyDown, true))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeyDown, true))

watch(
  () => props.open,
  async (isOpen) => {
    if (!isOpen) return
    // The dialog exists to change one number, so land on it with the old value selected.
    await nextTick()
    requestAnimationFrame(() => {
      bpmInputEl.value?.focus()
      bpmInputEl.value?.select()
    })
  }
)

function onSave(): void {
  if (!tempo.canCorrect.value) return
  tempo.apply()
  emit('close')
}

function onCancel(): void {
  tempo.reset()
  emit('close')
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open && item"
      class="dialog-backdrop z-1200"
      role="dialog"
      aria-modal="true"
      aria-labelledby="edit-bpm-title"
    >
      <div
        tabindex="-1"
        class="dialog-card w-[min(460px,90vw)]"
      >
        <div class="dialog-header">
          <h1
            id="edit-bpm-title"
            class="dialog-title"
          >
            Edit BPM
          </h1>
          <p class="mt-1 truncate text-xs text-zinc-400">
            {{ itemName }}
          </p>
        </div>

        <div class="dialog-body flex flex-col gap-3">
          <p class="text-xs leading-relaxed text-zinc-400">
            Set the tempo of this file when it was detected wrongly. The beat markers
            respace themselves to the new tempo; nothing on the timeline moves.
          </p>

          <div class="flex items-center gap-2">
            <label
              for="edit-bpm-input"
              class="text-xs text-zinc-300"
            >Tempo</label>
            <input
              id="edit-bpm-input"
              ref="bpmInputEl"
              v-model="tempo.bpmInput.value"
              type="number"
              min="20"
              max="300"
              step="0.01"
              data-testid="edit-bpm-input"
              aria-label="BPM"
              class="no-spinner w-20 rounded border border-zinc-700 bg-zinc-950 px-1.5 py-0.5 text-right font-mono text-xs text-zinc-100 focus:border-sky-500 focus:outline-none"
            >
            <span class="text-[10px] text-zinc-500">BPM</span>
          </div>

          <p
            v-if="isVariable"
            class="text-[10px] text-amber-400"
          >
            Tempo varies across this file, so the number detected is a rough average.
          </p>

          <!--
            Only once the typed number is a usable correction. Before that there is
            nothing to decide about, and showing the consequences of an edit that cannot
            be applied reads as a warning about the file rather than about the change.
          -->
          <TempoCorrectionFields
            v-if="tempo.canCorrect.value"
            :original-bpm="tempo.currentBpm.value"
            :corrected-bpm="tempo.typedBpm.value"
            :owner-name="tempo.ownerName.value"
            :from-musical-length="tempo.fromMusicalLength.value"
            :show-apply="false"
          />
        </div>

        <div class="dialog-footer">
          <button
            type="button"
            class="dialog-btn-cancel"
            @click="onCancel"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="edit-bpm-save"
            class="dialog-btn-primary"
            :disabled="!tempo.canCorrect.value"
            :title="tempo.canCorrect.value ? '' : 'Type a different tempo between 20 and 300 BPM'"
            @click="onSave"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* Number fields carry their own value; the browser's spin buttons add a control the
 * rest of the app does not use. */
.no-spinner::-webkit-outer-spin-button,
.no-spinner::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}

.no-spinner {
  appearance: textfield;
  -moz-appearance: textfield;
}
</style>

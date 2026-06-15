<script setup lang="ts">
import { ref, watch } from 'vue'
import ExportFormatSettings from './ExportFormatSettings.vue'
import ExportLengthTailOptions from './ExportLengthTailOptions.vue'
import ExportLoudnessOptions from './ExportLoudnessOptions.vue'
import ExportMetadataTags from './ExportMetadataTags.vue'
import ExportOutputLocation from './ExportOutputLocation.vue'
import { useExportMixdownForm } from '@/lib/export/useExportMixdownForm'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const dialogEl = ref<HTMLDivElement | null>(null)

const {
  draftOutputPath,
  draftFormat,
  draftSampleRate,
  draftBitDepth,
  draftDither,
  draftTailSecondsText,
  draftBitrate,
  draftLoudnessPreset,
  draftCustomTargetText,
  draftCustomCeilingText,
  draftLengthMode,
  draftDurationText,
  draftMixdownStartBar,
  mixdownStartMs,
  draftTitle,
  draftArtist,
  draftAlbum,
  draftYear,
  draftGenre,
  draftComment,
  loudnessAvailable,
  customLoudnessActive,
  customTargetValid,
  customCeilingValid,
  availableBitDepths,
  ditherApplies,
  tailValid,
  effectiveProjectRate,
  lastClipEndMs,
  formIsValid,
  reseedOnOpen,
  onBrowseClick,
  onSave
} = useExportMixdownForm({ requestClose: () => emit('close') })

function onClose(): void {
  emit('close')
}

watch(
  () => props.open,
  (open) => {
    if (open) void reseedOnOpen()
  },
  { immediate: true }
)

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault()
    onClose()
    return
  }
  if (e.key === 'Enter' && (e.target as HTMLElement)?.tagName !== 'TEXTAREA') {
    if (formIsValid.value) {
      e.preventDefault()
      onSave()
    }
  }
}

function focusDialog(): void {
  dialogEl.value?.focus()
}

watch(
  () => props.open,
  (open) => {
    if (open) requestAnimationFrame(focusDialog)
  }
)
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="export-mixdown-title"
    >
      <div
        ref="dialogEl"
        tabindex="-1"
        class="dialog-card w-[min(760px,92vw)]"
        @keydown="onKeydown"
      >
        <div class="dialog-header">
          <h1
            id="export-mixdown-title"
            class="dialog-title"
          >
            Export mixdown
          </h1>
        </div>

        <div class="dialog-body silverdaw-scroll">
          <ExportOutputLocation
            v-model:output-path="draftOutputPath"
            :on-browse-click="onBrowseClick"
          />
          <ExportFormatSettings
            v-model:format="draftFormat"
            v-model:sample-rate="draftSampleRate"
            v-model:bitrate="draftBitrate"
            v-model:bit-depth="draftBitDepth"
            v-model:dither="draftDither"
            :effective-project-rate="effectiveProjectRate"
            :available-bit-depths="availableBitDepths"
            :dither-applies="ditherApplies"
          />
          <ExportLoudnessOptions
            v-model:loudness-preset="draftLoudnessPreset"
            v-model:custom-target-text="draftCustomTargetText"
            v-model:custom-ceiling-text="draftCustomCeilingText"
            :loudness-available="loudnessAvailable"
            :custom-loudness-active="customLoudnessActive"
            :custom-target-valid="customTargetValid"
            :custom-ceiling-valid="customCeilingValid"
          />
          <ExportLengthTailOptions
            v-model:length-mode="draftLengthMode"
            v-model:duration-text="draftDurationText"
            v-model:tail-seconds-text="draftTailSecondsText"
            v-model:mixdown-start-bar="draftMixdownStartBar"
            :last-clip-end-ms="lastClipEndMs"
            :tail-valid="tailValid"
            :mixdown-start-ms="mixdownStartMs"
          />
          <ExportMetadataTags
            v-model:title="draftTitle"
            v-model:artist="draftArtist"
            v-model:album="draftAlbum"
            v-model:year="draftYear"
            v-model:genre="draftGenre"
            v-model:comment="draftComment"
          />
        </div>

        <div class="dialog-footer">
          <button
            type="button"
            class="dialog-btn-cancel"
            @click="onClose"
          >
            Cancel
          </button>
          <button
            type="button"
            :disabled="!formIsValid"
            class="dialog-btn-primary"
            @click="onSave"
          >
            Export
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

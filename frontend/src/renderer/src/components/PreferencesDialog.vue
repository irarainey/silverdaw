<script setup lang="ts">
// Preferences dialog. Transactional: changes are held locally until the
// user clicks Save. Cancel (and Esc) discard pending edits.
//
// Sections:
//   - Interface  → toast notification visibility (applied immediately on Save).
//   - Paths      → default project / clip directories used by the OS
//                  open / save dialogs (applied immediately on Save).
//   - Developer  → diagnostic logs, log folder, and DevTools (next launch).

import { onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { describeBackend } from '@/lib/audio/audioOutputPicker'
import { useAudioDeviceStore } from '@/stores/audioDeviceStore'
import { usePreferencesForm } from '@/lib/preferences/usePreferencesForm'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

// Live audio-device store — the Audio tab shows the currently-active device /
// status alongside the pending selection held by the form model.
const audioDevices = useAudioDeviceStore()

// The transactional form model (working copies, change detection, load /
// persist) lives in a composable; this component is presentation + tab nav.
const {
  uniqueDevices,
  audioOutputTypeName,
  audioHasSelection,
  isAudioOutputSelectedDevice,
  pickDevice,
  pickSystemDefault,
  backendsForSelectedDevice,
  showAdvancedBackend,
  pickBackend,
  loggingEnabled,
  devToolsEnabled,
  logDirectory,
  toastsEnabled,
  followPlayback,
  showLibraryTileImages,
  matchProjectTempoOnDrop,
  skipButtonTarget,
  waveformDisplayMode,
  defaultProjectSampleRate,
  defaultProjectDir,
  defaultClipDir,
  autosaveEnabled,
  autosaveIntervalSeconds,
  initialLoggingEnabled,
  initialDevToolsEnabled,
  initialLogDirectory,
  hasChanges,
  loadCurrent,
  chooseProjectDir,
  chooseClipDir,
  chooseLogDir,
  save
} = usePreferencesForm()

const dialogEl = ref<HTMLDivElement | null>(null)

// Active settings tab. Section content swaps in the right-hand pane on each
// change; nothing about the working refs / Save logic cares which tab is
// active so unsaved edits on one tab survive a tab switch. Reset to 'general'
// whenever the dialog re-opens.
type PreferencesTab = 'general' | 'project' | 'audio' | 'developer'
const activeTab = ref<PreferencesTab>('general')

const tabs: Array<{ id: PreferencesTab; label: string }> = [
  { id: 'general', label: 'General' },
  { id: 'project', label: 'Project' },
  { id: 'audio', label: 'Audio' },
  { id: 'developer', label: 'Developer' }
]

function onKeyDown(e: KeyboardEvent): void {
  if (!props.open) return
  if (e.key === 'Escape') {
    e.preventDefault()
    onCancel()
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
  async (isOpen) => {
    if (!isOpen) return
    // Always land on the first tab when the dialog opens so the user sees the
    // same layout every time. Edits made on a previous tab are preserved in
    // the working refs until Save / Cancel.
    activeTab.value = 'general'
    // Collapse the audio-driver disclosure on each open so a previous
    // session's expanded state doesn't carry across.
    showAdvancedBackend.value = false
    await loadCurrent()
    requestAnimationFrame(() => dialogEl.value?.focus())
  }
)

function onCancel(): void {
  // Discard pending edits — `loadCurrent` will repopulate the refs the next
  // time the dialog opens.
  emit('close')
}

function onSave(): void {
  save()
  emit('close')
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
      class="dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="prefs-title"
    >
      <div
        ref="dialogEl"
        tabindex="-1"
        class="dialog-card w-[min(720px,94vw)]"
      >
        <!-- Header -->
        <div class="dialog-header">
          <h1
            id="prefs-title"
            class="dialog-title"
          >
            Preferences
          </h1>
        </div>

        <!-- Body: sidebar tab list + content pane -->
        <div class="flex max-h-[70vh] min-h-90 overflow-hidden">
          <!-- Sidebar tab list -->
          <nav
            class="flex w-40 shrink-0 flex-col gap-0.5 border-r border-zinc-800 bg-zinc-950/40 py-3 text-xs"
            role="tablist"
            aria-orientation="vertical"
          >
            <button
              v-for="tab in tabs"
              :key="tab.id"
              type="button"
              role="tab"
              :aria-selected="activeTab === tab.id"
              data-borderless-button="true"
              :class="[
                'mx-2 rounded px-3 py-1.5 text-left',
                activeTab === tab.id
                  ? 'bg-sky-600/20 text-sky-200'
                  : 'text-zinc-300 hover:bg-zinc-800'
              ]"
              @click="activeTab = tab.id"
            >
              {{ tab.label }}
            </button>
          </nav>

          <!-- Active tab content -->
          <div
            class="silverdaw-scroll flex-1 overflow-y-auto px-6 py-5 text-xs leading-relaxed"
            role="tabpanel"
          >
            <!-- General -->
            <section v-if="activeTab === 'general'">
              <label class="flex cursor-pointer items-start gap-3">
                <input
                  v-model="toastsEnabled"
                  type="checkbox"
                  class="mt-0.5 h-4 w-4 cursor-pointer accent-sky-500"
                >
                <span class="flex-1">
                  <span class="block font-medium text-zinc-200">Show toast notifications</span>
                  <span class="mt-0.5 block text-zinc-500">
                    Pop transient feedback (errors, save confirmations) in the
                    bottom-right corner. Turn off for a quieter UI; events are
                    still written to the log when debugging is enabled.
                  </span>
                </span>
              </label>
              <label class="mt-3 flex cursor-pointer items-start gap-3">
                <input
                  v-model="followPlayback"
                  type="checkbox"
                  class="mt-0.5 h-4 w-4 cursor-pointer accent-sky-500"
                >
                <span class="flex-1">
                  <span class="block font-medium text-zinc-200">Follow playback</span>
                  <span class="mt-0.5 block text-zinc-500">
                    Scroll the timeline during playback so the playhead stays
                    centred in the viewport. Turn off if you want the view to
                    stay still while playing. Can also be toggled from the
                    transport bar.
                  </span>
                </span>
              </label>
              <label class="mt-3 flex cursor-pointer items-start gap-3">
                <input
                  v-model="showLibraryTileImages"
                  type="checkbox"
                  class="mt-0.5 h-4 w-4 cursor-pointer accent-sky-500"
                >
                <span class="flex-1">
                  <span class="block font-medium text-zinc-200">Show images on library tiles</span>
                  <span class="mt-0.5 block text-zinc-500">
                    Display embedded cover art, or the fallback audio icon, on
                    each library tile. Turn off for a denser text-only library.
                  </span>
                </span>
              </label>
              <label class="mt-3 flex cursor-pointer items-start gap-3">
                <input
                  v-model="matchProjectTempoOnDrop"
                  type="checkbox"
                  class="mt-0.5 h-4 w-4 cursor-pointer accent-sky-500"
                >
                <span class="flex-1">
                  <span class="block font-medium text-zinc-200">Match project tempo on drop</span>
                  <span class="mt-0.5 block text-zinc-500">
                    When dragging a clip onto a track, automatically enable
                    warp so its source BPM matches the project BPM. Turn off
                    to drop clips at their native tempo; you can still enable
                    warp per-clip via right-click ▸ Warp.
                  </span>
                </span>
              </label>
              <div class="mt-4">
                <h2 class="mb-2 text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
                  Previous / next buttons
                </h2>
                <p class="mb-3 text-zinc-500">
                  Choose where the transport's previous and next buttons jump to.
                </p>
                <div class="space-y-2">
                  <label
                    class="flex cursor-pointer items-start gap-3 rounded border border-zinc-800 bg-zinc-950/40 px-3 py-2"
                  >
                    <input
                      v-model="skipButtonTarget"
                      type="radio"
                      name="skip-button-target"
                      value="timelineEnds"
                      class="mt-0.5 h-4 w-4 cursor-pointer accent-sky-500"
                    >
                    <span class="flex-1">
                      <span class="block font-medium text-zinc-200">Start and end of the timeline</span>
                      <span class="mt-0.5 block text-zinc-500">
                        Previous jumps to the start of the project; next jumps to
                        the end.
                      </span>
                    </span>
                  </label>
                  <label
                    class="flex cursor-pointer items-start gap-3 rounded border border-zinc-800 bg-zinc-950/40 px-3 py-2"
                  >
                    <input
                      v-model="skipButtonTarget"
                      type="radio"
                      name="skip-button-target"
                      value="markers"
                      class="mt-0.5 h-4 w-4 cursor-pointer accent-sky-500"
                    >
                    <span class="flex-1">
                      <span class="block font-medium text-zinc-200">Previous and next marker</span>
                      <span class="mt-0.5 block text-zinc-500">
                        Step through your timeline markers. Past the last marker
                        in either direction, jumps to the start or end instead.
                      </span>
                    </span>
                  </label>
                </div>
              </div>
              <div class="mt-4">
                <h2 class="mb-2 text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
                  Waveform display
                </h2>
                <p class="mb-3 text-zinc-500">
                  Choose how clip waveforms are drawn in the timeline and Clip
                  Editor. Mono clips always show a single waveform.
                </p>
                <div class="space-y-2">
                  <label
                    class="flex cursor-pointer items-start gap-3 rounded border border-zinc-800 bg-zinc-950/40 px-3 py-2"
                  >
                    <input
                      v-model="waveformDisplayMode"
                      type="radio"
                      name="waveform-display-mode"
                      value="summary"
                      class="mt-0.5 h-4 w-4 cursor-pointer accent-sky-500"
                    >
                    <span class="flex-1">
                      <span class="block font-medium text-zinc-200">Single waveform</span>
                      <span class="mt-0.5 block text-zinc-500">
                        Show one combined waveform per clip. Cleaner and easier
                        to read at a glance.
                      </span>
                    </span>
                  </label>
                  <label
                    class="flex cursor-pointer items-start gap-3 rounded border border-zinc-800 bg-zinc-950/40 px-3 py-2"
                  >
                    <input
                      v-model="waveformDisplayMode"
                      type="radio"
                      name="waveform-display-mode"
                      value="stereo"
                      class="mt-0.5 h-4 w-4 cursor-pointer accent-sky-500"
                    >
                    <span class="flex-1">
                      <span class="block font-medium text-zinc-200">Left and right channels</span>
                      <span class="mt-0.5 block text-zinc-500">
                        Stack separate left and right waveforms for stereo clips
                        so you can see differences between the channels.
                      </span>
                    </span>
                  </label>
                </div>
              </div>
            </section>

            <!-- Project -->
            <section
              v-else-if="activeTab === 'project'"
              class="space-y-6"
            >
              <div>
                <h2 class="mb-2 text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
                  Default paths
                </h2>
                <div class="space-y-3">
                  <div>
                    <div class="mb-1 font-medium text-zinc-200">
                      Project folder
                    </div>
                    <p class="mb-1.5 text-zinc-500">
                      Used by Save, Save As, and Open for every project file.
                    </p>
                    <div class="flex items-center gap-2">
                      <code
                        class="flex-1 truncate rounded border border-zinc-700 bg-zinc-950/60 px-2 py-1 text-[11px] text-zinc-300"
                        :title="defaultProjectDir"
                      >{{ defaultProjectDir || '(home)' }}</code>
                      <button
                        type="button"
                        class="shrink-0 rounded bg-zinc-700 px-3 py-1 text-[11px] font-medium text-zinc-100 hover:bg-zinc-600 focus:ring-2 focus:ring-sky-500 focus:outline-none"
                        @click="chooseProjectDir"
                      >
                        Change…
                      </button>
                    </div>
                  </div>
                  <div>
                    <div class="mb-1 font-medium text-zinc-200">
                      Clip folder
                    </div>
                    <p class="mb-1.5 text-zinc-500">
                      Starting folder for "Add Track from File" and library
                      import. The most recent folder you browsed to is reused
                      for the rest of the session.
                    </p>
                    <div class="flex items-center gap-2">
                      <code
                        class="flex-1 truncate rounded border border-zinc-700 bg-zinc-950/60 px-2 py-1 text-[11px] text-zinc-300"
                        :title="defaultClipDir"
                      >{{ defaultClipDir || '(home)' }}</code>
                      <button
                        type="button"
                        class="shrink-0 rounded bg-zinc-700 px-3 py-1 text-[11px] font-medium text-zinc-100 hover:bg-zinc-600 focus:ring-2 focus:ring-sky-500 focus:outline-none"
                        @click="chooseClipDir"
                      >
                        Change…
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              <div>
                <h2 class="mb-2 text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
                  Autosave
                </h2>
                <label class="flex cursor-pointer items-start gap-3">
                  <input
                    v-model="autosaveEnabled"
                    type="checkbox"
                    class="mt-0.5 h-4 w-4 cursor-pointer accent-sky-500"
                  >
                  <span class="flex-1">
                    <span class="block font-medium text-zinc-200">Auto-save dirty projects in the background</span>
                    <span class="mt-0.5 block text-zinc-500">
                      Periodically writes a recovery copy of any project with
                      unsaved changes into
                      <code class="text-zinc-400">%APPDATA%/Silverdaw/autosave/</code>.
                      The next launch offers to restore anything left behind
                      by a crash or unclean shutdown.
                    </span>
                  </span>
                </label>
                <div class="mt-3 flex items-center gap-2 pl-7">
                  <label
                    for="autosave-interval"
                    class="text-zinc-400"
                  >Tick interval</label>
                  <input
                    id="autosave-interval"
                    v-model.number="autosaveIntervalSeconds"
                    type="number"
                    min="5"
                    max="600"
                    step="5"
                    :disabled="!autosaveEnabled"
                    class="w-20 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-right text-zinc-200 focus:border-sky-500 focus:outline-none disabled:opacity-40"
                  >
                  <span class="text-zinc-500">seconds (5..600)</span>
                </div>
              </div>
            </section>

            <!-- Audio -->
            <section
              v-else-if="activeTab === 'audio'"
              class="space-y-4"
            >
              <div>
                <h2 class="mb-2 text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
                  Default project sample rate
                </h2>
                <p class="mb-3 text-zinc-500">
                  Applied to projects you create from now on. Existing projects keep their own stored rate. Change a project's rate from
                  <strong class="text-zinc-300">File ▸ Project Properties…</strong>.
                </p>
                <div class="space-y-2">
                  <label
                    v-for="rate in [44100, 48000]"
                    :key="rate"
                    class="flex cursor-pointer items-start gap-3 rounded border border-zinc-800 bg-zinc-950/40 px-3 py-2"
                  >
                    <input
                      v-model="defaultProjectSampleRate"
                      type="radio"
                      name="default-project-sample-rate"
                      :value="rate"
                      class="mt-0.5 h-4 w-4 cursor-pointer accent-sky-500"
                    >
                    <span class="flex-1">
                      <span class="block font-medium text-zinc-200">{{ rate.toLocaleString() }} Hz</span>
                      <span class="mt-0.5 block text-zinc-500">
                        <template v-if="rate === 44100">CD-quality default. Lower disk + CPU cost; matches most pop / streaming sources.</template>
                        <template v-else>Video / production default. Use this when working with film, video or 48 kHz multitrack stems.</template>
                      </span>
                    </span>
                  </label>
                </div>
              </div>

              <div>
                <h2 class="mb-2 text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
                  Output device
                </h2>
                <p class="mb-3 text-zinc-500">
                  Pick where Silverdaw sends audio. Most users should leave this on
                  <strong class="text-zinc-300">System default</strong> so it follows your
                  Windows audio choice. Removable devices fall back to the default when
                  unplugged and reconnect automatically next launch.
                </p>

                <div
                  v-if="!audioDevices.hydrated"
                  class="text-zinc-500"
                >
                  Loading device list…
                </div>
                <div
                  v-else
                  class="space-y-2"
                >
                  <label class="flex cursor-pointer items-start gap-3 rounded border border-zinc-800 bg-zinc-950/40 px-3 py-2">
                    <input
                      type="radio"
                      name="audio-output"
                      :checked="!audioHasSelection"
                      class="mt-0.5 h-4 w-4 cursor-pointer accent-sky-500"
                      @change="pickSystemDefault"
                    >
                    <span class="flex-1">
                      <span class="block font-medium text-zinc-200">System default</span>
                      <span class="mt-0.5 block text-zinc-500">
                        Follow whichever device Windows is currently routing audio to.
                      </span>
                    </span>
                  </label>

                  <div
                    v-if="uniqueDevices.length === 0"
                    class="rounded border border-zinc-800 bg-zinc-950/40 px-3 py-2 text-zinc-600"
                  >
                    No output devices detected.
                  </div>
                  <label
                    v-for="device in uniqueDevices"
                    :key="device.name"
                    class="flex cursor-pointer items-center gap-3 rounded border border-zinc-800 bg-zinc-950/40 px-3 py-2"
                  >
                    <input
                      type="radio"
                      name="audio-output"
                      :checked="isAudioOutputSelectedDevice(device.name)"
                      class="h-4 w-4 cursor-pointer accent-sky-500"
                      @change="pickDevice(device)"
                    >
                    <span class="truncate text-zinc-200">{{ device.name }}</span>
                  </label>
                </div>
              </div>

              <!-- Progressive disclosure: audio driver / backend picker.
                   Hidden by default so the typical user never sees the
                   Windows Audio / DirectSound / ASIO distinction unless
                   they're chasing latency or working around a buggy
                   device. Per the design plan §2's "Progressive
                   disclosure" principle. -->
              <div
                v-if="audioDevices.hydrated && audioHasSelection && backendsForSelectedDevice.length > 1"
              >
                <button
                  type="button"
                  class="flex items-center gap-1 text-[11px] font-medium text-zinc-400 hover:text-zinc-200"
                  data-borderless-button="true"
                  @click="showAdvancedBackend = !showAdvancedBackend"
                >
                  <span
                    aria-hidden="true"
                    class="inline-block w-3 text-center"
                  >{{ showAdvancedBackend ? '▾' : '▸' }}</span>
                  Audio driver ({{ audioOutputTypeName }})
                </button>
                <div
                  v-if="showAdvancedBackend"
                  class="mt-2 space-y-2 rounded border border-zinc-800 bg-zinc-950/40 p-2"
                >
                  <p class="text-zinc-500">
                    Windows offers several backends for the same physical device. Stick with
                    the recommended one unless you have a reason to change.
                  </p>
                  <label
                    v-for="backend in backendsForSelectedDevice"
                    :key="backend"
                    class="flex cursor-pointer items-start gap-3 rounded px-2 py-1.5 hover:bg-zinc-900/60"
                  >
                    <input
                      type="radio"
                      name="audio-backend"
                      :checked="audioOutputTypeName === backend"
                      class="mt-0.5 h-4 w-4 cursor-pointer accent-sky-500"
                      @change="pickBackend(backend)"
                    >
                    <span class="flex-1">
                      <span class="block font-medium text-zinc-200">{{ backend }}</span>
                      <span class="mt-0.5 block text-zinc-500">
                        {{ describeBackend(backend) }}
                      </span>
                    </span>
                  </label>
                </div>
              </div>

              <div
                v-if="audioDevices.hydrated"
                class="flex items-center justify-between text-zinc-500"
              >
                <span v-if="audioDevices.currentSampleRate">
                  Current: {{ Math.round(audioDevices.currentSampleRate) }} Hz<template
                    v-if="audioDevices.currentBufferSize"
                  > / {{ audioDevices.currentBufferSize }}-sample buffer</template><template
                    v-if="audioDevices.outputLatencyMs !== null && audioDevices.outputLatencyMs >= 30"
                  > · ~{{ Math.round(audioDevices.outputLatencyMs) }} ms latency<template
                    v-if="audioDevices.isBluetoothHeuristic"
                  > (Bluetooth — playhead auto-compensates)</template></template>
                </span>
                <button
                  type="button"
                  class="rounded bg-zinc-800 px-3 py-1 text-[11px] font-medium text-zinc-100 hover:bg-zinc-700 focus:ring-2 focus:ring-sky-500 focus:outline-none"
                  @click="audioDevices.requestRescan"
                >
                  Rescan devices
                </button>
              </div>

              <p
                v-if="audioDevices.lastError"
                class="rounded border border-amber-700 bg-amber-900/30 px-3 py-2 text-amber-200"
              >
                {{ audioDevices.lastError }}
              </p>
            </section>

            <!-- Developer -->
            <section
              v-else-if="activeTab === 'developer'"
              class="space-y-4"
            >
              <label class="flex cursor-pointer items-start gap-3">
                <input
                  v-model="loggingEnabled"
                  type="checkbox"
                  class="mt-0.5 h-4 w-4 cursor-pointer accent-sky-500"
                >
                <span class="flex-1">
                  <span class="block font-medium text-zinc-200">Write diagnostic logs</span>
                  <span class="mt-0.5 block text-zinc-500">
                    Writes main, renderer, and backend logs for each session.
                    Takes effect the next time Silverdaw is launched.
                  </span>
                </span>
              </label>

              <div class="space-y-1">
                <label class="block text-xs font-medium text-zinc-300">Log folder</label>
                <div class="flex gap-2">
                  <input
                    v-model="logDirectory"
                    type="text"
                    spellcheck="false"
                    :disabled="!loggingEnabled"
                    placeholder="Application debug folder"
                    class="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-100 outline-none focus:border-sky-500 disabled:cursor-not-allowed disabled:text-zinc-500"
                  >
                  <button
                    type="button"
                    :disabled="!loggingEnabled"
                    class="rounded bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-100 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
                    @click="chooseLogDir"
                  >
                    Browse…
                  </button>
                </div>
                <p class="text-[11px] text-zinc-500">
                  Silverdaw creates a timestamped subfolder here for each
                  session. By default this is the debug folder beside the app.
                </p>
              </div>

              <label class="flex cursor-pointer items-start gap-3">
                <input
                  v-model="devToolsEnabled"
                  type="checkbox"
                  class="mt-0.5 h-4 w-4 cursor-pointer accent-sky-500"
                >
                <span class="flex-1">
                  <span class="block font-medium text-zinc-200">Show Developer Tools</span>
                  <span class="mt-0.5 block text-zinc-500">
                    Shows the Debug menu and allows DevTools shortcuts in
                    packaged builds. Enable only when diagnosing the app.
                  </span>
                </span>
              </label>

              <p
                v-if="loggingEnabled !== initialLoggingEnabled || devToolsEnabled !== initialDevToolsEnabled || logDirectory !== initialLogDirectory"
                class="rounded border border-amber-700 bg-amber-900/30 px-3 py-2 text-amber-200"
              >
                Restart Silverdaw to apply changes.
              </p>
            </section>
          </div>
        </div>

        <!-- Footer -->
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
            class="dialog-btn-primary"
            :disabled="!hasChanges"
            @click="onSave"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>

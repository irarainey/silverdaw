<script setup lang="ts">
// Preferences dialog. Transactional: changes are held locally until the
// user clicks Save. Cancel (and Esc) discard pending edits.
//
// Sections:
//   - Interface  → toast notification visibility (applied immediately on Save).
//   - Paths      → default project / clip directories used by the OS
//                  open / save dialogs (applied immediately on Save).
//   - Developer  → diagnostic logs, log folder, and DevTools (next launch).

import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { useAppStore } from '@/stores/appStore'
import { useUiStore } from '@/stores/uiStore'
import { useAudioDeviceStore } from '@/stores/audioDeviceStore'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const appStore = useAppStore()
const ui = useUiStore()
const audioDevices = useAudioDeviceStore()

/**
 * Plain-English description for every audio backend JUCE may report
 * on Windows. Used by the advanced-backend picker; the primary
 * "pick a device" surface keeps the backend invisible.
 */
const AUDIO_BACKEND_DESCRIPTIONS: Record<string, string> = {
  'Windows Audio':
    'Recommended. Modern Windows audio path; reliable latency and shares the device with other apps.',
  'Windows Audio (Exclusive Mode)':
    'Lower latency, but takes the device exclusively — other apps fall silent while Silverdaw runs.',
  DirectSound:
    'Legacy backend. Use only if a device misbehaves with Windows Audio.',
  ASIO:
    'Lowest latency, but requires a vendor-supplied ASIO driver. Pick this for pro-audio interfaces.',
  CoreAudio: 'macOS standard audio backend.',
  ALSA: 'Linux standard audio backend.',
  JACK: 'Pro-audio routing on Linux / macOS.'
}

/** Preference order when auto-picking a backend for a freshly-clicked
 *  device. We default to the most-reliable user-friendly backend
 *  rather than the lowest-latency one — advanced users who want ASIO
 *  expand the "Audio driver" disclosure below the device list. */
const BACKEND_PREFERENCE: string[] = [
  'Windows Audio',
  'CoreAudio',
  'ALSA',
  'DirectSound',
  'Windows Audio (Exclusive Mode)',
  'JACK',
  'ASIO'
]

function describeBackend(typeName: string): string {
  return AUDIO_BACKEND_DESCRIPTIONS[typeName] ?? 'Audio backend.'
}

/** A single physical device aggregated across every backend that
 *  exposes it. Two backends are considered the "same device" when
 *  their device names match case-insensitively — which holds for
 *  Windows Audio vs DirectSound (both describe the underlying
 *  MMDevice) and gives ASIO devices their own row since vendor
 *  ASIO drivers usually report distinct names. */
interface UniqueDevice {
  /** Canonical (display) name — the first capitalisation we saw. */
  name: string
  /** Backend type names that offer this device. */
  backends: string[]
}

const uniqueDevices = computed<UniqueDevice[]>(() => {
  const map = new Map<string, UniqueDevice>()
  for (const type of audioDevices.types) {
    for (const dev of type.devices) {
      const key = dev.toLowerCase()
      const existing = map.get(key)
      if (existing) {
        if (!existing.backends.includes(type.name)) existing.backends.push(type.name)
      } else {
        map.set(key, { name: dev, backends: [type.name] })
      }
    }
  }
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name))
})

/** Pending audio-output selection — edited freely by the radio
 *  buttons; persisted (and applied to the engine) only when the
 *  user clicks Save. `null/null` means "use system default". */
const audioOutputTypeName = ref<string | null>(null)
const audioOutputDeviceName = ref<string | null>(null)
const initialAudioOutputTypeName = ref<string | null>(null)
const initialAudioOutputDeviceName = ref<string | null>(null)

const audioHasSelection = computed(
  () => !!audioOutputTypeName.value && !!audioOutputDeviceName.value
)

function isAudioOutputSelectedDevice(deviceName: string): boolean {
  return audioOutputDeviceName.value?.toLowerCase() === deviceName.toLowerCase()
}

/** Pick the most-preferred backend that offers `device`. Used when
 *  the user clicks a device row — they don't have to think about
 *  drivers at all. */
function preferredBackendFor(device: UniqueDevice): string {
  for (const b of BACKEND_PREFERENCE) {
    if (device.backends.includes(b)) return b
  }
  return device.backends[0] ?? ''
}

/** Selecting a device row picks its preferred backend automatically.
 *  If the user already picked this device but with a different
 *  backend (via the advanced disclosure), keep their backend choice
 *  — we only auto-pick when switching to a different device. */
function pickDevice(device: UniqueDevice): void {
  if (audioOutputDeviceName.value?.toLowerCase() === device.name.toLowerCase()) return
  audioOutputDeviceName.value = device.name
  audioOutputTypeName.value = preferredBackendFor(device)
}

function pickSystemDefault(): void {
  audioOutputDeviceName.value = null
  audioOutputTypeName.value = null
}

/** Backends available for the currently-selected device — drives the
 *  advanced disclosure. Empty when the user is on System default. */
const backendsForSelectedDevice = computed<string[]>(() => {
  const name = audioOutputDeviceName.value
  if (!name) return []
  const dev = uniqueDevices.value.find((d) => d.name.toLowerCase() === name.toLowerCase())
  return dev ? dev.backends.slice().sort((a, b) => {
    const ai = BACKEND_PREFERENCE.indexOf(a)
    const bi = BACKEND_PREFERENCE.indexOf(b)
    return (ai < 0 ? Number.MAX_SAFE_INTEGER : ai) - (bi < 0 ? Number.MAX_SAFE_INTEGER : bi)
  }) : []
})

/** Toggle controlling visibility of the audio-driver picker. Hidden
 *  by default so the typical user sees a simple list of devices and
 *  isn't bothered by Windows Audio / DirectSound / ASIO duplicates. */
const showAdvancedBackend = ref(false)

function pickBackend(typeName: string): void {
  audioOutputTypeName.value = typeName
}

const dialogEl = ref<HTMLDivElement | null>(null)

/** Active settings tab. Section content swaps in the right-hand pane
 *  on each change; nothing about the working refs / Save logic cares
 *  which tab is active so unsaved edits on one tab survive a tab
 *  switch. Reset to `'general'` whenever the dialog re-opens. */
type PreferencesTab = 'general' | 'project' | 'audio' | 'developer'
const activeTab = ref<PreferencesTab>('general')

const tabs: Array<{ id: PreferencesTab; label: string }> = [
  { id: 'general', label: 'General' },
  { id: 'project', label: 'Project' },
  { id: 'audio', label: 'Audio' },
  { id: 'developer', label: 'Developer' }
]

// Working copies — edited freely; not persisted until Save.
const loggingEnabled = ref(false)
const devToolsEnabled = ref(false)
const logDirectory = ref('')
const toastsEnabled = ref(true)
const followPlayback = ref(true)
const showLibraryTileImages = ref(true)
const matchProjectTempoOnDrop = ref(true)
const defaultProjectDir = ref('')
const defaultClipDir = ref('')
const autosaveEnabled = ref(true)
const autosaveIntervalSeconds = ref(30)

// Snapshot of the values when the dialog opened, used to:
//   1. Detect whether anything actually changed (Save no-ops if not).
//   2. Show the "Restart required" notice when debug differs.
const initialLoggingEnabled = ref(false)
const initialDevToolsEnabled = ref(false)
const initialLogDirectory = ref('')
const initialToasts = ref(true)
const initialFollow = ref(true)
const initialShowLibraryTileImages = ref(true)
const initialMatchProjectTempoOnDrop = ref(true)
const initialProjectDir = ref('')
const initialClipDir = ref('')
const initialAutosaveEnabled = ref(true)
const initialAutosaveSeconds = ref(30)

const hasChanges = computed(
  () =>
    loggingEnabled.value !== initialLoggingEnabled.value ||
    devToolsEnabled.value !== initialDevToolsEnabled.value ||
    logDirectory.value !== initialLogDirectory.value ||
    toastsEnabled.value !== initialToasts.value ||
    followPlayback.value !== initialFollow.value ||
    showLibraryTileImages.value !== initialShowLibraryTileImages.value ||
    matchProjectTempoOnDrop.value !== initialMatchProjectTempoOnDrop.value ||
    defaultProjectDir.value !== initialProjectDir.value ||
    defaultClipDir.value !== initialClipDir.value ||
    autosaveEnabled.value !== initialAutosaveEnabled.value ||
    autosaveIntervalSeconds.value !== initialAutosaveSeconds.value ||
    audioOutputTypeName.value !== initialAudioOutputTypeName.value ||
    audioOutputDeviceName.value !== initialAudioOutputDeviceName.value
)

async function loadCurrent(): Promise<void> {
  try {
    const [debugVal, qol, autosave, audioPref] = await Promise.all([
      window.silverdaw.getDebugPreferences(),
      window.silverdaw.getQolPrefs(),
      window.silverdaw.getAutosaveConfig(),
      window.silverdaw.getAudioOutput()
    ])
    loggingEnabled.value = debugVal.loggingEnabled
    devToolsEnabled.value = debugVal.devToolsEnabled
    logDirectory.value = debugVal.logDirectory
    toastsEnabled.value = qol.toasts.enabled
    defaultProjectDir.value = qol.paths.defaultProjectDir
    defaultClipDir.value = qol.paths.defaultClipDir
    autosaveEnabled.value = autosave.enabled
    autosaveIntervalSeconds.value = autosave.intervalSeconds
    // Audio: seed from the *saved preference*, not the live device.
    // A fresh install with no explicit pick has both fields null,
    // which the radio group renders as "System default" — even
    // though the engine is technically driving a concrete device
    // it chose itself. The user's actual choice is what's persisted,
    // not what JUCE happened to open.
    audioOutputTypeName.value = audioPref.typeName
    audioOutputDeviceName.value = audioPref.deviceName
  } catch {
    loggingEnabled.value = false
    devToolsEnabled.value = false
    logDirectory.value = ''
    toastsEnabled.value = true
    defaultProjectDir.value = ''
    defaultClipDir.value = ''
    autosaveEnabled.value = true
    autosaveIntervalSeconds.value = 30
    audioOutputTypeName.value = null
    audioOutputDeviceName.value = null
  }
  // `followPlayback` lives in the UI prefs sub-tree (alongside panel
  // sizes) and is mirrored into the uiStore on startup — read it from
  // there directly so we don't need a second IPC round-trip.
  followPlayback.value = ui.followPlayback
  showLibraryTileImages.value = ui.showLibraryTileImages
  matchProjectTempoOnDrop.value = ui.matchProjectTempoOnDrop
  initialLoggingEnabled.value = loggingEnabled.value
  initialDevToolsEnabled.value = devToolsEnabled.value
  initialLogDirectory.value = logDirectory.value
  initialToasts.value = toastsEnabled.value
  initialFollow.value = followPlayback.value
  initialShowLibraryTileImages.value = showLibraryTileImages.value
  initialMatchProjectTempoOnDrop.value = matchProjectTempoOnDrop.value
  initialProjectDir.value = defaultProjectDir.value
  initialClipDir.value = defaultClipDir.value
  initialAutosaveEnabled.value = autosaveEnabled.value
  initialAutosaveSeconds.value = autosaveIntervalSeconds.value
  initialAudioOutputTypeName.value = audioOutputTypeName.value
  initialAudioOutputDeviceName.value = audioOutputDeviceName.value
}

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
    // Always land on the first tab when the dialog opens so the user
    // sees the same layout every time. Edits made on a previous tab
    // are preserved in the working refs until Save / Cancel.
    activeTab.value = 'general'
    // Collapse the audio-driver disclosure on each open so a previous
    // session's expanded state doesn't carry across — keeps the
    // Audio tab visually clean for users who don't normally need it.
    showAdvancedBackend.value = false
    await loadCurrent()
    requestAnimationFrame(() => dialogEl.value?.focus())
  }
)

async function chooseProjectDir(): Promise<void> {
  const picked = await window.silverdaw.chooseDirectory({
    title: 'Default project folder',
    defaultPath: defaultProjectDir.value || undefined
  })
  if (picked) defaultProjectDir.value = picked
}

async function chooseClipDir(): Promise<void> {
  const picked = await window.silverdaw.chooseDirectory({
    title: 'Default clip folder',
    defaultPath: defaultClipDir.value || undefined
  })
  if (picked) defaultClipDir.value = picked
}

async function chooseLogDir(): Promise<void> {
  const picked = await window.silverdaw.chooseDirectory({
    title: 'Diagnostic log folder',
    defaultPath: logDirectory.value || defaultProjectDir.value || undefined
  })
  if (picked) logDirectory.value = picked
}

function onCancel(): void {
  // Discard pending edits — `loadCurrent` will repopulate the refs the
  // next time the dialog opens.
  emit('close')
}

function onSave(): void {
  // Only push the deltas main needs to know about. The toast toggle is
  // also mirrored into the appStore so the change is visible to
  // `notificationsStore.push` without a re-hydrate.
  const qolPatch: {
    toasts?: { enabled: boolean }
    paths?: { defaultProjectDir?: string; defaultClipDir?: string }
  } = {}
  if (toastsEnabled.value !== initialToasts.value) {
    qolPatch.toasts = { enabled: toastsEnabled.value }
    appStore.setToastsEnabled(toastsEnabled.value)
  }
  const pathsPatch: { defaultProjectDir?: string; defaultClipDir?: string } = {}
  if (defaultProjectDir.value !== initialProjectDir.value && defaultProjectDir.value.length > 0) {
    pathsPatch.defaultProjectDir = defaultProjectDir.value
  }
  if (defaultClipDir.value !== initialClipDir.value && defaultClipDir.value.length > 0) {
    pathsPatch.defaultClipDir = defaultClipDir.value
  }
  if (Object.keys(pathsPatch).length > 0) {
    qolPatch.paths = pathsPatch
  }
  if (Object.keys(qolPatch).length > 0) {
    window.silverdaw.setQolPrefs(qolPatch)
  }
  if (
    loggingEnabled.value !== initialLoggingEnabled.value ||
    devToolsEnabled.value !== initialDevToolsEnabled.value ||
    logDirectory.value !== initialLogDirectory.value
  ) {
    window.silverdaw.setDebugPreferences({
      loggingEnabled: loggingEnabled.value,
      devToolsEnabled: devToolsEnabled.value,
      logDirectory: logDirectory.value.trim()
    })
  }
  if (followPlayback.value !== initialFollow.value) {
    // Goes through the uiStore so the transport-bar toggle stays in
    // sync and the new value is persisted via the usual UI prefs path.
    ui.setFollowPlayback(followPlayback.value)
  }
  if (showLibraryTileImages.value !== initialShowLibraryTileImages.value) {
    ui.setShowLibraryTileImages(showLibraryTileImages.value)
  }
  if (matchProjectTempoOnDrop.value !== initialMatchProjectTempoOnDrop.value) {
    ui.setMatchProjectTempoOnDrop(matchProjectTempoOnDrop.value)
  }
  // Autosave config is also mirrored in appStore so the autosave
  // manager's reactive watcher picks up the change without waiting
  // for a re-hydrate.
  if (
    autosaveEnabled.value !== initialAutosaveEnabled.value ||
    autosaveIntervalSeconds.value !== initialAutosaveSeconds.value
  ) {
    const next = {
      enabled: autosaveEnabled.value,
      intervalSeconds: Math.max(5, Math.min(600, Math.round(autosaveIntervalSeconds.value)))
    }
    window.silverdaw.setAutosaveConfig(next)
    appStore.setAutosaveConfig(next)
  }
  // Audio output device: routes through the same
  // `audioDeviceStore.selectDevice` path the transport-bar
  // quick-switch uses. The store optimistic-updates locally, sends
  // `AUDIO_DEVICE_SELECT` over the bridge, and persists via main IPC
  // only after the backend acks `ok: true` — so an unreachable
  // device picked here is never written to disk.
  if (
    audioOutputTypeName.value !== initialAudioOutputTypeName.value ||
    audioOutputDeviceName.value !== initialAudioOutputDeviceName.value
  ) {
    audioDevices.selectDevice(audioOutputTypeName.value, audioOutputDeviceName.value)
  }
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
      class="fixed inset-0 z-[1100] flex items-center justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-labelledby="prefs-title"
    >
      <div
        ref="dialogEl"
        tabindex="-1"
        class="flex w-[min(720px,94vw)] flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-200 shadow-2xl outline-none"
      >
        <!-- Header -->
        <div class="border-b border-zinc-800 px-6 py-4">
          <h1
            id="prefs-title"
            class="text-base font-semibold tracking-tight text-zinc-100"
          >
            Preferences
          </h1>
        </div>

        <!-- Body: sidebar tab list + content pane -->
        <div class="flex max-h-[70vh] min-h-[360px] overflow-hidden">
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
        <div class="flex justify-end gap-2 border-t border-zinc-800 bg-zinc-900/60 px-5 py-2">
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

<script setup lang="ts">
import { DEFAULT_MIDI_DEVICE_PREFERENCES } from '@shared/types'
import type {
  MidiCrossfaderDirection,
  MidiDefaultDeck,
  MidiDevicePreferences
} from '@shared/types'

const props = defineProps<{
  inputs: ReadonlyArray<{
    name: string
    identifier: string
    connected: boolean
    enabled: boolean
    manufacturer?: string | null
    controllerProfile: string | null
  }>
  /** True once the first device list has arrived from the backend. */
  hydrated: boolean
  /** True while a user-initiated device rescan is pending. */
  rescanning: boolean
  /** Ask the backend to enumerate MIDI input devices again. */
  requestRescan: () => void
  enabledByIdentifier: Record<string, boolean>
  setInputEnabled: (identifier: string, enabled: boolean) => void
  devicePreferencesByIdentifier: Record<string, MidiDevicePreferences>
  setScrubAudio: (identifier: string, enabled: boolean) => void
  setCrossfaderDirection: (
    identifier: string,
    direction: MidiCrossfaderDirection
  ) => void
  setDefaultDeck: (identifier: string, defaultDeck: MidiDefaultDeck) => void
}>()

function onEnabledChange(identifier: string, event: Event): void {
  props.setInputEnabled(identifier, (event.target as HTMLInputElement).checked)
}

function scrubAudioEnabled(identifier: string): boolean {
  return (
    props.devicePreferencesByIdentifier[identifier]?.scrubAudioEnabled ??
    DEFAULT_MIDI_DEVICE_PREFERENCES.scrubAudioEnabled
  )
}

function crossfaderDirection(identifier: string): MidiCrossfaderDirection {
  return (
    props.devicePreferencesByIdentifier[identifier]?.crossfaderDirection ??
    DEFAULT_MIDI_DEVICE_PREFERENCES.crossfaderDirection
  )
}

function defaultDeck(identifier: string): MidiDefaultDeck {
  return (
    props.devicePreferencesByIdentifier[identifier]?.defaultDeck ??
    DEFAULT_MIDI_DEVICE_PREFERENCES.defaultDeck
  )
}

function onScrubAudioChange(identifier: string, event: Event): void {
  props.setScrubAudio(identifier, (event.target as HTMLInputElement).checked)
}
</script>

<template>
  <section class="space-y-4">
    <div>
      <h2 class="mb-2 text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
        MIDI input devices
      </h2>
      <p class="mb-3 text-zinc-500">
        Enable supported controllers for Silverdaw. Other MIDI devices remain
        visible but cannot be enabled yet.
      </p>

      <div
        v-if="!hydrated"
        class="flex items-center gap-2 text-zinc-500"
      >
        <svg
          class="h-3 w-3 animate-spin"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
        >
          <circle
            class="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            stroke-width="4"
          />
          <path
            class="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 0 1 8-8V0C5.373 0 0 5.373 0 12h4z"
          />
        </svg>
        Scanning MIDI inputs…
      </div>
      <div
        v-else
        class="space-y-2"
      >
        <div
          v-if="inputs.length === 0"
          class="rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2.5 text-zinc-600"
        >
          No MIDI input devices detected.
        </div>
        <div
          v-for="input in inputs"
          v-else
          :key="input.identifier"
          class="rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2.5"
        >
          <div class="flex items-center gap-3">
            <label
              class="flex min-w-0 flex-1 items-center gap-3"
              :class="input.controllerProfile ? 'cursor-pointer' : 'cursor-not-allowed'"
            >
              <input
                type="checkbox"
                :checked="
                  input.controllerProfile !== null &&
                    enabledByIdentifier[input.identifier] === true
                "
                :disabled="input.controllerProfile === null"
                class="h-4 w-4 shrink-0 cursor-pointer accent-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
                @change="onEnabledChange(input.identifier, $event)"
              >
              <span class="min-w-0 flex-1 leading-tight">
                <span class="block truncate font-medium text-zinc-200">
                  {{ input.name }}
                  <span
                    v-if="input.manufacturer"
                    class="ml-1.5 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-normal text-zinc-400"
                  >
                    {{ input.manufacturer }}
                  </span>
                  <span
                    v-if="input.controllerProfile"
                    class="ml-1.5 text-[10px] font-normal text-sky-400"
                  >
                    {{ input.controllerProfile }} controls
                  </span>
                  <span
                    v-else
                    class="ml-1.5 text-[10px] font-normal text-zinc-500"
                  >
                    Not supported yet
                  </span>
                </span>
              </span>
            </label>
            <span class="shrink-0 text-right text-[11px] text-zinc-500">
              <span class="flex items-center justify-end gap-1.5">
                <span
                  :class="input.connected ? 'bg-emerald-500' : 'bg-zinc-600'"
                  class="h-1.5 w-1.5 rounded-full"
                />
                {{ input.connected ? 'Connected' : 'Disconnected' }}
              </span>
            </span>
          </div>

          <div
            v-if="input.controllerProfile"
            class="mt-2 space-y-2 border-t border-zinc-800 pt-2 pl-7"
          >
            <label class="flex cursor-pointer items-center gap-2 text-[11px] text-zinc-300">
              <input
                type="checkbox"
                :checked="scrubAudioEnabled(input.identifier)"
                class="h-3.5 w-3.5 shrink-0 cursor-pointer accent-sky-500"
                @change="onScrubAudioChange(input.identifier, $event)"
              >
              Play audio while moving the main timeline
            </label>

            <fieldset class="flex items-center gap-2">
              <legend class="mr-1 text-[11px] text-zinc-500">
                Crossfader direction
              </legend>
              <label class="flex cursor-pointer items-center gap-1.5 rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-[11px] text-zinc-300">
                <input
                  type="radio"
                  :name="`crossfader-direction-${input.identifier}`"
                  value="leftToRight"
                  :checked="crossfaderDirection(input.identifier) === 'leftToRight'"
                  class="h-3.5 w-3.5 cursor-pointer accent-sky-500"
                  @change="setCrossfaderDirection(input.identifier, 'leftToRight')"
                >
                Left to right
              </label>
              <label class="flex cursor-pointer items-center gap-1.5 rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-[11px] text-zinc-300">
                <input
                  type="radio"
                  :name="`crossfader-direction-${input.identifier}`"
                  value="rightToLeft"
                  :checked="crossfaderDirection(input.identifier) === 'rightToLeft'"
                  class="h-3.5 w-3.5 cursor-pointer accent-sky-500"
                  @change="setCrossfaderDirection(input.identifier, 'rightToLeft')"
                >
                Right to left
              </label>
            </fieldset>

            <fieldset class="flex flex-wrap items-center gap-2">
              <legend class="mr-1 text-[11px] text-zinc-500">
                Default deck
              </legend>
              <label class="flex cursor-pointer items-center gap-1.5 rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-[11px] text-zinc-300">
                <input
                  type="radio"
                  :name="`default-deck-${input.identifier}`"
                  value="none"
                  :checked="defaultDeck(input.identifier) === 'none'"
                  class="h-3.5 w-3.5 cursor-pointer accent-sky-500"
                  @change="setDefaultDeck(input.identifier, 'none')"
                >
                None
              </label>
              <label class="flex cursor-pointer items-center gap-1.5 rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-[11px] text-zinc-300">
                <input
                  type="radio"
                  :name="`default-deck-${input.identifier}`"
                  value="deck1"
                  :checked="defaultDeck(input.identifier) === 'deck1'"
                  class="h-3.5 w-3.5 cursor-pointer accent-sky-500"
                  @change="setDefaultDeck(input.identifier, 'deck1')"
                >
                Deck 1 (Left)
              </label>
              <label class="flex cursor-pointer items-center gap-1.5 rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-[11px] text-zinc-300">
                <input
                  type="radio"
                  :name="`default-deck-${input.identifier}`"
                  value="deck2"
                  :checked="defaultDeck(input.identifier) === 'deck2'"
                  class="h-3.5 w-3.5 cursor-pointer accent-sky-500"
                  @change="setDefaultDeck(input.identifier, 'deck2')"
                >
                Deck 2 (Right)
              </label>
            </fieldset>
          </div>
        </div>
      </div>
    </div>

    <div
      v-if="hydrated"
      class="flex justify-end"
    >
      <button
        type="button"
        :disabled="rescanning"
        class="flex items-center gap-1.5 rounded bg-zinc-800 px-3 py-1 text-[11px] font-medium text-zinc-100 hover:bg-zinc-700 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
        @click="requestRescan"
      >
        <svg
          v-if="rescanning"
          class="h-3 w-3 animate-spin"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
        >
          <circle
            class="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            stroke-width="4"
          />
          <path
            class="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 0 1 8-8V0C5.373 0 0 5.373 0 12h4z"
          />
        </svg>
        {{ rescanning ? 'Rescanning…' : 'Rescan devices' }}
      </button>
    </div>
    <p
      v-if="rescanning"
      class="flex items-center gap-2 text-[11px] text-zinc-500"
    >
      <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-500" />
      Scanning MIDI inputs…
    </p>
  </section>
</template>

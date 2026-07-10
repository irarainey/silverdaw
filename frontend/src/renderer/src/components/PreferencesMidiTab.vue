<script setup lang="ts">
const props = defineProps<{
  inputs: ReadonlyArray<{
    name: string
    identifier: string
    connected: boolean
    enabled: boolean
    lastActivityMs: number | null
  }>
  /** True once the first device list has arrived from the backend. */
  hydrated: boolean
  /** True while a user-initiated device rescan is pending. */
  rescanning: boolean
  /** Ask the backend to enumerate MIDI input devices again. */
  requestRescan: () => void
  enabledByIdentifier: Record<string, boolean>
  setInputEnabled: (identifier: string, enabled: boolean) => void
}>()

function formatLastActivity(lastActivityMs: number | null): string {
  return lastActivityMs === null
    ? 'No activity yet'
    : `Last activity ${new Date(lastActivityMs).toLocaleTimeString()}`
}

function onEnabledChange(identifier: string, event: Event): void {
  props.setInputEnabled(identifier, (event.target as HTMLInputElement).checked)
}
</script>

<template>
  <section class="space-y-4">
    <div>
      <h2 class="mb-2 text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
        MIDI input devices
      </h2>
      <p class="mb-3 text-zinc-500">
        Enable the keyboards and controllers Silverdaw should listen to. Enabled
        devices are remembered for the next launch.
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
          class="flex items-center gap-3 rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2.5"
        >
          <label class="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
            <input
              type="checkbox"
              :checked="enabledByIdentifier[input.identifier] === true"
              class="h-4 w-4 shrink-0 cursor-pointer accent-sky-500"
              @change="onEnabledChange(input.identifier, $event)"
            >
            <span class="min-w-0 flex-1 leading-tight">
              <span class="block truncate font-medium text-zinc-200">{{ input.name }}</span>
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
            <span class="block">{{ formatLastActivity(input.lastActivityMs) }}</span>
          </span>
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

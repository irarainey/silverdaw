<script setup lang="ts">
import ScratchNotationEditor from '@/components/ScratchNotationEditor.vue'

defineProps<{
  statusMessage: string | null
  isError: boolean
  isPreparing: boolean
  preparationPercent: number
  isRecording: boolean
  /** True once a scratch has been recorded and is ready to edit/replay. */
  hasCompletedRecording: boolean
  isArmed: boolean
  sessionId: string | null
  notationReplayPositionNormalized: number | null
}>()
</script>

<template>
  <div class="flex min-w-0 min-h-0 flex-col gap-2 overflow-hidden">
    <template v-if="statusMessage">
      <div class="flex flex-1 items-center justify-center rounded border border-zinc-800 bg-zinc-950/40">
        <div class="w-full max-w-sm px-6 text-center">
          <p
            class="text-xs"
            :class="isError ? 'text-red-400' : 'text-zinc-400'"
            :role="isError ? 'alert' : 'status'"
          >
            {{ statusMessage }}
          </p>
          <div
            v-if="isPreparing"
            class="mt-3"
          >
            <div
              class="h-1.5 overflow-hidden rounded-full bg-zinc-800"
              role="progressbar"
              aria-label="Preparing audio for scratching"
              aria-valuemin="0"
              aria-valuemax="100"
              :aria-valuenow="preparationPercent"
            >
              <div
                class="h-full rounded-full bg-sky-500 transition-[width] duration-150"
                :style="{ width: `${preparationPercent}%` }"
              />
            </div>
            <p class="mt-1 font-mono text-[10px] tabular-nums text-zinc-500">
              {{ preparationPercent }}%
            </p>
          </div>
        </div>
      </div>
    </template>
    <template v-else>
      <!-- Notation content by phase -->
      <template v-if="isRecording">
        <div class="flex flex-1 items-center justify-center rounded border border-zinc-800 bg-zinc-950/40">
          <span
            class="inline-flex items-center gap-1.5 text-xs text-red-400"
            role="status"
          >
            <span
              class="h-2 w-2 animate-pulse rounded-full bg-red-500"
              aria-hidden="true"
            />
            Recording…
          </span>
        </div>
      </template>
      <template v-else-if="hasCompletedRecording">
        <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
          <ScratchNotationEditor
            class="min-h-0 flex-1"
            :session-id="sessionId"
            :replay-position-normalized="notationReplayPositionNormalized"
          />
        </div>
      </template>
      <template v-else>
        <div class="flex flex-1 items-center justify-center rounded border border-zinc-800 bg-zinc-950/40">
          <div class="text-center">
            <template v-if="isArmed">
              <p
                class="text-xs text-amber-400"
                role="status"
              >
                Armed — touch the platter to start recording
              </p>
            </template>
            <template v-else>
              <p class="text-xs text-zinc-500">
                No scratch recorded
              </p>
              <p class="text-[10px] text-zinc-600">
                Press Record, then touch the platter to begin
              </p>
            </template>
          </div>
        </div>
      </template>
    </template>
  </div>
</template>

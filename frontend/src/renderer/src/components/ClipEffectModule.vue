<script setup lang="ts">
// A single "rack module" in the Clip Editor's effects rack. Every effect
// (warp, pitch, fades, and the future EQ / compressor / reverb / delay) is
// wrapped in one of these so they share the same plugin-style chrome and
// snap to the rack's modular cell grid.
//
// Sizing is modular: `cols` / `rows` are the module's size measured in
// base cells. The parent rack defines the base cell's fixed pixel size
// (so the aspect ratio stays consistent however the resizable dialog is
// sized), and each module spans an integer number of those cells via
// CSS grid `span`. Bigger / more complex effects (e.g. an 8–10 band EQ)
// simply declare a larger span.
import { computed, useId } from 'vue'

const props = withDefaults(
  defineProps<{
    /** Module heading shown in the header bar. */
    title: string
    /** Width of the module in base cells. */
    cols?: number
    /** Height of the module in base cells. */
    rows?: number
  }>(),
  { cols: 1, rows: 1 }
)

const headingId = useId()

const gridStyle = computed(() => ({
  gridColumn: `span ${Math.max(1, Math.round(props.cols))}`,
  gridRow: `span ${Math.max(1, Math.round(props.rows))}`
}))
</script>

<template>
  <section
    class="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/50 shadow-sm"
    :style="gridStyle"
    :aria-labelledby="headingId"
  >
    <header
      class="flex shrink-0 items-center justify-between gap-2 border-b border-zinc-800 bg-zinc-900/80 px-3 py-2"
    >
      <h3
        :id="headingId"
        class="truncate text-[11px] font-semibold uppercase tracking-wider text-zinc-200"
      >
        {{ title }}
      </h3>
      <!-- Reserved for per-effect controls (e.g. a future bypass toggle). -->
      <div class="flex shrink-0 items-center gap-1">
        <slot name="actions" />
      </div>
    </header>
    <div class="silverdaw-scroll min-h-0 flex-1 overflow-y-auto p-3">
      <slot />
    </div>
  </section>
</template>

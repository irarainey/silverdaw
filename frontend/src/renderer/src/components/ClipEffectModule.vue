<script setup lang="ts">
// A single rack module in the Clip Editor's effects rack. Each effect (warp,
// pitch, fades, future EQ/dynamics) is wrapped here to share plugin-style chrome
// and snap to the rack's cell grid. `cols`/`rows` size the module in base cells
// (fixed pixel size set by the parent rack) via CSS grid `span`.
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

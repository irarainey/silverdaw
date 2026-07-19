<script setup lang="ts">
// Shared layout shell for the bottom-panel effects racks (Track FX and
// Project FX). Lays its slotted modules out as fixed-size, plugin-style
// cells that wrap within the panel. The individual modules own their own
// editing / undo wiring; this shell only provides the scrolling grid and
// group label.

import { computed } from 'vue'

const CELL_WIDTH_REM = 17
const CELL_HEIGHT_REM = 13.25
const CELL_GAP_REM = 0.75

const props = defineProps<{
  /** Accessible name for the rack's module group. */
  assistiveLabel: string
  /** Fixed column count for an intentional module layout. */
  columns?: number
  /** Explicit grid areas for a layout whose module positions must not auto-pack. */
  gridTemplateAreas?: string
  /** Maximum rack width before modules stop growing on larger displays. */
  maxRackWidthRem?: number
}>()

const maxRackWidthRem = computed(() => {
  const width = props.maxRackWidthRem
  return typeof width === 'number' && Number.isFinite(width) && width > 0 ? width : null
})

const gridStyle = computed(() => {
  const style: Record<string, string> = {
    '--cell-w': `${CELL_WIDTH_REM}rem`,
    '--cell-h': `${CELL_HEIGHT_REM}rem`,
    '--cell-gap': `${CELL_GAP_REM}rem`
  }
  if (typeof props.columns !== 'number') return style
  const columns = Math.max(1, Math.round(props.columns))
  const rackWidthRem =
    maxRackWidthRem.value ?? columns * CELL_WIDTH_REM + (columns - 1) * CELL_GAP_REM
  style.gridTemplateColumns = `repeat(${columns}, minmax(0, 1fr))`
  style.width = `min(100%, ${rackWidthRem}rem)`
  if (typeof props.gridTemplateAreas === 'string') {
    style.gridTemplateAreas = props.gridTemplateAreas
  }
  return style
})
</script>

<template>
  <div class="flex h-full min-h-0 w-full flex-col">
    <div
      class="fx-rack silverdaw-scroll grid min-h-0 min-w-0 flex-1 gap-3 overflow-x-hidden overflow-y-auto p-3"
      role="group"
      :aria-label="assistiveLabel"
      :style="gridStyle"
    >
      <slot />
    </div>
  </div>
</template>

<style scoped>
/* Modules wrap at the panel width. A cell may shrink only on very narrow
   panels, so Track FX never gains a horizontal scrollbar. */
.fx-rack {
  grid-template-columns: repeat(auto-fit, minmax(min(100%, var(--cell-w)), 1fr));
  grid-auto-rows: calc((var(--cell-h) - var(--cell-gap)) / 2);
  grid-auto-flow: row dense;
  align-content: start;
}

</style>

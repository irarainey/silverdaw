<script setup lang="ts">
// Floating context menu shown when the user right-clicks a clip in
// the timeline. The host (TimelineView) tracks the pointer position
// and the targeted clip id; this component renders the menu and emits
// `command` events when an enabled item is chosen. Disabled items are
// rendered greyed-out so the user can see what's coming without being
// able to invoke them (yet).

import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

export interface ClipContextMenuItem {
  /** Action token forwarded to the parent on click. */
  command: string
  label: string
  /** When true, the item renders muted and isn't clickable. */
  disabled?: boolean
  /** Visual rule below the previous item. */
  separatorAbove?: boolean
}

const props = defineProps<{
  open: boolean
  /** Viewport-pixel position of the right-click. */
  x: number
  y: number
  items: ReadonlyArray<ClipContextMenuItem>
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'command', command: string): void
}>()

const menuEl = ref<HTMLDivElement | null>(null)
// Computed display position with edge-clamp so the menu never overflows
// the viewport. Updated on open + on resize.
const displayX = ref(0)
const displayY = ref(0)

function computePosition(): void {
  const el = menuEl.value
  if (!el) {
    displayX.value = props.x
    displayY.value = props.y
    return
  }
  const rect = el.getBoundingClientRect()
  const margin = 6
  const maxX = window.innerWidth - rect.width - margin
  const maxY = window.innerHeight - rect.height - margin
  displayX.value = Math.max(margin, Math.min(maxX, props.x))
  displayY.value = Math.max(margin, Math.min(maxY, props.y))
}

watch(
  () => [props.open, props.x, props.y] as const,
  ([open]) => {
    if (!open) return
    // The element may not exist yet on the first open; defer one tick
    // so `menuEl` is mounted and we can measure its width/height.
    requestAnimationFrame(computePosition)
  }
)

function onWindowResize(): void {
  if (props.open) computePosition()
}

function onWindowKey(e: KeyboardEvent): void {
  if (!props.open) return
  if (e.key === 'Escape') {
    e.preventDefault()
    emit('close')
  }
}

function onBackdropPointer(e: PointerEvent): void {
  // Click outside the menu — close. The menu's own pointer-down doesn't
  // bubble here because it's wrapped in `@pointerdown.stop`.
  if (e.button !== 0 && e.button !== 2) return
  emit('close')
}

function onItemClick(item: ClipContextMenuItem): void {
  if (item.disabled) return
  emit('command', item.command)
  emit('close')
}

onMounted(() => {
  window.addEventListener('keydown', onWindowKey, { capture: true })
  window.addEventListener('resize', onWindowResize)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onWindowKey, { capture: true })
  window.removeEventListener('resize', onWindowResize)
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-[1200]"
      @pointerdown="onBackdropPointer"
      @contextmenu.prevent
    >
      <div
        ref="menuEl"
        class="absolute min-w-[180px] rounded-lg border border-zinc-700 bg-zinc-900 py-1 text-xs text-zinc-200 shadow-xl"
        :style="{ left: displayX + 'px', top: displayY + 'px' }"
        role="menu"
        @pointerdown.stop
      >
        <template
          v-for="(item, i) in items"
          :key="item.command + i"
        >
          <div
            v-if="item.separatorAbove && i > 0"
            class="my-1 h-px bg-zinc-800"
          />
          <button
            type="button"
            role="menuitem"
            class="flex w-full items-center px-3 py-1.5 text-left transition-colors"
            :class="
              item.disabled
                ? 'cursor-not-allowed text-zinc-600'
                : 'cursor-pointer text-zinc-200 hover:bg-zinc-800 hover:text-zinc-50'
            "
            :disabled="item.disabled"
            @click="onItemClick(item)"
          >
            {{ item.label }}
          </button>
        </template>
      </div>
    </div>
  </Teleport>
</template>

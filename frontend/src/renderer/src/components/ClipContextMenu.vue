<script setup lang="ts">
// Floating context menu shown when the user right-clicks a clip in
// the timeline. The host (TimelineView) tracks the pointer position
// and the targeted clip id; this component renders the menu and emits
// `command` events when an enabled item is chosen. Disabled items are
// rendered greyed-out so the user can see what's coming without being
// able to invoke them (yet).

import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ClipContextMenuItem } from '@/lib/timeline/clipContextMenuTypes'

export type { ClipContextMenuItem }

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
  if (item.swatches) return
  emit('command', item.command)
  emit('close')
}

function onSwatchClick(item: ClipContextMenuItem, index: number): void {
  // Encode the swatch index into the command string so the host's
  // existing `onContextMenuCommand` switch can fan out on a single
  // parameter without us adding a separate emit channel.
  emit('command', `${item.command}:${index}`)
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
          <div
            v-if="item.swatches"
            class="px-3 py-1.5"
          >
            <div class="mb-1 text-[10px] uppercase tracking-wide text-zinc-500">
              {{ item.label }}
            </div>
            <div class="grid grid-cols-8 gap-1">
              <button
                v-for="(s, idx) in item.swatches"
                :key="idx"
                type="button"
                data-borderless-button="true"
                class="h-4 w-4 rounded-sm transition-transform hover:scale-110"
                :class="
                  item.selectedSwatch === idx
                    ? 'ring-1 ring-zinc-100'
                    : ''
                "
                :style="{ backgroundColor: s.cssHex }"
                :title="s.label"
                @click="onSwatchClick(item, idx)"
              />
            </div>
          </div>
          <button
            v-else
            type="button"
            role="menuitem"
            data-borderless-button="true"
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

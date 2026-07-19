<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ClipContextMenuItem } from '@/lib/timeline/clipContextMenuTypes'
import ClipContextMenuItems from '@/components/ClipContextMenuItems.vue'

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
const displayX = ref(0)
const displayY = ref(0)
const submenuToLeft = ref(false)

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
  submenuToLeft.value = displayX.value + rect.width + 180 > window.innerWidth
}

watch(
  () => [props.open, props.x, props.y] as const,
  ([open]) => {
    if (!open) return
    requestAnimationFrame(computePosition)
  }
)

function onWindowResize(): void {
  if (props.open) computePosition()
}

function onWindowKey(e: KeyboardEvent): void {
  if (props.open && e.key === 'Escape') {
    e.preventDefault()
    emit('close')
  }
}

function onBackdropPointer(e: PointerEvent): void {
  if (e.button === 0 || e.button === 2) emit('close')
}

function onItemSelect(command: string): void {
  emit('command', command)
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
        <ClipContextMenuItems
          :items="items"
          :submenu-to-left="submenuToLeft"
          @select="onItemSelect"
        />
      </div>
    </div>
  </Teleport>
</template>

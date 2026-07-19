<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import type { ClipContextMenuItem } from '@/lib/timeline/clipContextMenuTypes'

defineOptions({ name: 'ClipContextMenuItems' })

const props = defineProps<{
  items: ReadonlyArray<ClipContextMenuItem>
  submenuToLeft: boolean
}>()

const emit = defineEmits<{
  (e: 'select', command: string): void
}>()

const openSubmenuIndex = ref<number | null>(null)
const SUBMENU_CLOSE_DELAY_MS = 300
let closeTimer: ReturnType<typeof setTimeout> | undefined

function cancelSubmenuClose(): void {
  if (closeTimer === undefined) return
  clearTimeout(closeTimer)
  closeTimer = undefined
}

function openSubmenu(index: number): void {
  cancelSubmenuClose()
  openSubmenuIndex.value = index
}

function scheduleSubmenuClose(): void {
  cancelSubmenuClose()
  closeTimer = setTimeout(() => {
    openSubmenuIndex.value = null
    closeTimer = undefined
  }, SUBMENU_CLOSE_DELAY_MS)
}

function selectItem(item: ClipContextMenuItem): void {
  if (!item.disabled && !item.swatches) emit('select', item.command)
}

function selectSwatch(item: ClipContextMenuItem, index: number): void {
  emit('select', `${item.command}:${index}`)
}

onBeforeUnmount(cancelSubmenuClose)
</script>

<template>
  <div role="menu">
    <template
      v-for="(item, index) in props.items"
      :key="item.command + index"
    >
      <div
        v-if="item.separatorAbove && index > 0"
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
            v-for="(swatch, swatchIndex) in item.swatches"
            :key="swatchIndex"
            type="button"
            data-borderless-button="true"
            class="h-4 w-4 rounded-sm transition-transform hover:scale-110"
            :class="item.selectedSwatch === swatchIndex ? 'ring-1 ring-zinc-100' : ''"
            :style="{ backgroundColor: swatch.cssHex }"
            :title="swatch.label"
            @click="selectSwatch(item, swatchIndex)"
          />
        </div>
      </div>
      <button
        v-else-if="!item.submenu"
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
        :title="item.title"
        @click="selectItem(item)"
      >
        {{ item.label }}
      </button>
      <div
        v-else
        class="relative"
        @mouseenter="openSubmenu(index)"
        @mouseleave="scheduleSubmenuClose"
      >
        <button
          type="button"
          role="menuitem"
          data-borderless-button="true"
          class="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left transition-colors"
          :class="
            item.disabled
              ? 'cursor-not-allowed text-zinc-600'
              : 'cursor-pointer text-zinc-200 hover:bg-zinc-800 hover:text-zinc-50'
          "
          :disabled="item.disabled"
          :title="item.title"
        >
          <span>{{ item.label }}</span>
          <span class="text-zinc-500">›</span>
        </button>
        <ClipContextMenuItems
          v-if="openSubmenuIndex === index && !item.disabled"
          class="absolute top-0 min-w-[150px] rounded-lg border border-zinc-700 bg-zinc-900 py-1 shadow-xl"
          :class="props.submenuToLeft ? 'right-full mr-0.5' : 'left-full ml-0.5'"
          :items="item.submenu"
          :submenu-to-left="props.submenuToLeft"
          @select="emit('select', $event)"
        />
      </div>
    </template>
  </div>
</template>

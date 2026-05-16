<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'
import { menus, type MenuItemDef } from '@/menu'
// The 32x32 variant displays cleanly at the 16-px title-bar size on
// both 100% and 200%-DPI displays. Vite turns the import into a
// hashed-URL static asset at build time.
import iconUrl from '@resources/icons/32x32.png'

const openIndex = ref<number | null>(null)
const root = ref<HTMLElement | null>(null)

function toggle(i: number): void {
  openIndex.value = openIndex.value === i ? null : i
}

function onHover(i: number): void {
  // Only switch menus on hover if a menu is already open (Windows behaviour).
  if (openIndex.value !== null) openIndex.value = i
}

function invoke(item: MenuItemDef): void {
  if (item.disabled || !item.action) return
  openIndex.value = null
  window.silverdaw.menuAction(item.action)
}

function onDocumentClick(e: MouseEvent): void {
  if (!root.value) return
  if (!root.value.contains(e.target as Node)) openIndex.value = null
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') openIndex.value = null
}

onMounted(() => {
  document.addEventListener('mousedown', onDocumentClick)
  document.addEventListener('keydown', onKey)
})

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocumentClick)
  document.removeEventListener('keydown', onKey)
})
</script>

<template>
  <header
    ref="root"
    class="titlebar flex h-9 w-full select-none items-stretch bg-zinc-900 text-xs text-zinc-300"
    style="-webkit-app-region: drag"
  >
    <!-- Brand. Sourced from `frontend/resources/icons/` so the same icon
         set powers the title bar, the OS taskbar, and (later) the
         packaged-app exe. -->
    <div
      class="flex items-center px-3 text-zinc-100"
      aria-label="Silverdaw"
      title="Silverdaw"
    >
      <img
        :src="iconUrl"
        alt=""
        aria-hidden="true"
        class="h-4 w-4"
        draggable="false"
      >
    </div>

    <!-- Menus -->
    <nav
      class="flex items-stretch"
      style="-webkit-app-region: no-drag"
    >
      <div
        v-for="(m, i) in menus"
        :key="m.label"
        class="relative"
      >
        <button
          type="button"
          class="h-full px-3 hover:bg-zinc-800"
          :class="{ 'bg-zinc-800': openIndex === i }"
          @click="toggle(i)"
          @mouseenter="onHover(i)"
        >
          {{ m.label }}
        </button>

        <!-- Dropdown -->
        <div
          v-if="openIndex === i"
          class="absolute left-0 top-full z-50 min-w-56 border border-zinc-700 bg-zinc-900 py-1 shadow-2xl"
        >
          <template
            v-for="(item, j) in m.items"
            :key="j"
          >
            <div
              v-if="item.label === null"
              class="my-1 border-t border-zinc-700"
            />
            <button
              v-else
              type="button"
              class="flex w-full items-center justify-between px-3 py-1.5 text-left hover:bg-zinc-800 disabled:cursor-not-allowed disabled:text-zinc-600 disabled:hover:bg-transparent"
              :disabled="item.disabled"
              @click="invoke(item)"
            >
              <span>{{ item.label }}</span>
              <span
                v-if="item.accelerator"
                class="ml-6 text-zinc-500"
              >{{ item.accelerator }}</span>
            </button>
          </template>
        </div>
      </div>
    </nav>

    <!-- Drag spacer; window-controls-overlay reserves space on the right automatically. -->
    <div class="flex-1" />
  </header>
</template>

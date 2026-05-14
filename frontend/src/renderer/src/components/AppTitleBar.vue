<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'
import { menus, type MenuItemDef } from '@/menu'

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
  window.jackdaw.menuAction(item.action)
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
    <!-- Brand. Replace this inline SVG with an <img src="@/assets/logo.svg" /> if you want a custom asset. -->
    <div
      class="flex items-center px-3 text-zinc-100"
      aria-label="Jackdaw"
      title="Jackdaw"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="h-4 w-4"
        aria-hidden="true"
      >
        <path d="M16 7h.01" />
        <path d="M3.4 18H12a8 8 0 0 0 8-8V7a4 4 0 0 0-7.28-2.3L2 20" />
        <path d="m20 7 2 .5-2 .5" />
        <path d="M10 18v3" />
        <path d="M14 17.75V21" />
        <path d="M7 18a6 6 0 0 0 3.84-10.61" />
      </svg>
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

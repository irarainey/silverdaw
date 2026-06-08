<script setup lang="ts">
import { ref } from 'vue'
import AppTitleBarWindowControls from '@/components/AppTitleBarWindowControls.vue'
import {
  useAppTitleBarController,
  type AppTitleBarProps
} from '@/lib/app/useAppTitleBarController'

const props = defineProps<AppTitleBarProps>()

const root = ref<HTMLElement | null>(null)
const renameInput = ref<HTMLInputElement | null>(null)

const {
  project,
  windowControlsDisabled,
  iconUrl,
  visibleMenus,
  isItemDisabled,
  openIndex,
  openSubmenuKey,
  renaming,
  renameDraft,
  displayName,
  renameTooltip,
  toggle,
  onHover,
  onItemHover,
  invoke,
  minimizeWindow,
  toggleMaximizeWindow,
  requestCloseWindow,
  startRename,
  commitRename,
  cancelRename
} = useAppTitleBarController(props, root, renameInput)
</script>

<template>
  <header
    ref="root"
    class="titlebar relative flex h-9 w-full select-none items-stretch bg-zinc-900 text-xs text-zinc-300"
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
        v-for="(m, i) in visibleMenus"
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
            <div
              v-else
              class="relative"
              @mouseenter="onItemHover(i, j, item)"
            >
              <button
                type="button"
                class="flex w-full items-center justify-between px-3 py-1.5 text-left hover:bg-zinc-800 disabled:cursor-not-allowed disabled:text-zinc-600 disabled:hover:bg-transparent"
                :class="{ 'bg-zinc-800': openSubmenuKey === `${i}:${j}` }"
                :disabled="isItemDisabled(item)"
                :title="item.hint"
                @click="invoke(item)"
              >
                <span class="truncate">{{ item.label }}</span>
                <span
                  v-if="item.submenu && item.submenu.length > 0"
                  class="ml-6 text-zinc-500"
                  aria-hidden="true"
                >▸</span>
                <span
                  v-else-if="item.accelerator"
                  class="ml-6 text-zinc-500"
                >{{ item.accelerator }}</span>
              </button>

              <!-- Flyout submenu. Anchored to the right edge of the
                   parent row; `top-0` keeps the first sub-item aligned
                   with the parent row, matching Windows menu behaviour. -->
              <div
                v-if="item.submenu && openSubmenuKey === `${i}:${j}`"
                class="absolute left-full top-0 z-50 min-w-64 border border-zinc-700 bg-zinc-900 py-1 shadow-2xl"
              >
                <template
                  v-for="(sub, k) in item.submenu"
                  :key="k"
                >
                  <div
                    v-if="sub.label === null"
                    class="my-1 border-t border-zinc-700"
                  />
                  <button
                    v-else
                    type="button"
                    class="flex w-full items-center justify-between gap-4 px-3 py-1.5 text-left hover:bg-zinc-800 disabled:cursor-not-allowed disabled:text-zinc-500 disabled:hover:bg-transparent"
                    :disabled="isItemDisabled(sub)"
                    :title="sub.hint"
                    @click="invoke(sub)"
                  >
                    <span class="truncate">{{ sub.label }}</span>
                    <span
                      v-if="sub.accelerator"
                      class="text-zinc-500"
                    >{{ sub.accelerator }}</span>
                  </button>
                </template>
              </div>
            </div>
          </template>
        </div>
      </div>
    </nav>

    <!-- Centred project name. Double-click the label or click the
         pencil to rename. -->
    <div
      class="pointer-events-none absolute inset-x-0 top-0 flex h-9 items-center justify-center"
    >
      <div
        class="pointer-events-auto flex items-center"
        style="-webkit-app-region: no-drag"
      >
        <input
          v-if="renaming"
          ref="renameInput"
          v-model="renameDraft"
          type="text"
          maxlength="120"
          class="w-64 rounded bg-zinc-800 px-2 py-0.5 text-center text-zinc-100 outline-none ring-1 ring-zinc-600 focus:ring-sky-500"
          @keydown.enter.prevent="commitRename"
          @keydown.escape.prevent="cancelRename"
          @blur="commitRename"
        >
        <div
          v-else
          class="group flex items-center"
        >
          <button
            type="button"
            class="rounded-l px-2 py-0.5 font-medium text-zinc-200 group-hover:bg-zinc-800"
            :title="renameTooltip"
            @dblclick="startRename"
          >
            <span
              v-if="project.isDirty"
              class="mr-1 text-zinc-400"
              aria-label="Unsaved changes"
              title="Unsaved changes"
            >•</span>{{ displayName }}
          </button>
          <!-- Pencil affordance — half-opacity until the user hovers
               the project-name region, then fully visible. Clicking
               starts rename, so the user never needs to discover
               double-click on the label. -->
          <button
            type="button"
            class="rounded-r px-1.5 py-0.5 text-zinc-500 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-zinc-800 hover:text-zinc-200 focus:opacity-100 focus:bg-zinc-800 focus:text-zinc-200 focus:outline-none"
            title="Rename project"
            aria-label="Rename project"
            @click="startRename"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 16 16"
              fill="currentColor"
              class="h-3 w-3"
              aria-hidden="true"
            ><path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25a1.75 1.75 0 0 1 .445-.758l8.61-8.61Zm1.414 1.06a.25.25 0 0 0-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 0 0 0-.354l-1.086-1.086ZM11.189 6.25 9.75 4.811l-6.286 6.287a.25.25 0 0 0-.064.108l-.558 1.953 1.953-.558a.249.249 0 0 0 .108-.064l6.286-6.287Z" /></svg>
          </button>
        </div>
      </div>
    </div>

    <!-- Drag spacer + renderer-owned window controls. Native window-controls-overlay
         is disabled so modal dialogs can make these buttons inaccessible. -->
    <div class="flex-1" />
    <AppTitleBarWindowControls
      :disabled="windowControlsDisabled"
      @minimize="minimizeWindow"
      @toggle-maximize="toggleMaximizeWindow"
      @close="requestCloseWindow"
    />
  </header>
</template>

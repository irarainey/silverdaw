<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, ref } from 'vue'
import { buildMenus, type MenuItemDef } from '@/menu'
// The 32x32 variant displays cleanly at the 16-px title-bar size on
// both 100% and 200%-DPI displays. Vite turns the import into a
// hashed-URL static asset at build time.
import iconUrl from '@resources/icons/32x32.png'
import { useProjectStore, DEFAULT_PROJECT_NAME } from '@/stores/projectStore'
import { useAppStore } from '@/stores/appStore'

const project = useProjectStore()
const appStore = useAppStore()

// Menu list is rebuilt whenever `devToolsEnabled` flips. In practice the flag
// is a startup snapshot so this is computed once, but `computed` keeps
// the dependency wiring honest without any extra cost.
const visibleMenus = computed(() =>
  buildMenus({ devToolsEnabled: appStore.devToolsEnabled, recentProjects: appStore.recentProjects })
)

/** Per-action dynamic disabled overrides. Menu definitions are static
 *  (so `menuShortcuts` can bind accelerators once at startup), but a
 *  handful of items need to reflect live store state — Undo / Redo
 *  grey out when the backend's UndoManager has nothing to undo / redo.
 *  Returning a non-boolean from this map means "fall through to the
 *  static `item.disabled`". */
function isActionDynamicallyDisabled(action: string | undefined): boolean | null {
  if (!action) return null
  if (action === 'edit.undo') return !project.canUndo
  if (action === 'edit.redo') return !project.canRedo
  return null
}

function isItemDisabled(item: MenuItemDef): boolean {
  const dyn = isActionDynamicallyDisabled(item.action)
  if (dyn !== null) return dyn
  return item.disabled === true
}

const openIndex = ref<number | null>(null)
/** Key of the currently-open submenu, formatted as
 *  `<topMenuIndex>:<itemIndex>`. Null when no submenu is open. Only
 *  one submenu can be open at a time; opening a new one closes the
 *  previous. */
const openSubmenuKey = ref<string | null>(null)
const root = ref<HTMLElement | null>(null)

const renaming = ref(false)
const renameInput = ref<HTMLInputElement | null>(null)
const renameDraft = ref('')

const displayName = computed(() =>
  project.projectName?.trim() ? project.projectName : DEFAULT_PROJECT_NAME
)

const renameTooltip = computed(() => {
  const base = project.currentFilePath ?? 'Unsaved project'
  return `${base}\nClick the pencil (or double-click the name) to rename`
})

function toggle(i: number): void {
  openIndex.value = openIndex.value === i ? null : i
  // Closing or switching the top-level menu must collapse any open
  // submenu — its parent has gone away.
  openSubmenuKey.value = null
}

function onHover(i: number): void {
  // Only switch menus on hover if a menu is already open (Windows behaviour).
  if (openIndex.value !== null) {
    openIndex.value = i
    openSubmenuKey.value = null
  }
}

function onItemHover(menuIdx: number, itemIdx: number, item: MenuItemDef): void {
  // Hovering a non-submenu item should retract any flyout that was
  // open from an earlier sibling. Hovering a submenu parent opens its
  // flyout — Windows-style "flyouts follow the pointer once a menu
  // is open".
  if (item.submenu && item.submenu.length > 0) {
    openSubmenuKey.value = `${menuIdx}:${itemIdx}`
  } else {
    openSubmenuKey.value = null
  }
}

function invoke(item: MenuItemDef): void {
  // Submenu parents don't have actions — clicking the row just keeps
  // (or opens) the flyout. Hover already handles open; nothing to do
  // here.
  if (item.submenu && item.submenu.length > 0) return
  if (isItemDisabled(item) || !item.action) return
  openIndex.value = null
  openSubmenuKey.value = null
  // Intercept the project-rename menu item directly — the rename input
  // lives in this component so it's simpler to switch into edit mode
  // here than to round-trip through main + the renderer-side
  // `menu:action` IPC.
  if (item.action === 'file.renameProject') {
    void startRename()
    return
  }
  // Recent Projects entries don't need to involve main — the renderer
  // already owns the MRU mirror (appStore.recentProjects) and the
  // open-project flow (App.vue handleMenuAction). Forward them as
  // synthetic actions on the same `menu:action` channel so App.vue
  // sees a single dispatch point.
  window.silverdaw.menuAction(item.action)
}

async function startRename(): Promise<void> {
  renameDraft.value = displayName.value
  renaming.value = true
  await nextTick()
  renameInput.value?.focus()
  renameInput.value?.select()
}

function commitRename(): void {
  if (!renaming.value) return
  renaming.value = false
  const next = renameDraft.value.trim()
  if (next.length > 0 && next !== project.projectName) {
    project.requestRename(next)
  }
}

function cancelRename(): void {
  renaming.value = false
}

function onDocumentClick(e: MouseEvent): void {
  if (!root.value) return
  if (!root.value.contains(e.target as Node)) {
    openIndex.value = null
    openSubmenuKey.value = null
  }
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    openIndex.value = null
    openSubmenuKey.value = null
  }
}

onMounted(() => {
  document.addEventListener('mousedown', onDocumentClick)
  document.addEventListener('keydown', onKey)
})

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocumentClick)
  document.removeEventListener('keydown', onKey)
})

// Expose the rename trigger so external callers (e.g. App.vue's File
// menu handler) can drive it. defineExpose makes this addressable via
// `ref` on the parent.
defineExpose({ startRename })
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

    <!-- Drag spacer; window-controls-overlay reserves space on the right automatically. -->
    <div class="flex-1" />
  </header>
</template>

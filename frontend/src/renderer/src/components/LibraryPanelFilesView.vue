<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useFileBrowserStore, fileBrowserRowIndentPx } from '@/stores/fileBrowserStore'
import FileBrowserFileRow from '@/components/FileBrowserFileRow.vue'
import ClipContextMenu, { type ClipContextMenuItem } from '@/components/ClipContextMenu.vue'

const browser = useFileBrowserStore()
const { roots, rows, filterHidesEverything, pinnedAudition } = storeToRefs(browser)

const contextMenu = ref<{ path: string; isRoot: boolean; kind: 'directory' | 'file'; x: number; y: number } | null>(
  null
)

const contextMenuItems = computed<ClipContextMenuItem[]>(() => {
  const menu = contextMenu.value
  if (!menu) return []
  if (menu.kind === 'directory') {
    const items: ClipContextMenuItem[] = [{ command: 'fileBrowser.refresh', label: 'Refresh' }]
    // Only an added folder can leave the browser; nested folders go with it.
    if (menu.isRoot) items.push({ command: 'fileBrowser.remove', label: 'Remove Folder' })
    return items
  }
  return [
    {
      command: 'fileBrowser.togglePlay',
      label: browser.isPlaying(menu.path) ? 'Pause' : 'Play'
    },
    { command: 'fileBrowser.restart', label: 'Back to Start' },
    { command: 'fileBrowser.import', label: 'Import into Library', separatorAbove: true }
  ]
})

function openContextMenu(event: MouseEvent, path: string, kind: 'directory' | 'file', isRoot: boolean): void {
  contextMenu.value = { path, kind, isRoot, x: event.clientX, y: event.clientY }
}

function closeContextMenu(): void {
  contextMenu.value = null
}

function onContextMenuCommand(command: string): void {
  const menu = contextMenu.value
  closeContextMenu()
  if (!menu) return
  switch (command) {
    case 'fileBrowser.refresh':
      void browser.refresh(menu.path)
      break
    case 'fileBrowser.remove':
      void browser.removeFolder(menu.path)
      break
    case 'fileBrowser.togglePlay':
      browser.togglePlay(menu.path)
      break
    case 'fileBrowser.restart':
      browser.restart(menu.path)
      break
    case 'fileBrowser.import':
      void browser.importFile(menu.path)
      break
    default:
      break
  }
}

// Clicking a folder both selects it (arming Delete for folders the user added)
// and toggles its disclosure, so one click still opens the tree as before.
function onFolderClick(path: string): void {
  browser.select(path)
  void browser.toggle(path)
}

// Focus stays on the tree container so one keydown handler drives the whole
// list, which means the active row has to be named for a screen reader or only
// the tree itself is announced. Rows are addressed by path, which is unique.
function rowDomId(path: string): string {
  return `file-browser-row-${encodeURIComponent(path)}`
}
const activeRowId = computed(() =>
  browser.selectedPath === null ? undefined : rowDomId(browser.selectedPath)
)

// Arrow-key navigation can land on a row that is scrolled out of sight, so the
// selection is always brought back into view. `nearest` makes this a no-op for
// rows already on screen, leaving click selection undisturbed.
const treeEl = ref<HTMLElement | null>(null)
watch(
  () => browser.selectedPath,
  async () => {
    await nextTick()
    treeEl.value?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }
)

// Clearing the filter box hands the keyboard back, so the arrow and Enter keys
// carry on driving the tree instead of dead-ending in an empty search field.
watch(
  () => browser.treeFocusRequest,
  async () => {
    await nextTick()
    treeEl.value?.focus()
  }
)

function onTreeScroll(): void {
  const el = treeEl.value
  if (el) browser.setScrollTop(el.scrollTop)
}

/**
 * Switching tabs unmounts this view, so returning to it puts the tree back where
 * the user left it, brings the selection into view if the restored offset does
 * not already show it, and takes focus so the keyboard shortcuts work without a
 * click first.
 */
async function restoreTreeView(): Promise<void> {
  await nextTick()
  const el = treeEl.value
  if (!el) return
  el.scrollTop = browser.scrollTop
  el.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  el.focus()
}

onMounted(async () => {
  // Rows only exist once the added folders have been listed, and an empty tree
  // cannot be scrolled, so the restore waits for the first listing.
  await browser.hydrate()
  await restoreTreeView()
})
</script>

<template>
  <div class="flex min-h-0 flex-1 overflow-hidden">
    <!-- Fixed column: the only way folders enter the browser. -->
    <div class="flex w-10 shrink-0 flex-col gap-2 border-r border-zinc-800 bg-zinc-900 p-1.5">
      <button
        type="button"
        class="flex h-7 w-7 items-center justify-center rounded border border-zinc-700 bg-zinc-800 text-zinc-300 transition-colors hover:border-zinc-500 hover:bg-zinc-700 hover:text-zinc-100"
        title="Add a folder to the file browser"
        aria-label="Add a folder to the file browser"
        @click="browser.addFolder()"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="currentColor"
          class="h-4 w-4"
          aria-hidden="true"
        >
          <path d="M10 4H4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V8a2 2 0 00-2-2h-8l-2-2zm3 6v2h2v2h-2v2h-2v-2H9v-2h2v-2h2z" />
        </svg>
      </button>
    </div>

    <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
      <!-- Outside the scroller so what is playing is never lost to scrolling or
           a filter. The file also stays listed in its own folder. -->
      <div
        v-if="pinnedAudition"
        class="shrink-0 border-b border-zinc-800 bg-zinc-900/60 py-0.5"
      >
        <FileBrowserFileRow
          :row="pinnedAudition"
          @context-menu="openContextMenu($event.event, $event.path, 'file', false)"
        />
      </div>

      <div
        ref="treeEl"
        class="silverdaw-scroll min-h-0 flex-1 overflow-auto py-1 outline-none"
        role="tree"
        tabindex="0"
        aria-label="Browsed folders and files"
        :aria-activedescendant="activeRowId"
        data-owns-selection-keys="true"
        @scroll.passive="onTreeScroll"
        @keydown.down.prevent.stop="browser.selectStep(1)"
        @keydown.up.prevent.stop="browser.selectStep(-1)"
        @keydown.enter.prevent.stop="browser.activateSelected()"
        @keydown.delete.prevent.stop="browser.removeSelectedFolder()"
      >
        <p
          v-if="roots.length === 0"
          class="px-3 py-4 text-xs text-zinc-500"
        >
          No folders added yet. Use the folder button to add one.
        </p>
        <p
          v-else-if="filterHidesEverything"
          class="px-3 py-4 text-xs text-zinc-500"
        >
          No files match this filter.
        </p>

        <template
          v-for="row in rows"
          :key="row.path"
        >
          <div
            v-if="row.kind === 'directory'"
            :id="rowDomId(row.path)"
            class="flex h-7 cursor-pointer items-center gap-1.5 rounded pr-2 text-xs text-zinc-300 hover:bg-zinc-800/60"
            :class="browser.selectedPath === row.path ? 'bg-sky-500/15' : ''"
            :style="{ paddingLeft: fileBrowserRowIndentPx(row.depth) + 'px' }"
            role="treeitem"
            :aria-level="row.depth + 1"
            :aria-selected="browser.selectedPath === row.path"
            :data-selected="browser.selectedPath === row.path"
            :aria-expanded="row.expanded"
            @click="onFolderClick(row.path)"
            @contextmenu.prevent.stop="openContextMenu($event, row.path, 'directory', row.isRoot)"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="currentColor"
              class="h-3 w-3 shrink-0 text-zinc-500 transition-transform"
              :class="row.expanded ? 'rotate-0' : '-rotate-90'"
              aria-hidden="true"
            >
              <path d="M7 10l5 5 5-5H7z" />
            </svg>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="currentColor"
              class="h-3.5 w-3.5 shrink-0"
              :class="row.isRoot ? 'text-zinc-400' : 'text-zinc-500'"
              aria-hidden="true"
            >
              <path d="M10 4H4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V8a2 2 0 00-2-2h-8l-2-2z" />
            </svg>
            <span
              class="truncate"
              :class="
                row.isRoot
                  ? browser.selectedPath === row.path
                    ? 'font-semibold text-sky-200'
                    : 'font-semibold text-zinc-200'
                  : 'text-zinc-300'
              "
              :title="row.path"
            >{{ row.name }}</span>
            <!-- Indexing a large folder takes seconds; the tree fills in as it
                 goes, so the row says what is still happening rather than
                 leaving a half-populated folder looking finished. -->
            <template v-if="browser.indexLabel(row.path) !== null">
              <span
                class="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-zinc-700 border-t-sky-400"
                aria-hidden="true"
              />
              <span
                class="truncate text-[11px] tabular-nums text-zinc-500"
                role="status"
              >{{ browser.indexLabel(row.path) }}</span>
            </template>
          </div>

          <FileBrowserFileRow
            v-else
            :id="rowDomId(row.path)"
            :row="row"
            @context-menu="openContextMenu($event.event, $event.path, 'file', false)"
          />
        </template>
      </div>
    </div>

    <ClipContextMenu
      :open="contextMenu !== null"
      :x="contextMenu?.x ?? 0"
      :y="contextMenu?.y ?? 0"
      :items="contextMenuItems"
      @close="closeContextMenu"
      @command="onContextMenuCommand"
    />
  </div>
</template>

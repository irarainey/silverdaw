import { computed, nextTick, onBeforeUnmount, onMounted, ref, toRef, type Ref } from 'vue'
import { buildMenus, type MenuItemDef } from '@/menu'
// The 32x32 variant displays cleanly at the 16-px title-bar size on
// both 100% and 200%-DPI displays. Vite turns the import into a
// hashed-URL static asset at build time.
import iconUrl from '@resources/icons/32x32.png'
import { DEFAULT_PROJECT_NAME, useProjectStore } from '@/stores/projectStore'
import { useAppStore } from '@/stores/appStore'

export type AppTitleBarProps = {
  windowControlsDisabled?: boolean
}

export function useAppTitleBarController(
  props: Readonly<AppTitleBarProps>,
  root: Ref<HTMLElement | null>,
  renameInput: Ref<HTMLInputElement | null>
) {
  const project = useProjectStore()
  const appStore = useAppStore()
  const windowControlsDisabled = toRef(props, 'windowControlsDisabled')

  // True when any track has at least one clip. Drives the
  // File ▸ Export Mixdown enabled state — there's nothing to render on
  // an empty project.
  const hasAnyClip = computed(() =>
    project.tracks.some((track) => track.clipIds.length > 0)
  )

  // Menu list is rebuilt whenever `devToolsEnabled` flips. In practice the flag
  // is a startup snapshot so this is computed once, but `computed` keeps
  // the dependency wiring honest without any extra cost.
  const visibleMenus = computed(() =>
    buildMenus({
      devToolsEnabled: appStore.devToolsEnabled,
      loggingEnabled: appStore.loggingEnabled,
      recentProjects: appStore.recentProjects,
      hasAnyClip: hasAnyClip.value
    })
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

  const renaming = ref(false)
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
    // Recent Projects entries don't need to involve main — the renderer
    // already owns the MRU mirror (appStore.recentProjects) and the
    // open-project flow (App.vue handleMenuAction). Forward them as
    // synthetic actions on the same `menu:action` channel so App.vue
    // sees a single dispatch point.
    window.silverdaw.menuAction(item.action)
  }

  function minimizeWindow(): void {
    window.silverdaw.minimizeWindow()
  }

  function toggleMaximizeWindow(): void {
    window.silverdaw.toggleMaximizeWindow()
  }

  function requestCloseWindow(): void {
    window.silverdaw.closeWindow()
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

  return {
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
  }
}

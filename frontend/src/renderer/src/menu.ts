// Menu bar definitions used by the custom title bar.
// `action` IDs are sent to the main process via window.silverdaw.menuAction().

import {
  ZOOM_PRESET_PX_PER_SECOND,
  zoomPercentLabel,
  zoomPresetAction
} from '@/lib/timeline/zoomPresets'

export interface MenuItemDef {
  /** Visible label, or `null` for a separator. */
  label: string | null
  /** Action ID handled in the main process; omitted for separators
   *  and for parent items that own a `submenu`. */
  action?: string
  /** Display-only keyboard shortcut hint, e.g. "Ctrl+S". */
  accelerator?: string
  /** Disable the item (greyed out). */
  disabled?: boolean
  /** Optional secondary text shown right-aligned next to the label
   *  (e.g. the file path for a recent-projects entry). Independent of
   *  `accelerator`. */
  hint?: string
  /** Nested submenu items. When present, the entry renders as a
   *  flyout parent (with a `▸` chevron); clicking / hovering opens
   *  the submenu to the right rather than firing an action. */
  submenu?: MenuItemDef[]
}

export interface MenuDef {
  label: string
  items: MenuItemDef[]
}

const SEP: MenuItemDef = { label: null }

/** Options that influence which menus are visible. */
export interface BuildMenusOptions {
  /**
   * When true, append a "Debug" menu containing DevTools actions. Sourced
   * from the startup-snapshot developer preference in `appStore`.
   */
  devToolsEnabled: boolean
  /**
   * Recent Projects MRU, head = most recent. Surfaced under
   * File > Recent Projects ▸ as a flyout submenu. The Start Screen
   * lists the same MRU in full as a parallel entry point.
   */
  recentProjects?: string[]
  /**
   * True when the project has at least one clip on at least one
   * track. Gates **File ▸ Export Mixdown** — there's nothing to
   * render on an empty project. Defaults to false so first-launch
   * menus render the item disabled.
   */
  hasAnyClip?: boolean
}

/** Max number of recent-project entries surfaced in the File menu. The
 *  Start Screen lists the full MRU; the menu is just a quick path. */
const MAX_RECENT_IN_MENU = 10

function basename(path: string): string {
  const lastSep = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return lastSep >= 0 ? path.slice(lastSep + 1) : path
}

function buildRecentProjectsSubmenu(paths: string[]): MenuItemDef[] {
  if (paths.length === 0) {
    return [{ label: 'No recent projects', disabled: true }]
  }
  const items: MenuItemDef[] = paths.map((path, index) => ({
    label: basename(path),
    // Encode the index, not the path — Windows paths contain `\` and
    // `:`, which would collide with any path-parsing scheme.
    action: `file.openRecentByIndex:${index}`,
    hint: path
  }))
  items.push(SEP)
  items.push({ label: 'Clear Recent Projects', action: 'file.clearRecentProjects' })
  return items
}

/**
 * Build the menu bar for the current session. Called by `AppTitleBar`
 * and `menuShortcuts.registerMenuShortcuts()` with the same `devToolsEnabled`
 * snapshot so both consumers see a consistent set of menus + accelerators.
 */
export function buildMenus(opts: BuildMenusOptions): MenuDef[] {
  const recents = (opts.recentProjects ?? []).slice(0, MAX_RECENT_IN_MENU)
  const recentMenuItem: MenuItemDef = {
    label: 'Recent Projects',
    submenu: buildRecentProjectsSubmenu(recents)
  }

  const menus: MenuDef[] = [
    {
      label: 'File',
      items: [
        { label: 'New Project', action: 'file.newProject', accelerator: 'Ctrl+N' },
        { label: 'Open Project\u2026', action: 'file.openProject', accelerator: 'Ctrl+O' },
        recentMenuItem,
        SEP,
        { label: 'Save', action: 'file.save', accelerator: 'Ctrl+S' },
        { label: 'Save As\u2026', action: 'file.saveAs', accelerator: 'Ctrl+Shift+S' },
        SEP,
        { label: 'Project Properties\u2026', action: 'file.projectProperties' },
        SEP,
        { label: 'Add Track\u2026', action: 'file.addTrack', accelerator: 'Ctrl+T' },
        {
          label: 'Export Mixdown\u2026',
          action: 'file.exportMixdown',
          accelerator: 'Ctrl+M',
          disabled: opts.hasAnyClip !== true
        },
        SEP,
        { label: 'Exit', action: 'file.exit', accelerator: 'Ctrl+E' }
      ]
    },
    {
      label: 'Edit',
      items: [
        { label: 'Undo', action: 'edit.undo', accelerator: 'Ctrl+Z' },
        { label: 'Redo', action: 'edit.redo', accelerator: 'Ctrl+Y' },
        SEP,
        { label: 'Cut', action: 'edit.cut', accelerator: 'Ctrl+X' },
        { label: 'Copy', action: 'edit.copy', accelerator: 'Ctrl+C' },
        { label: 'Paste', action: 'edit.paste', accelerator: 'Ctrl+V' },
        SEP,
        { label: 'Split Clip at Playhead', action: 'edit.splitAtPlayhead', accelerator: 'S' },
        { label: 'Duplicate Clip', action: 'edit.duplicateClip', accelerator: 'D' },
        { label: 'Delete Clip', action: 'edit.deleteClip', accelerator: 'Delete' },
        SEP,
        { label: 'Trim Project to Last Clip', action: 'edit.cropProjectToLastClip' },
        SEP,
        { label: 'Preferences\u2026', action: 'edit.preferences' }
      ]
    },
    {
      label: 'View',
      items: [
        // Zoom In / Out / Reset are display-only accelerators here — the
        // global handler in App.vue owns the keys (it needs '+'/'='/numpad
        // parsing the '+'-delimited accelerator grammar can't express, plus
        // the modal / editable-target guards). `menuShortcuts` deliberately
        // skips binding them (see GLOBAL_SHORTCUT_ACTIONS) so they can't
        // double-fire.
        { label: 'Zoom In', action: 'view.zoomIn', accelerator: 'Ctrl++' },
        { label: 'Zoom Out', action: 'view.zoomOut', accelerator: 'Ctrl+-' },
        { label: 'Reset Zoom', action: 'view.zoomReset', accelerator: 'Ctrl+0' },
        {
          label: 'Zoom Presets',
          submenu: ZOOM_PRESET_PX_PER_SECOND.map((px) => ({
            label: zoomPercentLabel(px),
            action: zoomPresetAction(px)
          }))
        },
        SEP,
        { label: 'Toggle Full Screen', action: 'view.toggleFullScreen', accelerator: 'F11' }
      ]
    },
    {
      label: 'Help',
      items: [
        { label: 'Documentation', action: 'help.docs' },
        { label: 'Report an Issue', action: 'help.reportIssue' },
        SEP,
        { label: 'About Silverdaw', action: 'help.about' }
      ]
    }
  ]

  if (opts.devToolsEnabled) {
    // Hidden by default; appears only when "Show Developer Tools" is on.
    // Inserted just before Help so Help stays the rightmost menu and
    // the Debug option reads as a developer add-on rather than core UX.
    menus.splice(menus.length - 1, 0, {
      label: 'Debug',
      items: [
        { label: 'Toggle Developer Tools', action: 'view.toggleDevTools', accelerator: 'F12' }
      ]
    })
  }

  return menus
}

// Menu bar definitions used by the custom title bar.
// `action` IDs are sent to the main process via window.silverdaw.menuAction().

export interface MenuItemDef {
  /** Visible label, or `null` for a separator. */
  label: string | null
  /** Action ID handled in the main process; omitted for separators. */
  action?: string
  /** Display-only keyboard shortcut hint, e.g. "Ctrl+S". */
  accelerator?: string
  /** Disable the item (greyed out). */
  disabled?: boolean
  /** Optional secondary text shown right-aligned next to the label
   *  (e.g. the file path for a recent-projects entry). Independent of
   *  `accelerator`. */
  hint?: string
}

export interface MenuDef {
  label: string
  items: MenuItemDef[]
}

const SEP: MenuItemDef = { label: null }

/** Options that influence which menus are visible. */
export interface BuildMenusOptions {
  /**
   * When true, append a "Debug" menu containing developer-only items
   * (Toggle Developer Tools, future log/profile helpers). Sourced from
   * the startup-snapshot debug flag in `appStore`.
   */
  debugMode: boolean
  /**
   * Recent Projects MRU, head = most recent. Up to 5 entries are
   * rendered as flat items inside the File menu (the menu engine
   * doesn't currently model nested submenus); the remainder are
   * accessible from the Start Screen.
   */
  recentProjects?: string[]
}

/** Max number of recent-project entries surfaced in the File menu. The
 *  Start Screen lists the full MRU; the menu is just a quick path. */
const MAX_RECENT_IN_MENU = 5

function basename(path: string): string {
  const lastSep = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return lastSep >= 0 ? path.slice(lastSep + 1) : path
}

/**
 * Build the menu bar for the current session. Called by `AppTitleBar`
 * and `menuShortcuts.registerMenuShortcuts()` with the same `debugMode`
 * snapshot so both consumers see a consistent set of menus + accelerators.
 */
export function buildMenus(opts: BuildMenusOptions): MenuDef[] {
  const recents = (opts.recentProjects ?? []).slice(0, MAX_RECENT_IN_MENU)
  const recentItems: MenuItemDef[] = []
  if (recents.length > 0) {
    recentItems.push(SEP)
    recents.forEach((path, index) => {
      recentItems.push({
        label: basename(path),
        // Encode the index, not the path — Windows paths contain `\` and
        // `:`, which would collide with any path-parsing scheme.
        action: `file.openRecentByIndex:${index}`,
        hint: path
      })
    })
    recentItems.push({ label: 'Clear Recent', action: 'file.clearRecentProjects' })
  }

  const menus: MenuDef[] = [
    {
      label: 'File',
      items: [
        { label: 'New Project', action: 'file.newProject', accelerator: 'Ctrl+N' },
        { label: 'Open Project...', action: 'file.openProject', accelerator: 'Ctrl+O' },
        ...recentItems,
        SEP,
        { label: 'Save', action: 'file.save', accelerator: 'Ctrl+S' },
        { label: 'Save As...', action: 'file.saveAs', accelerator: 'Ctrl+Shift+S' },
        { label: 'Rename Project...', action: 'file.renameProject', accelerator: 'F2' },
        SEP,
        { label: 'Add Track', action: 'file.addTrack', accelerator: 'Ctrl+T' },
        { label: 'Export Mixdown...', action: 'file.exportMixdown', disabled: true },
        SEP,
        { label: 'Exit', action: 'file.exit' }
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
        { label: 'Preferences...', action: 'edit.preferences' }
      ]
    },
    {
      label: 'View',
      items: [{ label: 'Toggle Full Screen', action: 'view.toggleFullScreen', accelerator: 'F11' }]
    },
    {
      label: 'Help',
      items: [
        { label: 'Documentation', action: 'help.docs' },
        { label: 'Report an Issue...', action: 'help.reportIssue' },
        SEP,
        { label: 'About Silverdaw', action: 'help.about' }
      ]
    }
  ]

  if (opts.debugMode) {
    // Hidden by default; appears only when "Enable Debugging" is on.
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

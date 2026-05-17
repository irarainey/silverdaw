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
}

/**
 * Build the menu bar for the current session. Called by `AppTitleBar`
 * and `menuShortcuts.registerMenuShortcuts()` with the same `debugMode`
 * snapshot so both consumers see a consistent set of menus + accelerators.
 */
export function buildMenus(opts: BuildMenusOptions): MenuDef[] {
  const menus: MenuDef[] = [
    {
      label: 'File',
      items: [
        { label: 'New Project', action: 'file.newProject', accelerator: 'Ctrl+N' },
        { label: 'Open Project...', action: 'file.openProject', accelerator: 'Ctrl+O' },
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

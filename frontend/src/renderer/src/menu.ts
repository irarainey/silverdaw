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

export const menus: MenuDef[] = [
  {
    label: 'File',
    items: [
      { label: 'New Project', action: 'file.newProject', accelerator: 'Ctrl+N' },
      { label: 'Open Project...', action: 'file.openProject', accelerator: 'Ctrl+O' },
      SEP,
      { label: 'Save', action: 'file.save', accelerator: 'Ctrl+S' },
      { label: 'Save As...', action: 'file.saveAs', accelerator: 'Ctrl+Shift+S' },
      SEP,
      { label: 'Add Track', action: 'file.addTrack', accelerator: 'Ctrl+T' },
      { label: 'Export Mixdown...', action: 'file.exportMixdown' },
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
    items: [
      { label: 'Toggle Developer Tools', action: 'view.toggleDevTools', accelerator: 'F12' },
      SEP,
      { label: 'Toggle Full Screen', action: 'view.toggleFullScreen', accelerator: 'F11' }
    ]
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

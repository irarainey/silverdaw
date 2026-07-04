// Menu bar definitions; `action` IDs route through window.silverdaw.menuAction().

import {
  ZOOM_PRESET_PX_PER_SECOND,
  zoomPercentLabel,
  zoomPresetAction
} from '@/lib/timeline/zoomPresets'
import { projectNameFromPath } from '@/lib/project/projectPath'
import type { RecentProject } from '@shared/types'

export interface MenuItemDef {
  /** Visible label, or `null` for a separator. */
  label: string | null
  /** Action ID; omitted for separators and submenu parents. */
  action?: string
  /** Display-only keyboard shortcut hint, e.g. "Ctrl+S". */
  accelerator?: string
  disabled?: boolean
  /** Secondary right-aligned text, independent of `accelerator`. */
  hint?: string
  /** Nested flyout submenu items. */
  submenu?: MenuItemDef[]
}

export interface MenuDef {
  label: string
  items: MenuItemDef[]
}

const SEP: MenuItemDef = { label: null }

/** Options that influence which menus are visible. */
export interface BuildMenusOptions {
  /** Append the developer Debug menu. */
  devToolsEnabled: boolean
  /** Recent Projects MRU, head = most recent. */
  recentProjects?: RecentProject[]
  /** Gates File > Export Mixdown until there is audio to render. */
  hasAnyClip?: boolean
}

/** Recent-project entries shown in the quick File-menu path. */
const MAX_RECENT_IN_MENU = 10

function buildRecentProjectsSubmenu(recents: RecentProject[]): MenuItemDef[] {
  if (recents.length === 0) {
    return [{ label: 'No recent projects', disabled: true }]
  }
  const items: MenuItemDef[] = recents.map((recent, index) => ({
    label: recent.name || projectNameFromPath(recent.path),
    // Encode the index because Windows paths collide with action separators.
    action: `file.openRecentByIndex:${index}`,
    hint: recent.path
  }))
  items.push(SEP)
  items.push({ label: 'Clear Recent Projects', action: 'file.clearRecentProjects' })
  return items
}

/** Build menus shared by the title bar and shortcut registration. */
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
        // Display-only accelerators; App.vue owns zoom keys and modal guards.
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
        { label: 'Give Feedback', action: 'help.reportIssue' },
        SEP,
        { label: 'About Silverdaw', action: 'help.about' }
      ]
    }
  ]

  if (opts.devToolsEnabled) {
    // Keep Help rightmost; Debug appears only when developer tools are enabled.
    menus.splice(menus.length - 1, 0, {
      label: 'Debug',
      items: [
        { label: 'Toggle Developer Tools', action: 'view.toggleDevTools', accelerator: 'F12' }
      ]
    })
  }

  return menus
}

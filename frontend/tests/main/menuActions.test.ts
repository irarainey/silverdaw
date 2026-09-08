// Every action the renderer's own menu can emit must be routed by main.
//
// The title bar is renderer-drawn, but a click still round-trips through main on
// the IPC.menu.action channel, so an action main does not recognise is dropped
// with only a log line — a menu item that silently does nothing. That is exactly
// how File ▸ Record Audio… shipped dead, so the whole menu definition is swept
// here rather than each new item being remembered one at a time.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const send = vi.fn()

vi.mock('electron', () => ({
  app: { getVersion: () => '1.8.0', quit: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
  shell: { openExternal: vi.fn() }
}))

import { handleMenuAction } from '@main/menu'
import { buildMenus, type MenuItemDef } from '@/menu'

function collectActions(items: readonly MenuItemDef[]): string[] {
  return items.flatMap((item) => [
    ...(item.action ? [item.action] : []),
    ...(item.submenu ? collectActions(item.submenu) : [])
  ])
}

const ctx = {
  getMainWindow: () =>
    ({
      webContents: { send, openDevTools: vi.fn(), isDevToolsOpened: () => false, closeDevTools: vi.fn() },
      isFullScreen: () => false,
      setFullScreen: vi.fn()
    }) as never,
  startupDevToolsEnabled: false,
  confirmClose: vi.fn()
}

describe('main menu action routing', () => {
  beforeEach(() => {
    send.mockClear()
  })

  it('routes every action the renderer menu can emit', () => {
    const menus = buildMenus({
      devToolsEnabled: true,
      loggingEnabled: true,
      recentProjects: [{ name: 'One', path: 'C:/projects/One.silverdaw' }],
      hasAnyClip: true
    })
    const actions = menus.flatMap((menu: { items: readonly MenuItemDef[] }) =>
      collectActions(menu.items)
    )
    expect(actions).toContain('file.recordAudio')

    // Handled entirely in main (window control, or an external link), so they
    // never reach the renderer.
    const handledInMain = new Set([
      'file.exitConfirmed',
      'app.confirmClose',
      'view.toggleDevTools',
      'view.toggleFullScreen',
      'help.docs',
      'help.shortcuts',
      'help.reportIssue'
    ])

    const dropped = actions.filter((action) => {
      send.mockClear()
      handleMenuAction(action, ctx)
      return !handledInMain.has(action) && send.mock.calls.length === 0
    })
    expect(dropped).toEqual([])
  })
})

import { describe, expect, it } from 'vitest'
import { buildMenus, type MenuItemDef } from './menu'
import {
  ZOOM_PRESET_PX_PER_SECOND,
  parseZoomPresetAction,
  zoomPercentLabel
} from '@/lib/timeline/zoomPresets'

function viewMenu(): MenuItemDef[] {
  const menus = buildMenus({ devToolsEnabled: false })
  const view = menus.find((m) => m.label === 'View')
  expect(view).toBeDefined()
  return view!.items
}

describe('View menu — zoom controls', () => {
  it('exposes Zoom In / Out / Reset with display accelerators', () => {
    const items = viewMenu()
    const byAction = (action: string): MenuItemDef | undefined =>
      items.find((i) => i.action === action)

    expect(byAction('view.zoomIn')).toMatchObject({ label: 'Zoom In', accelerator: 'Ctrl++' })
    expect(byAction('view.zoomOut')).toMatchObject({ label: 'Zoom Out', accelerator: 'Ctrl+-' })
    expect(byAction('view.zoomReset')).toMatchObject({ label: 'Reset Zoom', accelerator: 'Ctrl+0' })
  })

  it('exposes a Zoom Presets submenu matching the preset source of truth', () => {
    const presets = viewMenu().find((i) => i.label === 'Zoom Presets')
    expect(presets?.submenu).toBeDefined()
    const sub = presets!.submenu!

    expect(sub).toHaveLength(ZOOM_PRESET_PX_PER_SECOND.length)
    ZOOM_PRESET_PX_PER_SECOND.forEach((px, index) => {
      const item = sub[index]
      expect(item).toBeDefined()
      expect(item!.label).toBe(zoomPercentLabel(px))
      // Each submenu action must decode back to the exact preset px value.
      expect(parseZoomPresetAction(item!.action ?? '')).toBe(px)
    })
  })

  it('still offers Toggle Full Screen', () => {
    expect(viewMenu().some((i) => i.action === 'view.toggleFullScreen')).toBe(true)
  })
})

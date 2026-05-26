// Shared type for the timeline's clip context menu. Lives in the
// timeline lib so both `ClipContextMenu.vue` (the renderer) and
// `useTimelineContextMenu.ts` (the builder) can import it without
// the lib depending on a component.

export interface ClipContextMenuItem {
  /** Action token forwarded to the parent on click. */
  command: string
  label: string
  /** When true, the item renders muted and isn't clickable. */
  disabled?: boolean
  /** Visual rule below the previous item. */
  separatorAbove?: boolean
  /** When provided, the item renders as a label above an inline grid
   *  of colour swatches instead of a clickable row. Picking a swatch
   *  fires `command` with the chosen palette index appended to the
   *  string: e.g. `clip.color:3`. The currently-selected swatch (when
   *  `selectedSwatch` matches its index) is highlighted. */
  swatches?: ReadonlyArray<{ cssHex: string; label?: string }>
  /** Palette index to outline as the current selection inside `swatches`. */
  selectedSwatch?: number
}

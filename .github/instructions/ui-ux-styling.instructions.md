---
description: "Silverdaw UI/UX styling and language conventions — colours, surfaces, spacing, dialogs, focus handling and user-facing wording for the Electron + Vue renderer"
applyTo: "frontend/src/renderer/**/*.vue, frontend/src/renderer/**/*.css"
---

# Silverdaw UI/UX Styling Instructions

Conventions that keep the renderer visually and verbally consistent. The app is
a **dark, flat, dense, keyboard-friendly** desktop DAW built for beginner-first
simplicity (see ADR 0011; this file is the detailed reference behind ADR 0012).
Match the patterns already in the codebase — do not introduce new colour
families, component frames, or wording styles without updating this file first.

Tailwind CSS **v4** is used (utility classes in templates; no `tailwind.config`
— theme tokens are standard Tailwind palette names). Shared primitives live in
`frontend/src/renderer/src/assets/style.css`.

## 0. Golden rule — reuse the shared primitives

Before hand-rolling chrome, use the existing component classes from
`style.css` (`@layer components`):

- `.dialog-backdrop`, `.dialog-card`, `.dialog-header`, `.dialog-title`,
  `.dialog-body`, `.dialog-footer`
- `.dialog-btn-primary`, `.dialog-btn-cancel`, `.dialog-btn-destructive`
- `.app-select` (+ `.app-select-dense`) — every native dropdown

If a visual needs to change globally, **edit `style.css` once** rather than
overriding per-component. Add a new shared class there when a pattern repeats in
3+ components.

## 1. Colour system

Silverdaw uses exactly **one neutral ramp**, **one interactive accent**, and a
**small fixed severity set**. Never reach for `gray`, `slate`, `neutral`,
`blue`, `cyan`, `indigo`, `violet`, `teal`, `green`, `orange`, etc.

| Role | Palette | Typical tokens | Notes |
| --- | --- | --- | --- |
| Neutral surfaces & text | `zinc` | `zinc-950 900 800 700 / 100 200 300 400 500` | The entire UI skeleton. |
| Interactive accent (focus, selection, inline links, sliders, action buttons) | `sky` | `sky-400 500 600`, tints `sky-500/15`, `sky-600/30`, text `sky-200` | The "active/selected/has-focus" colour, and the fill for primary/action buttons. |
| Success / positive / "connected" | `emerald` | `emerald-400 500` | Status dots, completion ticks, drop indicators. |
| Warning / caution / advisory | `amber` | `amber-200 300 400`, `amber-900/30` bg, `amber-700` border | Variable-tempo, unsupported sample rate, soft warnings. |
| Destructive / error | `red` | `red-600 700` via `.dialog-btn-destructive`; `red-400` text | Irreversible actions and hard errors only. |

Rules:

- **One blue only.** `sky` is the sole interactive accent — focus/selection/
  active states, sliders, inline links, and every action button (including the
  dialog footer primary via `.dialog-btn-primary`). There is **no** second blue;
  `cyan` is retired. Button hierarchy is carried by emphasis, not hue: the
  primary action is a **filled** `sky` button, secondary/Cancel is a **neutral
  zinc** ghost (`.dialog-btn-cancel`).
- **Severity is content, not chrome.** Dialog frames stay neutral `zinc`; convey
  warning/error through body content (an `amber`/`red` inline box), never by
  recolouring the `.dialog-card` border.
- Reserve `red` for genuinely destructive/irreversible choices and real errors.
  A plain Cancel/Close is `.dialog-btn-cancel` (neutral zinc), never red.
- **One deliberate exception — categorical data-viz.** Two palettes
  intentionally span the full colour wheel (including otherwise-forbidden
  families) so that each entry is distinguishable: the musical key badges
  (`lib/keyBadge.ts`) and the user-selectable track colours (`TRACK_PALETTE` in
  `stores/projectTypes.ts`). This is categorical encoding, not chrome — the "one
  accent" rule does not apply to either. Do not fold them into `sky`.

## 2. Surfaces & elevation

| Surface | Background |
| --- | --- |
| App shell / timeline backdrop | `zinc-950` |
| Panels & dialog cards | `zinc-900` (one step lighter than the shell) |
| Inset inputs / fields / wells | `zinc-950` with a `zinc-700` (or `zinc-600`) border (dropdowns are the exception — see §5) |
| Hover row / subtle raised chip | `zinc-800` |
| Dividers / hairlines | `border-zinc-800` |

Elevation is done with **shadow + a 1px hairline**, not solid borders. Dialog
cards use the stacked `box-shadow` defined on `.dialog-card` (soft drop shadow +
contact shadow + top white-6%-α rim). Do not add a visible 1px solid frame to
floating surfaces — it fights the panel look.

## 3. Dialogs

- Compose every modal from the `.dialog-*` primitives. Markup order:
  `.dialog-backdrop > .dialog-card > (.dialog-header > .dialog-title) +
  .dialog-body + .dialog-footer`.
- **Footer layout:** right-aligned, `justify-end gap-2`. Order left→right is
  **secondary (Cancel) then primary** (`.dialog-btn-cancel` then
  `.dialog-btn-primary`). A destructive confirm replaces the primary with
  `.dialog-btn-destructive`.
- Gate the primary button with `:disabled` when the form is invalid — the
  disabled styling is already baked into `.dialog-btn-primary`.
- **`Enter` accepts the dialog.** `useDialogDefaultButton` (installed once in
  `App.vue`) finds the topmost dialog's footer `.dialog-btn-primary` and clicks
  it, so *do not* add per-dialog `@keydown.enter` handlers or
  `@keydown.enter.prevent` on individual inputs — they duplicate the shared
  behaviour and bypass the `:disabled` gate. A dialog that genuinely needs a
  different `Enter` can claim the key with `preventDefault()`; the shared
  handler stands down. A dialog with no single safe accept (progress, per-row
  actions) simply carries no primary button.
- **`Escape` cancels**, and is still wired per dialog because what "cancel"
  discards is dialog-specific.
- **Avoid modal dialogs for common actions** (plan §2). Prefer inline editing,
  contextual panels, and right-click menus. Reserve dialogs for genuinely
  transactional or destructive flows (Export, Preferences, Save-As, Discard).

## 4. Buttons

- **Inside dialogs:** always the three shared classes above.
- **Standalone action buttons** (start screen, inline panel actions) follow the
  established pattern: `rounded bg-sky-600 px-4 py-2 text-sm font-medium
  text-zinc-50 hover:bg-sky-500` for primary; `bg-zinc-800 hover:bg-zinc-700
  text-zinc-200` for neutral; `bg-red-700 hover:bg-red-600` for destructive.
- Sizing: dialog buttons `px-3 py-1.5 text-xs`; prominent overlay buttons
  `px-4 py-2 text-sm`; dense inline buttons `px-3 py-1 text-[11px]`.
- Always include a `hover:` state. Use `font-medium` for emphasis; never bold
  (`font-bold`) for buttons.

## 5. Form controls

Canonical text/number input:

```html
class="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-100 outline-none focus:border-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
```

- **Native `<select>`:** never hand-roll the classes — use the shared
  `.app-select` primitive, plus `.app-select-dense` in tight chrome (the status
  bar, an automation lane header). It carries the same border, radius and focus
  treatment as the input above, but also strips the platform chrome with
  `appearance-none`, inherits the app font (a native select does **not** by
  default, which is why an unstyled one reads oversized), draws its own chevron,
  and puts the popup list on the same surface as the closed field. Only sizing
  (`w-full`, `w-32`, `flex-1`) and any deliberate accent recolouring go on the
  element as utilities.
- **Dropdowns sit on `zinc-900`, not the `zinc-950` well** — the one deliberate
  exception to the rule below. A `<select>` is a *chooser*, not a typing
  surface, so it takes the lighter panel colour (the library panel background)
  and lets its border and chevron carry the affordance. Its option list matches,
  so the control reads as one surface open or shut.
- **A dropdown in app chrome must release focus after a choice** — call `blur()`
  in its `@change` handler (see `StatusBar.vue` and
  `TrackAutomationLaneHeaders.vue`). A native select keeps focus once used, and a
  focused select swallows the global keyboard shortcuts, so leaving it focused
  silently breaks the keyboard until the user clicks elsewhere. Dropdowns inside
  a dialog are exempt: shortcuts are already suppressed there and `Tab` order
  should be preserved.
- **Numeric / time / value fields:** add `font-mono text-right` and
  `tabular-nums` for alignment; use the `no-spinner` class to hide native number
  spinners.
- **Checkboxes / radios / native range:** tint with `accent-sky-500` (or
  `accent-sky-400` for the master volume slider).
- **Choosing between a small fixed set of options** (a preference, a mode): use
  the **radio-card list** pattern — a `<label>` per option in a `space-y-2`
  column. **Canonical card:**

  ```html
  <label class="flex cursor-pointer items-center gap-3 rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2.5">
    <input v-model="…" type="radio" name="…" value="…" class="h-4 w-4 shrink-0 cursor-pointer accent-sky-500">
    <span class="min-w-0 flex-1 truncate leading-tight">
      <span class="font-medium text-zinc-200">Label</span>
      <span class="text-zinc-500"> — short description</span>
    </span>
  </label>
  ```

  Rules for these cards:
  - **Label and description share one line** — `Label — description`, label
    `font-medium text-zinc-200`, description `text-zinc-500`, never stacked on
    separate `block` lines. The text span is `min-w-0 flex-1 truncate` so it
    stays a single row.
  - **Keep the description short** (a few words) so the whole card stays **one
    line tall** — if it can't be said in a short phrase, it doesn't belong in the
    description; trim it or move detail to the section's intro paragraph.
  - Card chrome is fixed: `rounded-md` corners and `px-3 py-2.5` padding (a
    comfortable, not cramped, row). The radio input is
    `h-4 w-4 shrink-0 cursor-pointer accent-sky-500`.
  - This is the single standard for option pickers in settings/preferences —
    **do not** use a native `<select>` dropdown there (it also drags in the
    browser focus ring; see §6). Reserve native `<select>` for long or dynamic
    lists (e.g. device pickers, many sample rates) and still style it with
    `.app-select` (§5).
  - A bare radio row with only a label (no description) keeps the same chrome and
    just drops the description span.
- **Disabled:** `disabled:opacity-50` (or `disabled:opacity-40` in dense panels)
  plus `disabled:cursor-not-allowed`; never just hide the control.
- Text, number and other typing fields sit on `zinc-950` even inside a
  `zinc-900` panel — the darker well is the "editable" signal. Dropdowns are the
  exception (see above).

## 6. Focus handling — no browser focus rings

The default browser focus ring is **never** used. This is a hard rule. In
Electron its default appearance is a **white/orange (outline) ring** — if you
ever see that on a control, the control is wrong and must be fixed.

- Every focusable element pairs `outline-none` (or `focus:outline-none`).
  Indicate focus by **recolouring the border to the accent**:
  `focus:border-sky-500`. Wrapper groups may use `focus-within:border-sky-500`.
- **Native `<select>` is the most common offender** — it does NOT inherit a
  global reset, so it must carry `outline-none focus:border-sky-500`. Using
  `.app-select` (§5) covers this; a bare `<select>` without `outline-none` shows
  the white/orange ring and is a bug. Do not tint a select with `accent-*`;
  `accent` only applies to checkbox/radio/range.
- Custom range sliders strip the outline entirely
  (`outline-none focus:outline-none focus-visible:outline-none`) and style the
  thumb directly (see `FxRangeControl.vue` `.fx-range-input`, and
  `ClipEditorPitchPanel.vue` `.pitch-range-input`).
- **Narrow exception:** a deliberate `focus:ring-2 focus:ring-sky-400`
  (or `ring-red-400` on a destructive button) is allowed **only** on prominent
  keyboard-navigable action buttons in full-screen overlays (e.g.
  `StartupScreen`, recovery/relink actions) where a visible keyboard affordance
  matters. Do not add focus rings to form fields, list rows, sliders, menu
  items, or timeline controls.

**A list that drives its own selection must claim its keys.** Both app-wide
keyboard owners (`registerMenuShortcuts` and `onGlobalShortcutKey`) listen on
`window` in the **capture** phase, so they run before your component and
`stopPropagation` cannot call them off. Mark the container
`data-owns-selection-keys="true"` — via `SELECTION_KEYS_ATTRIBUTE` in
`lib/selectionKeys.ts` — and both owners stand down for `ArrowUp`, `ArrowDown`,
`Enter`, and the `Delete` selection actions. Set the attribute only while the
list actually has a selection, so the global shortcuts are unaffected the rest
of the time. Give the list one `tabindex="0"` container rather than a tab stop
per row, so rows still need no focus ring.

## 7. Spacing & sizing

- Use the Tailwind spacing scale (0.25rem steps). Don't use arbitrary `px`
  values except the established bracket sizes for dense readouts
  (`text-[10px]`, `text-[11px]`, `py-px`).
- Dialog rhythm (already in the primitives): header `px-6 py-4`, body
  `px-6 py-5`, footer `px-6 py-3`, footer `gap-2`.
- Dense panels (track headers, library tiles, FX) go tight: `px-1`/`py-px`,
  `gap-1`/`gap-2`.
- Corners: `rounded` (0.25rem) for inputs/buttons/chips; `rounded-lg` for dialog
  cards and large surfaces; `rounded-sm` for tiny markers.

## 8. Typography

- Default UI font is the system sans stack. Use **`font-mono`** for all numeric,
  time, dB, BPM, and coordinate readouts — pair with `tabular-nums` where values
  update live so they don't jitter.
- Size ladder: `text-base` dialog titles; `text-sm` body/help/prominent buttons;
  `text-xs` the default for controls and dense UI; `text-[10px]`/`text-[11px]`
  for secondary metadata and badges.
- Titles use `font-semibold tracking-tight text-zinc-100`. Small section labels
  are often `uppercase tracking-wider` at `text-[10px]`/`text-[11px]`. Body copy
  is `text-zinc-200`/`text-zinc-300`; muted/secondary is `text-zinc-400`/
  `text-zinc-500`.

## 9. Selection & active states

Selected/active items use the `sky` accent consistently:

- Selected tab / mode toggle / track: `border-sky-500 bg-sky-500/15 text-sky-200`
  (or `bg-sky-600/30` for a stronger fill); selected track row uses
  `!border-sky-400`.
- Connection/status "good" dot: `bg-emerald-500`; idle/off: `bg-zinc-600`.
- Don't invent a second "selected" colour — accent tint + accent border + accent
  text is the pattern.

## 10. Language & terminology

User-facing copy favours the familiar, DAW-standard name for each feature — the
words the audience already meets in other tools — while avoiding the deepest
signal-processing jargon. **Reverb**, **Delay**, **Pan**, and **Compressor**
are used directly; do **not** soften them to non-standard labels like "Room",
"Echo", or "Balance" (which only add confusion). The codebase keeps matching
internal terms (plan §7.9) — note the internal DSP class behind the user-facing
**Compressor** is `Leveler`, but the UI always says "Compressor". Where a plain
word is clearer than an engineer's term, use the **left** column in the UI:

| Say (user-facing) | Not (over-technical) |
| --- | --- |
| Tone, with **Bass / Mid / Treble** | EQ / low shelf / parametric peak / high shelf |
| **Low Cut** | high-pass filter |
| **Volume Shape** | automation / envelope |

Wording rules:

- **Menu items, buttons, tab labels, dialog titles:** Title Case
  ("New Project", "Export Mixdown", "Split Clip at Playhead", "Save As").
- **Body text, help, tooltips, toasts, validation messages:** sentence case.
- **Ellipsis (`…`, the real `\u2026` char):** append to any action that opens a
  further dialog or file picker before completing ("Project Properties…",
  "Export Mixdown…", "Locate file…"). A command that acts immediately gets no
  ellipsis ("Save", "Add Track", "Delete Clip").
- Prefer plain verbs the audience knows; no DAW jargon, no abbreviations the
  user hasn't been taught. Be concise — labels are short, tooltips one line.
- Errors/warnings explain what happened and what to do next, not codes.
- Keep terminology identical across menu, context menu, panel, dialog, and
  toast for the same concept.

## 11. Before you finish

Most of this file is reference — consult the section you need. These are the
failures that actually recur, so check them explicitly:

- [ ] **No default browser focus ring.** If you can see a white/orange ring, it
      is a bug. Native `<select>` is the usual culprit (§6).
- [ ] **Palette discipline** — `zinc` + `sky` only, severity limited to
      `emerald`/`amber`/`red`, no second blue (§1).
- [ ] **Shared primitives reused,** not re-hand-rolled — `.dialog-*` and the
      button classes (§0, §3).
- [ ] **Wording** follows the terminology table and case rules, consistently
      across menu, panel, dialog, and toast (§10).
- [ ] **No modal dialog** for an action that could be inline or contextual (§3).

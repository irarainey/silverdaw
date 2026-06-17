// Clip editing domain actions for the project store.
// Spread into the store's `actions`; call sites stay `useProjectStore().X(...)`.
// `this` is the store instance, typed via the shared ProjectClipThis contract.
//
// This is a stable facade that composes the focused clip-action modules so
// importers (projectStore) keep a single `clipActions` entry point. Each module
// owns one coherent responsibility:
//   - projectClipPlacementActions   add/move/trim/overlap/ack
//   - projectClipEditActions        split/duplicate/remove
//   - projectClipClipboardActions   copy/cut/paste
//   - projectClipPropertiesActions  colour/lock/reverse/rename/peaks
//   - projectClipWarpActions        warp/pitch + volume envelope

import { clipPlacementActions } from './projectClipPlacementActions'
import { clipEditActions } from './projectClipEditActions'
import { clipClipboardActions } from './projectClipClipboardActions'
import { clipPropertiesActions } from './projectClipPropertiesActions'
import { clipWarpActions } from './projectClipWarpActions'
import type { ProjectClipThis } from './projectClipContract'

export const clipActions = {
  ...clipPlacementActions,
  ...clipEditActions,
  ...clipClipboardActions,
  ...clipPropertiesActions,
  ...clipWarpActions
} satisfies Record<string, (this: ProjectClipThis, ...args: never[]) => unknown> &
  ThisType<ProjectClipThis>

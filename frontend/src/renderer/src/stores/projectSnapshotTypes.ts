// Shared type for the project-state snapshot reconciliation modules. The snapshot
// helpers mutate this subset of the project store: state plus one sibling action.

import type { ProjectState } from './projectTypes'

/** Subset of the project store the snapshot modules mutate: state plus one sibling action. */
export type SnapshotTarget = ProjectState & {
  setProjectLengthMs(ms: number): void
}

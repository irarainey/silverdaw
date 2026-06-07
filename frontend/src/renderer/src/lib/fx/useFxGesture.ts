// Per-drag gesture-id machinery shared by every FX control in the Track FX
// panel. A continuous slider drag must collapse into one undo step, so a stable
// `gestureId` is minted on the first `input` and reused for coalesced samples
// until the gesture ends. Each gesture is scoped to one control `key` (a key
// change or gesture end mints a fresh id) so drags don't coalesce across
// controls. Callers must `endGesture()` on every exit path to avoid leaking a
// stale id.

export interface FxGesture {
  /** Returns the gesture id for `key`, minting a fresh one if the active
   *  control changed (or no gesture is open). */
  ensureGesture: (key: string) => string
  /** Clears the open gesture so the next interaction starts fresh. */
  endGesture: () => void
}

/**
 * @param prefix Short namespace for minted ids (e.g. `'tone'`, `'send'`)
 *   so logs / diagnostics can tell which surface opened a gesture.
 */
export function useFxGesture(prefix: string): FxGesture {
  let active: { key: string; id: string } | null = null

  const freshId = (): string => {
    const c = globalThis.crypto as Crypto | undefined
    return c?.randomUUID ? `${prefix}-${c.randomUUID()}` : `${prefix}-${Date.now()}-${Math.random()}`
  }

  const ensureGesture = (key: string): string => {
    if (!active || active.key !== key) {
      active = { key, id: freshId() }
    }
    return active.id
  }

  const endGesture = (): void => {
    active = null
  }

  return { ensureGesture, endGesture }
}

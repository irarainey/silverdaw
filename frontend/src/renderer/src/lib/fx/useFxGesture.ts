// Per-drag gesture-id machinery shared by every FX control in the Track FX
// panel (Tone bands, per-track Reverb / Delay amounts, project Reverb,
// project Delay). A continuous
// slider drag must collapse into a single undo step, so the renderer mints
// one stable `gestureId` at the first `input` and re-uses it for every
// coalesced sample until the gesture ends. Each gesture is scoped to a
// single control `key`: minting a fresh id whenever the active key changes
// (or after a gesture ends) stops one control's drag from being coalesced
// into another's. Callers must `endGesture()` on every exit path — gesture
// end, selection change, and component unmount — so a drag interrupted
// mid-stream can never leak a stale id into the next gesture.

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

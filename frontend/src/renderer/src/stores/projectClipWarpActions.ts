// Warp/pitch and volume-envelope clip actions for the project store.
// Spread into the store's `actions`; call sites stay `useProjectStore().X(...)`.
// `this` is the store instance, typed via the shared ProjectClipThis contract.

import { send as sendBridge } from '@/lib/bridgeService'
import { sanitizeEnvelopePoints, envelopesEqual } from '@/lib/envelope'
import { useLibraryStore } from '@/stores/libraryStore'
import type { ClipEnvelopePoint, ClipWarpMode } from '@shared/bridge-protocol'
import type { ProjectClipThis } from './projectClipContract'

/** The warp state that has to survive onto a clip created by split, duplicate or paste. */
export interface ReplayableClipWarp {
  warpEnabled?: boolean
  warpMode?: ClipWarpMode
  tempoRatio?: number | null
  semitones?: number
  cents?: number
  pendingAutoWarp?: boolean
}

/**
 * Replay a source clip's warp state onto a newly created backend clip.
 *
 * Split, duplicate and paste build the child with `CLIP_ADD`, which carries no warp
 * fields, so the parent's warp has to be re-sent or the child plays at the source tempo
 * while its parent plays at the project tempo. Each call site used to do this inline
 * behind `warpEnabled === true`, which silently dropped a clip still waiting on its
 * source BPM: auto-warp-on-drop sets `pendingAutoWarp` with `warpEnabled` not yet true,
 * so splitting such a clip before `LIBRARY_ITEM_ANALYSIS` arrived left the child
 * permanently unwarped. One helper keeps the three paths from drifting apart again.
 */
export function replayClipWarpToNewClip(source: ReplayableClipWarp, newClipId: string): void {
  const pendingAutoWarp = source.pendingAutoWarp === true
  const warpEnabled = source.warpEnabled === true
  if (!warpEnabled && !pendingAutoWarp) return
  sendBridge('CLIP_SET_WARP', {
    clipId: newClipId,
    // Omit rather than send `false`: this envelope is a partial update and the clip is
    // new, so unset already means "not warped".
    warpEnabled: warpEnabled ? true : undefined,
    warpMode: source.warpMode,
    tempoRatio: source.tempoRatio,
    semitones: source.semitones,
    cents: source.cents,
    pendingAutoWarp: pendingAutoWarp ? true : undefined
  })
}

export const clipWarpActions = {
    /** Patch warp/pitch settings; `tempoRatio: null` clears a pinned ratio. */
    setClipWarp(
      clipId: string,
      patch: {
        warpEnabled?: boolean
        warpMode?: ClipWarpMode
        /** `null` clears the pinned override; `number` pins it. */
        tempoRatio?: number | null
        semitones?: number
        cents?: number
        pendingAutoWarp?: boolean
        effectiveDurationMs?: number
        effectiveTempoRatio?: number
        effectiveWarpActive?: boolean
      },
      opts?: { localOnly?: boolean }
    ): void {
      const clip = this.clips[clipId]
      if (!clip) return
      if (patch.warpEnabled !== undefined) clip.warpEnabled = patch.warpEnabled
      if (patch.warpMode !== undefined) clip.warpMode = patch.warpMode
      if (patch.tempoRatio !== undefined) {
        clip.tempoRatio = patch.tempoRatio === null ? undefined : patch.tempoRatio
      }
      if (patch.semitones !== undefined) clip.semitones = patch.semitones
      if (patch.cents !== undefined) clip.cents = patch.cents
      if (patch.pendingAutoWarp !== undefined) {
        clip.pendingAutoWarp = patch.pendingAutoWarp ? true : undefined
      }
      if (patch.effectiveDurationMs !== undefined) clip.effectiveDurationMs = patch.effectiveDurationMs
      if (patch.effectiveTempoRatio !== undefined) clip.effectiveTempoRatio = patch.effectiveTempoRatio
      if (patch.effectiveWarpActive !== undefined) clip.effectiveWarpActive = patch.effectiveWarpActive
      // Explicit warp edits block late analysis from overriding user intent.
      if (
        patch.warpEnabled !== undefined ||
        patch.warpMode !== undefined ||
        patch.tempoRatio !== undefined ||
        patch.semitones !== undefined ||
        patch.cents !== undefined
      ) {
        clip.pendingAutoWarp = undefined
      }
      this.timelineRevision++
      if (!opts?.localOnly && patch.warpEnabled === true) {
        useLibraryStore().markItemWarping(clip.libraryItemId)
      }
      if (!opts?.localOnly) {
        sendBridge('CLIP_SET_WARP', {
          clipId,
          warpEnabled: patch.warpEnabled,
          warpMode: patch.warpMode,
          // Omit to preserve; send null to clear the pinned override.
          tempoRatio: patch.tempoRatio === undefined ? undefined : patch.tempoRatio,
          semitones: patch.semitones,
          cents: patch.cents,
          pendingAutoWarp: patch.pendingAutoWarp
        })
      }
    },

    /** Replace a clip envelope; local sanitising mirrors backend normalisation. */
    setClipEnvelope(
      clipId: string,
      points: ClipEnvelopePoint[],
      opts?: { localOnly?: boolean; gestureId?: string; gestureEnd?: boolean }
    ): void {
      const clip = this.clips[clipId]
      if (!clip) return
      const cleaned = sanitizeEnvelopePoints(points)
      // Fewer than two breakpoints means no shape.
      const next = cleaned.length >= 2 ? cleaned : undefined
      if (!envelopesEqual(clip.envelopePoints, next)) {
        clip.envelopePoints = next
        this.timelineRevision++
      }
      if (!opts?.localOnly) {
        sendBridge('CLIP_SET_ENVELOPE', {
          clipId,
          points: cleaned,
          gestureId: opts?.gestureId,
          gestureEnd: opts?.gestureEnd
        })
      }
    }
} satisfies Record<string, (this: ProjectClipThis, ...args: never[]) => unknown> &
  ThisType<ProjectClipThis>

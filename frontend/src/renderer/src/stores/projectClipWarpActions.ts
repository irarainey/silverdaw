// Warp/pitch and volume-envelope clip actions for the project store.
// Spread into the store's `actions`; call sites stay `useProjectStore().X(...)`.
// `this` is the store instance, typed via the shared ProjectClipThis contract.

import { send as sendBridge } from '@/lib/bridgeService'
import { sanitizeEnvelopePoints, envelopesEqual } from '@/lib/envelope'
import { useLibraryStore } from '@/stores/libraryStore'
import type { ClipEnvelopePoint, ClipWarpMode } from '@shared/bridge-protocol'
import type { ProjectClipThis } from './projectClipContract'

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
      this.peaksRevision++
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
        this.peaksRevision++
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

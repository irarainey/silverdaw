// Transition (crossfade) domain actions for the project store.
// Spread into the store's `actions`; call sites stay `useProjectStore().X(...)`.
// `this` is the store instance, typed via the shared ProjectClipThis contract.

import { send as sendBridge } from '@/lib/bridgeService'
import { log } from '@/lib/log'
import { effectiveClipDurationMs } from '@/lib/clip/clipTiming'
import { findTransitionCandidate, type ClipGeometry } from '@/lib/transitions/transitionCandidates'
import type { TransitionRecipe } from '@shared/bridge-protocol'
import type { Clip } from './projectTypes'
import type { ProjectClipThis } from './projectClipContract'

export const transitionActions = {
    /** Fire-and-forget transition create; PROJECT_STATE is the ack. */
    createTransition(
      trackId: string,
      leftClipId: string,
      rightClipId: string,
      recipe?: TransitionRecipe
    ): void {
      sendBridge('TRANSITION_CREATE', {
        trackId,
        leftClipId,
        rightClipId,
        ...(recipe ? { recipe } : {})
      })
      log.debug(
        'project',
        `createTransition track=${trackId} left=${leftClipId} right=${rightClipId}`
      )
    },

    deleteTransition(trackId: string, transitionId: string): void {
      sendBridge('TRANSITION_DELETE', { trackId, transitionId })
      log.debug('project', `deleteTransition track=${trackId} id=${transitionId}`)
    },

    setTransitionRecipe(
      trackId: string,
      transitionId: string,
      recipe: TransitionRecipe
    ): void {
      sendBridge('TRANSITION_SET_RECIPE', { trackId, transitionId, recipe })
      log.debug(
        'project',
        `setTransitionRecipe track=${trackId} id=${transitionId} kind=${recipe.kind}`
      )
    },

    /** Request a transition after a trim if the backend-valid overlap exists. */
    maybeCreateTransitionAfterTrim(clipId: string, edge: 'left' | 'right'): void {
      const clip = this.clips[clipId]
      if (!clip) return
      const track = this.tracks.find((t) => t.id === clip.trackId)
      if (!track) return

      const toGeometry = (c: Clip): ClipGeometry => ({
        id: c.id,
        startMs: c.startMs,
        endMs: c.startMs + effectiveClipDurationMs(c)
      })
      const others: ClipGeometry[] = []
      for (const id of track.clipIds) {
        if (id === clipId) continue
        const c = this.clips[id]
        if (c) others.push(toGeometry(c))
      }

      const candidate = findTransitionCandidate(
        toGeometry(clip),
        edge,
        others,
        track.transitions ?? []
      )
      if (!candidate) return
      this.createTransition(track.id, candidate.leftClipId, candidate.rightClipId)
    },
} satisfies Record<string, (this: ProjectClipThis, ...args: never[]) => unknown> &
  ThisType<ProjectClipThis>

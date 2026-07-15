// Scratch pattern persistence domain actions, extracted from projectStore.
// Spread into the store's `actions` so call sites stay unchanged.

import { send as sendBridge } from '@/lib/bridgeService'
import { log } from '@/lib/log'
import { SCRATCH_PROTOCOL_VERSION } from '@shared/bridge-protocol'
import type { ScratchPattern } from '@shared/bridge-protocol'

interface ScratchActionsThis {
  savedScratchPatterns: ScratchPattern[]
}

export const scratchPatternActions = {
  /** Save or update a scratch pattern in the backend ValueTree. */
  saveScratchPattern(this: ScratchActionsThis, sessionId: string, pattern: ScratchPattern): void {
    sendBridge('SCRATCH_PATTERN_SAVE', {
      protocolVersion: SCRATCH_PROTOCOL_VERSION,
      sessionId,
      pattern
    })
    log.info('project', `saveScratchPattern id=${pattern.id} name=${pattern.name}`)
  },

  /**
   * Bake the recorded scratch into a frozen library sample (WAV) that can be
   * dragged onto the timeline, preserving the notation for re-editing. `itemId`
   * is stable per scratch (derived from the pattern id) so a re-save updates the
   * same library item in place.
   */
  saveScratchAsSample(
    this: ScratchActionsThis,
    sessionId: string,
    itemId: string,
    sampleName: string,
    pattern: ScratchPattern,
    sourceItemId?: string | null
  ): void {
    sendBridge('SCRATCH_SAVE_AS_SAMPLE', {
      protocolVersion: SCRATCH_PROTOCOL_VERSION,
      sessionId,
      itemId,
      sampleName,
      ...(sourceItemId ? { sourceItemId } : {}),
      pattern
    })
    log.info('project', `saveScratchAsSample item=${itemId} name=${sampleName}`)
  },

  /** Delete a saved scratch pattern by id. */
  deleteScratchPattern(this: ScratchActionsThis, patternId: string): void {
    sendBridge('SCRATCH_PATTERN_DELETE', {
      protocolVersion: SCRATCH_PROTOCOL_VERSION,
      patternId
    })
    log.info('project', `deleteScratchPattern id=${patternId}`)
  },

  /** Rename a saved scratch pattern. */
  renameScratchPattern(this: ScratchActionsThis, patternId: string, name: string): void {
    sendBridge('SCRATCH_PATTERN_RENAME', {
      protocolVersion: SCRATCH_PROTOCOL_VERSION,
      patternId,
      name
    })
    log.info('project', `renameScratchPattern id=${patternId} name=${name}`)
  },

  /** Apply a saved scratch pattern to a timeline clip (non-destructive). */
  applyScratchPattern(this: ScratchActionsThis, clipId: string, patternId: string): void {
    sendBridge('SCRATCH_PATTERN_APPLY', {
      protocolVersion: SCRATCH_PROTOCOL_VERSION,
      clipId,
      patternId
    })
    log.info('project', `applyScratchPattern clip=${clipId} pattern=${patternId}`)
  },

  /** Remove a scratch pattern reference from a timeline clip. */
  removeScratchPattern(this: ScratchActionsThis, clipId: string): void {
    sendBridge('SCRATCH_PATTERN_REMOVE', {
      protocolVersion: SCRATCH_PROTOCOL_VERSION,
      clipId
    })
    log.info('project', `removeScratchPattern clip=${clipId}`)
  },

  /** Start audition replay of a saved pattern or the current unsaved draft. */
  startPatternReplay(this: ScratchActionsThis, pattern: string | ScratchPattern): void {
    if (typeof pattern === 'string') {
      sendBridge('SCRATCH_PATTERN_REPLAY_START', {
        protocolVersion: SCRATCH_PROTOCOL_VERSION,
        patternId: pattern
      })
      log.info('project', `startPatternReplay pattern=${pattern}`)
      return
    }

    sendBridge('SCRATCH_PATTERN_REPLAY_START', {
      protocolVersion: SCRATCH_PROTOCOL_VERSION,
      pattern
    })
    log.info('project', `startPatternReplay draft=${pattern.id}`)
  },

  /** Stop pattern audition replay. */
  stopPatternReplay(this: ScratchActionsThis): void {
    sendBridge('SCRATCH_PATTERN_REPLAY_STOP', {
      protocolVersion: SCRATCH_PROTOCOL_VERSION
    })
    log.info('project', `stopPatternReplay`)
  }
}

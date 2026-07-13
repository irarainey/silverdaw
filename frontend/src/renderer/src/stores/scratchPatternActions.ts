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

  /** Start audition replay of a saved pattern (through active scratch session). */
  startPatternReplay(this: ScratchActionsThis, patternId: string): void {
    sendBridge('SCRATCH_PATTERN_REPLAY_START', {
      protocolVersion: SCRATCH_PROTOCOL_VERSION,
      patternId
    })
    log.info('project', `startPatternReplay pattern=${patternId}`)
  },

  /** Stop pattern audition replay. */
  stopPatternReplay(this: ScratchActionsThis): void {
    sendBridge('SCRATCH_PATTERN_REPLAY_STOP', {
      protocolVersion: SCRATCH_PROTOCOL_VERSION
    })
    log.info('project', `stopPatternReplay`)
  }
}

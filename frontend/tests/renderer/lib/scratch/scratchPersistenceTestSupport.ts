// Shared test support for Scratch persistence tests.
// Provides data builders, session/persistence setup, and global stubs used by
// scratchPatternPersistenceController.test.ts, scratchPersistenceLifecycle.test.ts,
// and stores/scratchPatternPersistence.test.ts.
//
// NOTE: vi.mock calls and sendMock (vi.hoisted) must stay in each test file so
// Vitest can hoist them above imports. Sharing vi.mock factories via imports
// causes TDZ errors because factories run before the module graph resolves.

import { ref } from 'vue'
import { vi } from 'vitest'
import { useScratchSessionStore } from '@/stores/scratchSessionStore'
import { useScratchPatternPersistence } from '@/lib/scratch/scratchPatternPersistence'
import type { ProjectStatePayload, ScratchPattern } from '@shared/bridge-protocol'
import {
  SCRATCH_CROSSFADER_CURVE_VERSION,
  SCRATCH_PATTERN_VERSION
} from '@shared/bridge-protocol'

export function makePattern(overrides: Partial<ScratchPattern> = {}): ScratchPattern {
  return {
    id: 'sp-1',
    name: 'Test',
    version: SCRATCH_PATTERN_VERSION,
    durationUs: 1_000_000,
    cropStartUs: 0,
    cropEndUs: 1_000_000,
    sourceOffsetTurns: 0,
    ownerDeck: 1,
    crossfaderCurve: SCRATCH_CROSSFADER_CURVE_VERSION,
    platter: [
      { timeUs: 0, turns: 0, touched: true },
      { timeUs: 1_000_000, turns: 1, touched: false }
    ],
    crossfader: [
      { timeUs: 0, value: 0 },
      { timeUs: 1_000_000, value: 1 }
    ],
    ...overrides
  }
}

export function makeSnapshot(overrides: Partial<ProjectStatePayload> = {}): ProjectStatePayload {
  return {
    filePath: null,
    name: 'Test Project',
    tracks: [],
    ...overrides
  }
}

export function setupSessionStore(sessionId: string = 'session-1') {
  const scratch = useScratchSessionStore()
  scratch.applyState({
    protocolVersion: 1,
    sessionId,
    clipId: 'clip-1',
    status: 'ready',
    positionUs: 0,
    durationUs: 1_000_000,
    platterTurns: 0,
    playbackRate: 1,
    crossfader: 0.5,
    ownerDeviceIdentifier: null,
    ownerDeck: null,
    touched: false
  })
  return scratch
}

export function createPersistence(sessionId: string = 'session-1') {
  const sessionRef = ref<string | null>(sessionId)
  return { persistence: useScratchPatternPersistence(sessionRef), sessionRef }
}

vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'uuid-test') })
vi.stubGlobal('window', {
  silverdaw: {
    readAudioMetadata: vi.fn().mockResolvedValue(null),
    readAudioFile: vi.fn().mockResolvedValue(null)
  }
})

// Marker domain actions for the project store. Spread into the store's `actions`
// so call sites stay `useProjectStore().addMarkerAt(...)`. `this` is the store
// instance, narrowed to the marker state + sibling actions these use.

import { send as sendBridge } from '@/lib/bridgeService'
import { log } from '@/lib/log'
import { runInUndoGroup } from '@/lib/undo/undoGroup'
import { useNotificationsStore } from '@/stores/notificationsStore'
import type { Marker, ProjectState } from './projectTypes'

interface MarkerActionsThis extends ProjectState {
  addMarkerAt(positionMs: number): boolean
  removeMarker(markerId: string): boolean
}

// Markers are stored on whole milliseconds while the playhead is a float the
// engine quantises to a sample, so anything inside this slop is "the same spot".
const MARKER_MATCH_TOLERANCE_MS = 1

const ENGINE_OFFLINE_REMOVE_MESSAGE =
  'Marker was removed locally, but the audio engine isn\'t connected.'
const ENGINE_OFFLINE_CLEAR_MESSAGE =
  'Markers were cleared locally, but the audio engine isn\'t connected.'

// Drops one marker from local state and tells the engine. The result separates
// "no such marker" from "removed but the engine never heard", so callers can
// decide how to report it — a batch clear wants one toast, not one per marker.
type MarkerRemoval = 'missing' | 'removed' | 'removed-offline'

function removeMarkerLocally(state: MarkerActionsThis, markerId: string): MarkerRemoval {
  const index = state.markers.findIndex((marker) => marker.id === markerId)
  if (index < 0) return 'missing'
  const [marker] = state.markers.splice(index, 1)
  const sent = sendBridge('PROJECT_MARKER_REMOVE', { markerId })
  log.info('project', `removeMarker id=${markerId} position=${marker?.positionMs ?? '?'}`)
  return sent ? 'removed' : 'removed-offline'
}

export const markerActions = {
  addMarkerAt(this: MarkerActionsThis, positionMs: number): boolean {
    const safePositionMs = Math.max(0, Math.floor(positionMs))
    const existing = this.markers.find(
      (marker) => Math.abs(marker.positionMs - safePositionMs) < MARKER_MATCH_TOLERANCE_MS
    )
    if (existing) return false

    const marker: Marker = {
      id: crypto.randomUUID(),
      positionMs: safePositionMs
    }
    this.markers.push(marker)
    this.markers.sort((a, b) => a.positionMs - b.positionMs)

    const sent = sendBridge('PROJECT_MARKER_ADD', {
      markerId: marker.id,
      positionMs: marker.positionMs
    })
    if (!sent) {
      useNotificationsStore().pushError('Marker was added locally, but the audio engine isn\'t connected.')
    }
    log.info('project', `addMarkerAt id=${marker.id} position=${marker.positionMs}`)
    return true
  },

  // `positionMs` is where the user actually is (the raw playhead); `addPositionMs`
  // is where a new marker should land, which callers snap to the grid. Removal
  // matches either, so a marker that a tempo change left off-grid still toggles
  // off from its own position instead of adding a second marker beside it.
  toggleMarkerAt(this: MarkerActionsThis, positionMs: number, addPositionMs = positionMs): boolean {
    const safePositionMs = Math.max(0, Math.round(positionMs))
    const safeAddPositionMs = Math.max(0, Math.round(addPositionMs))
    const isNear = (marker: Marker, target: number): boolean =>
      Math.abs(marker.positionMs - target) < MARKER_MATCH_TOLERANCE_MS
    const existing =
      this.markers.find((marker) => isNear(marker, safePositionMs)) ??
      this.markers.find((marker) => isNear(marker, safeAddPositionMs))
    if (existing) return this.removeMarker(existing.id)
    return this.addMarkerAt(safeAddPositionMs)
  },

  // Removes every marker as one undo step: the backend folds the individual
  // PROJECT_MARKER_REMOVE commands into a single transaction. Returns how many
  // markers were cleared.
  clearAllMarkers(this: MarkerActionsThis): number {
    const markerIds = this.markers.map((marker) => marker.id)
    if (markerIds.length === 0) return 0
    const offline = runInUndoGroup('Clear all markers', () =>
      markerIds.reduce(
        (anyOffline, markerId) =>
          removeMarkerLocally(this, markerId) === 'removed-offline' || anyOffline,
        false
      )
    )
    if (offline) {
      useNotificationsStore().pushError(ENGINE_OFFLINE_CLEAR_MESSAGE)
    }
    log.info('project', `clearAllMarkers removed=${markerIds.length}`)
    return markerIds.length
  },

  removeMarker(this: MarkerActionsThis, markerId: string): boolean {
    const result = removeMarkerLocally(this, markerId)
    if (result === 'missing') return false
    if (result === 'removed-offline') {
      useNotificationsStore().pushError(ENGINE_OFFLINE_REMOVE_MESSAGE)
    }
    return true
  },

  moveMarker(this: MarkerActionsThis, markerId: string, positionMs: number): boolean {
    const marker = this.markers.find((m) => m.id === markerId)
    if (!marker) return false
    const safePositionMs = Math.max(0, Math.round(positionMs))
    if (Math.abs(marker.positionMs - safePositionMs) < 1) return true
    const existing = this.markers.find((m) => m.id !== markerId && Math.abs(m.positionMs - safePositionMs) < 1)
    if (existing) return false
    marker.positionMs = safePositionMs
    this.markers.sort((a, b) => a.positionMs - b.positionMs)
    const sent = sendBridge('PROJECT_MARKER_MOVE', {
      markerId,
      positionMs: safePositionMs
    })
    if (!sent) {
      useNotificationsStore().pushError('Marker was moved locally, but the audio engine isn\'t connected.')
    }
    return true
  }
}

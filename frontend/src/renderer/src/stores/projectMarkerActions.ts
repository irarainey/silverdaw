// Marker domain actions for the project store. Spread into the store's `actions`
// so call sites stay `useProjectStore().addMarkerAt(...)`. `this` is the store
// instance, narrowed to the marker state + sibling actions these use.

import { send as sendBridge } from '@/lib/bridgeService'
import { log } from '@/lib/log'
import { useNotificationsStore } from '@/stores/notificationsStore'
import type { Marker, ProjectState } from './projectTypes'

interface MarkerActionsThis extends ProjectState {
  addMarkerAt(positionMs: number): boolean
  removeMarker(markerId: string): boolean
}

export const markerActions = {
  addMarkerAt(this: MarkerActionsThis, positionMs: number): boolean {
    const safePositionMs = Math.max(0, Math.floor(positionMs))
    const existing = this.markers.find((marker) => Math.abs(marker.positionMs - safePositionMs) < 1)
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

  toggleMarkerAt(this: MarkerActionsThis, positionMs: number): boolean {
    const safePositionMs = Math.max(0, Math.round(positionMs))
    const existing = this.markers.find((marker) => Math.abs(marker.positionMs - safePositionMs) < 1)
    if (existing) return this.removeMarker(existing.id)
    return this.addMarkerAt(safePositionMs)
  },

  removeMarker(this: MarkerActionsThis, markerId: string): boolean {
    const index = this.markers.findIndex((marker) => marker.id === markerId)
    if (index < 0) return false
    const [marker] = this.markers.splice(index, 1)
    const sent = sendBridge('PROJECT_MARKER_REMOVE', { markerId })
    if (!sent) {
      useNotificationsStore().pushError('Marker was removed locally, but the audio engine isn\'t connected.')
    }
    log.info('project', `removeMarker id=${markerId} position=${marker?.positionMs ?? '?'}`)
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

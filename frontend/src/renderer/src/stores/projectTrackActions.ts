// Track domain actions for the project store. Spread into the store's `actions`
// so call sites stay `useProjectStore().addTrack(...)` etc. `this` is the store
// instance; ThisType narrows it to ProjectState + the sibling track actions used.

import { send as sendBridge } from '@/lib/bridgeService'
import { log } from '@/lib/log'
import { runInUndoGroup } from '@/lib/undo/undoGroup'
import { useUiStore } from '@/stores/uiStore'
import { sanitizeBreakpoints, flatCurve, insertBreakpoint, moveBreakpoint } from '@/lib/automation/breakpoints'
import { AUTOMATION_PARAMS } from '@/lib/automation/automationParams'
import type { AutomationParamId, AutomationPoint, ProjectState, Track } from './projectTypes'
import { DEFAULT_TRACK_LENGTH_MS, MAX_TRACK_VOLUME, TRACK_PALETTE } from './projectTypes'

type TrackActionsThis = ProjectState & {
  pushAllGains(): void
  selectTrack(trackId: string | null): void
  setTrackAutomation(
    trackId: string,
    paramId: AutomationParamId,
    points: AutomationPoint[],
    opts?: { localOnly?: boolean; gestureId?: string; gestureEnd?: boolean }
  ): void
  setAutomationRamp(
    trackId: string,
    paramId: AutomationParamId,
    startMs: number,
    endMs: number,
    startValue: number,
    endValue: number
  ): void
}

/** The track property that holds each param's static (resting) value — the
 *  level used when no automation curve exists. Lets the lane baseline reflect
 *  the FX rack and vice-versa. */
const STATIC_FIELD: Partial<Record<AutomationParamId, keyof Track>> = {
  filter: 'toneFilter',
  pan: 'pan',
  toneBass: 'toneBassDb',
  toneMid: 'toneMidDb',
  toneTreble: 'toneTrebleDb',
  reverbSend: 'reverbSend',
  delaySend: 'delaySend',
  leveler: 'levelerAmount',
  saturationDrive: 'saturationDrive',
  saturationMix: 'saturationMix',
  bitCrusherRate: 'bitCrusherRate',
  bitCrusherBits: 'bitCrusherBits',
  bitCrusherBoost: 'bitCrusherBoost',
  bitCrusherMix: 'bitCrusherMix'
}

/** A param's resting native value for a track: its static FX field, or the
 *  descriptor default when unset. */
export function trackStaticAutomationValue(track: Track, paramId: AutomationParamId): number {
  const field = STATIC_FIELD[paramId]
  const v = field ? track[field] : undefined
  return typeof v === 'number' ? v : AUTOMATION_PARAMS[paramId].defaultValue
}

export const trackActions = {
    addTrack(): string {
      // UUIDs stay stable across renderer reloads and save/load cycles.
      const trackId = crypto.randomUUID()
      const track: Track = {
        id: trackId,
        name: `Track ${this.tracks.length + 1}`,
        clipIds: [],
        muted: false,
        soloed: false,
        volume: 1.0,
        colorIndex: this.tracks.length % TRACK_PALETTE.length,
        lengthMs: DEFAULT_TRACK_LENGTH_MS
      }
      this.tracks.push(track)
      this.timelineRevision++
      // Optimistic; TRACK_ADDED is diagnostic because the renderer already shows it.
      // colorIndex is persisted so the inherited clip colour never drifts on reload.
      sendBridge('TRACK_ADD', { trackId, name: track.name, colorIndex: track.colorIndex })
      // A new row is appended at the bottom; ask the timeline to scroll it into
      // view so it is never created out of sight below the fold.
      useUiStore().requestRevealTrack(trackId)
      // Select the new track so it is the immediate target for clip paste /
      // mute / solo shortcuts and the FX rack.
      this.selectTrack(trackId)
      log.info('project', `addTrack id=${trackId}`)
      return trackId
    },

    /** Update Tone EQ / Filter; localOnly reconciles backend acks without echoing gestures. */
    setTrackTone(
      trackId: string,
      patch: { bassDb?: number; midDb?: number; trebleDb?: number; filter?: number },
      opts?: { localOnly?: boolean; gestureId?: string; gestureEnd?: boolean }
    ): void {
      const track = this.tracks.find((t) => t.id === trackId)
      if (!track) return
      const clampDb = (v: number): number =>
        Math.max(-15, Math.min(15, Number.isFinite(v) ? v : 0))
      if (patch.bassDb !== undefined) {
        const v = clampDb(patch.bassDb)
        track.toneBassDb = v !== 0 ? v : undefined
      }
      if (patch.midDb !== undefined) {
        const v = clampDb(patch.midDb)
        track.toneMidDb = v !== 0 ? v : undefined
      }
      if (patch.trebleDb !== undefined) {
        const v = clampDb(patch.trebleDb)
        track.toneTrebleDb = v !== 0 ? v : undefined
      }
      if (patch.filter !== undefined) {
        const v = Math.max(-1, Math.min(1, Number.isFinite(patch.filter) ? patch.filter : 0))
        track.toneFilter = v !== 0 ? v : undefined
      }
      if (!opts?.localOnly) {
        sendBridge('TRACK_SET_TONE', {
          trackId,
          bassDb: patch.bassDb,
          midDb: patch.midDb,
          trebleDb: patch.trebleDb,
          filter: patch.filter,
          gestureId: opts?.gestureId,
          gestureEnd: opts?.gestureEnd
        })
      }
    },

    /** Update sends; undefined patch fields fall back to the current track value. */
    setTrackSends(
      trackId: string,
      patch: { reverbSend?: number; delaySend?: number },
      opts?: { localOnly?: boolean; gestureId?: string; gestureEnd?: boolean }
    ): void {
      const track = this.tracks.find((t) => t.id === trackId)
      if (!track) return
      const clampUnit = (v: number): number =>
        Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0))
      if (patch.reverbSend !== undefined) {
        const v = clampUnit(patch.reverbSend)
        track.reverbSend = v !== 0 ? v : undefined
      }
      if (patch.delaySend !== undefined) {
        const v = clampUnit(patch.delaySend)
        track.delaySend = v !== 0 ? v : undefined
      }
      if (!opts?.localOnly) {
        sendBridge('TRACK_SET_SENDS', {
          trackId,
          reverbSend: patch.reverbSend ?? track.reverbSend ?? 0,
          delaySend: patch.delaySend ?? track.delaySend ?? 0,
          gestureId: opts?.gestureId,
          gestureEnd: opts?.gestureEnd
        })
      }
    },

    /** Update pan; localOnly reconciles backend acks without echoing gestures. */
    setTrackPan(
      trackId: string,
      pan: number,
      opts?: { localOnly?: boolean; gestureId?: string; gestureEnd?: boolean }
    ): void {
      const track = this.tracks.find((t) => t.id === trackId)
      if (!track) return
      const clamped = Math.max(-1, Math.min(1, Number.isFinite(pan) ? pan : 0))
      track.pan = clamped !== 0 ? clamped : undefined
      if (!opts?.localOnly) {
        sendBridge('TRACK_SET_PAN', {
          trackId,
          pan: clamped,
          gestureId: opts?.gestureId,
          gestureEnd: opts?.gestureEnd
        })
      }
    },

    /** Update Leveler amount; localOnly reconciles backend acks. */
    setTrackLeveler(
      trackId: string,
      amount: number,
      opts?: { localOnly?: boolean; gestureId?: string; gestureEnd?: boolean }
    ): void {
      const track = this.tracks.find((t) => t.id === trackId)
      if (!track) return
      const clamped = Math.max(0, Math.min(1, Number.isFinite(amount) ? amount : 0))
      track.levelerAmount = clamped !== 0 ? clamped : undefined
      if (!opts?.localOnly) {
        sendBridge('TRACK_SET_LEVELER', {
          trackId,
          amount: clamped,
          gestureId: opts?.gestureId,
          gestureEnd: opts?.gestureEnd
        })
      }
    },

    /** Update soft-saturation Drive and Mix; absent Mix is fully wet. */
    setTrackSaturation(
      trackId: string,
      patch: { drive?: number; mix?: number },
      opts?: { localOnly?: boolean; gestureId?: string; gestureEnd?: boolean }
    ): void {
      const track = this.tracks.find((t) => t.id === trackId)
      if (!track) return
      const clamp = (value: number, fallback: number): number =>
        Math.max(0, Math.min(1, Number.isFinite(value) ? value : fallback))
      if (patch.drive !== undefined) {
        const drive = clamp(patch.drive, 0)
        track.saturationDrive = drive !== 0 ? drive : undefined
      }
      if (patch.mix !== undefined) {
        const mix = clamp(patch.mix, 1)
        track.saturationMix = mix !== 1 ? mix : undefined
      }
      if (!opts?.localOnly) {
        sendBridge('TRACK_SET_SATURATION', {
          trackId,
          drive: patch.drive,
          mix: patch.mix,
          gestureId: opts?.gestureId,
          gestureEnd: opts?.gestureEnd
        })
      }
    },

    setTrackBitCrusher(
      trackId: string,
      patch: { rate?: number; bits?: number; boost?: number; mix?: number },
      opts?: { localOnly?: boolean; gestureId?: string; gestureEnd?: boolean }
    ): void {
      const track = this.tracks.find((t) => t.id === trackId)
      if (!track) return
      const clamp = (value: number, min: number, max: number, fallback: number): number =>
        Math.max(min, Math.min(max, Number.isFinite(value) ? value : fallback))
      if (patch.rate !== undefined) {
        const rate = clamp(patch.rate, 0.01, 1, 1)
        track.bitCrusherRate = rate !== 1 ? rate : undefined
      }
      if (patch.bits !== undefined) {
        const bits = Math.round(clamp(patch.bits, 1, 16, 16))
        track.bitCrusherBits = bits !== 16 ? bits : undefined
      }
      if (patch.boost !== undefined) {
        const boost = clamp(patch.boost, 0, 1, 0)
        track.bitCrusherBoost = boost !== 0 ? boost : undefined
      }
      if (patch.mix !== undefined) {
        const mix = clamp(patch.mix, 0, 1, 0)
        track.bitCrusherMix = mix !== 0 ? mix : undefined
      }
      if (!opts?.localOnly) {
        sendBridge('TRACK_SET_BIT_CRUSHER', {
          trackId,
          rate: patch.rate,
          bits: patch.bits,
          boost: patch.boost,
          mix: patch.mix,
          gestureId: opts?.gestureId,
          gestureEnd: opts?.gestureEnd
        })
      }
    },

    /** Set a track's automation curve for one parameter. `points` with fewer than
     *  two breakpoints clears the lane. localOnly reconciles backend acks. */
    setTrackAutomation(
      trackId: string,
      paramId: AutomationParamId,
      points: AutomationPoint[],
      opts?: { localOnly?: boolean; gestureId?: string; gestureEnd?: boolean }
    ): void {
      const track = this.tracks.find((t) => t.id === trackId)
      if (!track) return
      const d = AUTOMATION_PARAMS[paramId]
      if (!d) return
      const cleaned = sanitizeBreakpoints(points, { min: d.min, max: d.max })

      // A curve that has settled flat at the track's resting (static) value is a
      // no-op overlay — drop it so the lane/indicator clears and the static
      // control takes over (e.g. flattening pan back to centre). Only on a
      // settled edit (discrete change or gesture end), never mid-drag.
      let effective = cleaned
      const settled = !opts?.gestureId || opts?.gestureEnd === true
      if (settled && effective.length >= 2) {
        const baseline = trackStaticAutomationValue(track, paramId)
        const tol = Math.max(1e-4, (d.max - d.min) * 1e-3)
        const flat = effective.every((p) => Math.abs(p.value - effective[0]!.value) <= tol)
        if (flat && Math.abs(effective[0]!.value - baseline) <= tol) effective = []
      }
      const next = effective.length >= 2 ? effective : undefined

      const map = track.automation ? { ...track.automation } : {}
      if (next) map[paramId] = next
      else delete map[paramId]
      track.automation = Object.keys(map).length > 0 ? map : undefined
      this.timelineRevision++

      if (!opts?.localOnly) {
        sendBridge('TRACK_SET_AUTOMATION', {
          trackId,
          paramId,
          points: effective,
          gestureId: opts?.gestureId,
          gestureEnd: opts?.gestureEnd
        })
      }
    },

    /** Author a 2-point ramp for a param over `[startMs,endMs]` (one undo step). */
    setAutomationRamp(
      trackId: string,
      paramId: AutomationParamId,
      startMs: number,
      endMs: number,
      startValue: number,
      endValue: number
    ): void {
      const lo = Math.max(0, Math.min(startMs, endMs))
      const hi = Math.max(startMs, endMs)
      if (hi - lo < 1) return
      this.setTrackAutomation(trackId, paramId, [
        { timeMs: lo, value: startValue },
        { timeMs: hi, value: endValue }
      ])
    },

    /** Copy a param's curve from one track to another, optionally inverting it. */
    copyAutomationToTrack(
      srcTrackId: string,
      dstTrackId: string,
      paramId: AutomationParamId,
      invert = false
    ): void {
      const src = this.tracks.find((t) => t.id === srcTrackId)?.automation?.[paramId]
      if (!src) return
      const d = AUTOMATION_PARAMS[paramId]
      const mid = (d.min + d.max) / 2
      const points = src.map((p) => ({ timeMs: p.timeMs, value: invert ? mid * 2 - p.value : p.value }))
      this.setTrackAutomation(dstTrackId, paramId, points)
    },

    /** One-gesture opposing filter sweep across two tracks: A rises, B mirrors. */
    createFilterCrossfade(trackAId: string, trackBId: string, startMs: number, endMs: number): void {
      runInUndoGroup('Filter crossfade', () => {
        this.setAutomationRamp(trackAId, 'filter', startMs, endMs, -1, 1)
        this.setAutomationRamp(trackBId, 'filter', startMs, endMs, 1, -1)
      })
    },

    /** Shift a param's whole curve up/down by `delta` native units. With no
     *  curve, lays a flat line at the static baseline + delta across the track,
     *  giving a one-click whole-timeline level change. */
    shiftTrackAutomation(trackId: string, paramId: AutomationParamId, delta: number): void {
      const track = this.tracks.find((t) => t.id === trackId)
      if (!track || delta === 0) return
      const existing = track.automation?.[paramId]
      const base = existing && existing.length >= 2
        ? existing
        : flatCurve(track.lengthMs, trackStaticAutomationValue(track, paramId))
      runInUndoGroup('Shift automation', () => {
        this.setTrackAutomation(trackId, paramId, base.map((p) => ({ timeMs: p.timeMs, value: p.value + delta })))
      })
    },

    /** Set a param's value at the playhead. With no curve, lays a flat baseline
     *  first so the new point reads against the track's resting level. */
    setAutomationValueAt(trackId: string, paramId: AutomationParamId, timeMs: number, value: number): void {
      const track = this.tracks.find((t) => t.id === trackId)
      if (!track) return
      const d = AUTOMATION_PARAMS[paramId]
      const base = track.automation?.[paramId] && track.automation[paramId]!.length >= 2
        ? track.automation[paramId]!
        : flatCurve(track.lengthMs, trackStaticAutomationValue(track, paramId))
      const { points } = insertBreakpoint(base, timeMs, value, { min: d.min, max: d.max })
      runInUndoGroup('Set automation point', () => {
        this.setTrackAutomation(trackId, paramId, points)
      })
    },

    /** Nudge one breakpoint by time/value deltas (keyboard fine-edit). A value
     *  nudge snaps to the parameter default when it would otherwise step past it. */
    nudgeAutomationPoint(trackId: string, paramId: AutomationParamId, index: number, dTimeMs: number, dValue: number): void {
      const track = this.tracks.find((t) => t.id === trackId)
      const pts = track?.automation?.[paramId]
      if (!pts || index < 0 || index >= pts.length) return
      const d = AUTOMATION_PARAMS[paramId]
      const p = pts[index]!
      let value = p.value + dValue
      if (dValue !== 0 && (p.value - d.defaultValue) * (value - d.defaultValue) < 0) value = d.defaultValue
      const next = moveBreakpoint(pts.map((q) => ({ ...q })), index, p.timeMs + dTimeMs, value, { min: d.min, max: d.max })
      this.setTrackAutomation(trackId, paramId, next)
    },

    removeTrack(trackId: string): void {
      const idx = this.tracks.findIndex((t) => t.id === trackId)
      if (idx < 0) return

      const track = this.tracks[idx]
      if (!track) return
      for (const clipId of track.clipIds) {
        delete this.clips[clipId]
        delete this.duplicateTailBySource[clipId]
        for (const [sourceId, tailId] of Object.entries(this.duplicateTailBySource)) {
          if (tailId === clipId) delete this.duplicateTailBySource[sourceId]
        }
        if (this.selectedClipId === clipId) this.selectedClipId = null
      }
      if (this.selectedTrackId === trackId) this.selectedTrackId = null
      this.tracks.splice(idx, 1)
      this.timelineRevision++

      sendBridge('TRACK_REMOVE', { trackId })

      if (track.soloed) this.pushAllGains()
      log.info('project', `removeTrack id=${trackId}`)
    },

    /** Toggle persisted mute; backend derives effective gain. Mute and solo are
     * mutually exclusive, so engaging mute clears any solo on the same track. */
    toggleMute(trackId: string): void {
      const t = this.tracks.find((x) => x.id === trackId)
      if (!t) return
      t.muted = !t.muted
      log.info('project', `toggleMute id=${trackId} muted=${t.muted}`)
      // Mute and its implied solo-clear are one undo step.
      runInUndoGroup('Toggle mute', () => {
        sendBridge('TRACK_MUTE', { trackId, muted: t.muted })
        if (t.muted && t.soloed) {
          t.soloed = false
          log.info('project', `toggleMute cleared solo id=${trackId}`)
          sendBridge('TRACK_SOLO', { trackId, soloed: false })
        }
      })
    },

    /** Toggle solo; backend re-pushes project-wide effective gain. Mute and solo are
     * mutually exclusive, so engaging solo clears any mute on the same track. */
    toggleSolo(trackId: string): void {
      const t = this.tracks.find((x) => x.id === trackId)
      if (!t) return
      t.soloed = !t.soloed
      log.info('project', `toggleSolo id=${trackId} soloed=${t.soloed}`)
      // Solo and its implied mute-clear are one undo step.
      runInUndoGroup('Toggle solo', () => {
        sendBridge('TRACK_SOLO', { trackId, soloed: t.soloed })
        if (t.soloed && t.muted) {
          t.muted = false
          log.info('project', `toggleSolo cleared mute id=${trackId}`)
          sendBridge('TRACK_MUTE', { trackId, muted: false })
        }
      })
    },

    /** Move solo to `trackId` exclusively: solo it and unsolo every other track in one
     *  undo step. Backs the Ctrl-click "switch solo" shortcut, so the user can jump the
     *  solo to another track without unsoloing then re-soloing. A no-op if the target is
     *  already the only soloed track. */
    soloOnly(trackId: string): void {
      const target = this.tracks.find((x) => x.id === trackId)
      if (!target) return
      // Nothing to do when this track is already the sole soloed one.
      if (target.soloed && this.tracks.every((t) => t.id === trackId || !t.soloed)) return
      log.info('project', `soloOnly id=${trackId}`)
      runInUndoGroup('Switch solo', () => {
        for (const t of this.tracks) {
          const shouldSolo = t.id === trackId
          if (t.soloed !== shouldSolo) {
            t.soloed = shouldSolo
            sendBridge('TRACK_SOLO', { trackId: t.id, soloed: shouldSolo })
          }
          // Soloing a track clears its own mute, matching toggleSolo.
          if (shouldSolo && t.muted) {
            t.muted = false
            log.info('project', `soloOnly cleared mute id=${t.id}`)
            sendBridge('TRACK_MUTE', { trackId: t.id, muted: false })
          }
        }
      })
    },

    /** Re-push user volume; backend folds in mute/solo. */
    pushTrackGain(track: Track): void {
      sendBridge('TRACK_GAIN', { trackId: track.id, gain: track.volume })
    },

    /** Re-push all user volumes after reconnect; mute/solo ride PROJECT_STATE. */
    pushAllGains(): void {
      for (const t of this.tracks) {
        sendBridge('TRACK_GAIN', { trackId: t.id, gain: t.volume })
      }
    },

    /** Commit track volume; live drags use setTrackVolumeLocal to avoid bridge flood. */
    setTrackVolume(trackId: string, volume: number): void {
      const t = this.tracks.find((x) => x.id === trackId)
      if (!t) return
      t.volume = Math.min(MAX_TRACK_VOLUME, Math.max(0, volume))
      log.debug('project', `setTrackVolume id=${trackId} volume=${t.volume}`)
      sendBridge('TRACK_GAIN', { trackId, gain: t.volume })
    },

    setTrackVolumeLocal(trackId: string, volume: number): void {
      const t = this.tracks.find((x) => x.id === trackId)
      if (!t) return
      t.volume = Math.min(MAX_TRACK_VOLUME, Math.max(0, volume))
    },

    /** Local-only row resize preview; commit once on pointerup. */
    setTrackHeightLocal(trackId: string, heightPx: number): void {
      const t = this.tracks.find((x) => x.id === trackId)
      if (!t) return
      t.heightPx = heightPx
    },

    /** Commit row height; PROJECT_STATE ack returns any backend clamp. */
    setTrackHeight(trackId: string, heightPx: number): void {
      const t = this.tracks.find((x) => x.id === trackId)
      if (!t) return
      t.heightPx = heightPx
      sendBridge('TRACK_SET_HEIGHT', { trackId, heightPx })
    },

    /** Optimistically reorder tracks; soft-replace PROJECT_STATE restores undo/redo order. */
    reorderTrack(trackId: string, newIndex: number): void {
      const currentIndex = this.tracks.findIndex((t) => t.id === trackId)
      if (currentIndex < 0) return
      const clamped = Math.max(0, Math.min(this.tracks.length - 1, Math.floor(newIndex)))
      if (clamped === currentIndex) return
      const [moved] = this.tracks.splice(currentIndex, 1)
      if (!moved) return
      this.tracks.splice(clamped, 0, moved)
      this.timelineRevision++
      sendBridge('TRACK_REORDER', { trackId, newIndex: clamped })
    },

    setTrackColor(trackId: string, colorIndex: number): void {
      const t = this.tracks.find((x) => x.id === trackId)
      if (!t) return
      if (colorIndex < 0 || colorIndex >= TRACK_PALETTE.length) return
      t.colorIndex = colorIndex
      log.info('project', `setTrackColor id=${trackId} colorIndex=${colorIndex}`)
    },

    setTrackName(trackId: string, name: string): void {
      const t = this.tracks.find((x) => x.id === trackId)
      if (!t) return
      const trimmed = name.trim()
      if (trimmed.length === 0) return
      if (t.name === trimmed) return
      t.name = trimmed
      sendBridge('TRACK_RENAME', { trackId, name: trimmed })
      log.info('project', `setTrackName id=${trackId} name="${trimmed}"`)
    },
} satisfies Record<string, (this: TrackActionsThis, ...args: never[]) => unknown> &
  ThisType<TrackActionsThis>

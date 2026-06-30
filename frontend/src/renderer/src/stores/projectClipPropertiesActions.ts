// Per-clip property actions for the project store: colour, lock, reverse,
// rename, and peak ingestion.
// Spread into the store's `actions`; call sites stay `useProjectStore().X(...)`.
// `this` is the store instance, typed via the shared ProjectClipThis contract.

import { send as sendBridge } from '@/lib/bridgeService'
import { log } from '@/lib/log'
import { useLibraryStore } from '@/stores/libraryStore'
import { TRACK_PALETTE } from './projectTypes'
import type { ProjectClipThis } from './projectClipContract'

export const clipPropertiesActions = {
    /** Set or clear a persisted per-clip colour override. */
    setClipColor(clipId: string, colorIndex: number | null): void {
      const clip = this.clips[clipId]
      if (!clip) return
      if (colorIndex === null) {
        if (clip.colorIndex === undefined) return
        clip.colorIndex = undefined
        // Historical redraw counter for non-positional visual changes.
        this.peaksRevision++
        sendBridge('CLIP_COLOR', { clipId, colorIndex: -1 })
        log.info('project', `setClipColor id=${clipId} -> inherit`)
        return
      }
      const clamped = Math.max(0, Math.min(TRACK_PALETTE.length - 1, Math.round(colorIndex)))
      if (clip.colorIndex === clamped) return
      clip.colorIndex = clamped
      this.peaksRevision++
      sendBridge('CLIP_COLOR', { clipId, colorIndex: clamped })
      log.info('project', `setClipColor id=${clipId} -> ${clamped}`)
    },

    /** Persist per-clip lock state; project mutation actions honor it locally. */
    setClipLocked(clipId: string, locked: boolean): void {
      const clip = this.clips[clipId]
      if (!clip) return
      const next = locked === true
      const current = clip.locked === true
      if (next === current) return
      clip.locked = next ? true : undefined
      this.peaksRevision++
      sendBridge('CLIP_SET_LOCKED', { clipId, locked: next })
      log.info('project', `setClipLocked id=${clipId} -> ${next ? 'locked' : 'unlocked'}`)
    },

    /** Persist per-clip reverse state; non-destructive, plays the clip window backwards. */
    setClipReversed(clipId: string, reversed: boolean): void {
      const clip = this.clips[clipId]
      if (!clip) return
      const next = reversed === true
      const current = clip.reversed === true
      if (next === current) return
      clip.reversed = next ? true : undefined
      this.peaksRevision++
      sendBridge('CLIP_SET_REVERSED', { clipId, reversed: next })
      log.info('project', `setClipReversed id=${clipId} -> ${next ? 'reversed' : 'forward'}`)
    },

    /** Toggle a per-clip turntable brake (record-stop). A per-instance timeline effect:
     *  when on, the clip decelerates to a stop over a fixed platter-stop time at its end.
     *  Applies to forward, non-warped clips only. Mutually exclusive with backspin. */
    setClipBrake(clipId: string, on: boolean): void {
      const clip = this.clips[clipId]
      if (!clip) return
      const next = on === true
      const current = clip.brake === true
      if (next === current) return
      clip.brake = next ? true : undefined
      // Brake and backspin are mutually exclusive; the backend clears the other,
      // so mirror that locally to keep the UI in sync.
      if (next) clip.backspin = undefined
      this.peaksRevision++
      sendBridge('CLIP_SET_BRAKE', { clipId, on: next })
      log.info('project', `setClipBrake id=${clipId} -> ${next ? 'on' : 'off'}`)
    },

    /** Toggle a per-clip turntable backspin (reverse rewind). At the clip's end the
     *  audio rewinds backwards at speed and slows to a stop, like a DJ pulling the
     *  vinyl back. Forward, non-warped clips only. Mutually exclusive with brake. */
    setClipBackspin(clipId: string, on: boolean): void {
      const clip = this.clips[clipId]
      if (!clip) return
      const next = on === true
      const current = clip.backspin === true
      if (next === current) return
      clip.backspin = next ? true : undefined
      if (next) clip.brake = undefined
      this.peaksRevision++
      sendBridge('CLIP_SET_BACKSPIN', { clipId, on: next })
      log.info('project', `setClipBackspin id=${clipId} -> ${next ? 'on' : 'off'}`)
    },

    /** Set or clear a persisted clip display-name override. */
    renameClip(clipId: string, name: string): boolean {
      const clip = this.clips[clipId]
      if (!clip) return false
      const trimmed = name.trim()
      const nextName = trimmed.length > 0 ? trimmed : undefined
      if (clip.name === nextName) return false
      clip.name = nextName
      this.peaksRevision++
      sendBridge('CLIP_RENAME', { clipId, name: nextName ?? '' })
      log.info('project', `renameClip id=${clipId} -> ${nextName ?? '<cleared>'}`)
      return true
    },

    /** Apply WAVEFORM_DATA peaks; unknown clips may have been removed. */
    setClipPeaks(
      clipId: string,
      peaks: Float32Array,
      sampleRate: number,
      peaksPerSecond?: number,
      channels?: Float32Array[]
    ): void {
      const clip = this.clips[clipId]
      if (!clip) return
      clip.peaks = peaks
      if (typeof peaksPerSecond === 'number' && peaksPerSecond > 0) clip.peaksPerSecond = peaksPerSecond
      if (sampleRate > 0) clip.sampleRate = sampleRate
      // A revision counter avoids deep-watching clips for waveform redraws.
      this.peaksRevision++
      // Prefer the whole-file library row; saved clips can share its filePath.
      const lib = useLibraryStore()
      const item =
        lib.items.find((i) => (i.kind === 'source' || i.kind === 'sample') && i.filePath === clip.filePath) ??
        lib.items.find((i) => i.filePath === clip.filePath)
      if (item && item.peaks.length === 0) {
        lib.setItemPeaks(item.id, peaks, sampleRate, peaksPerSecond)
      }
      // Empty channel lanes clear stale stereo peaks for summary-only sources.
      if (item && typeof peaksPerSecond === 'number' && peaksPerSecond > 0) {
        lib.setItemChannelPeaks(item.id, channels ?? [], peaksPerSecond)
      }
      log.debug('project', `setClipPeaks id=${clipId} peaks=${peaks.length / 2} sr=${sampleRate} pps=${clip.peaksPerSecond ?? 'undef'}`)
    }
} satisfies Record<string, (this: ProjectClipThis, ...args: never[]) => unknown> &
  ThisType<ProjectClipThis>

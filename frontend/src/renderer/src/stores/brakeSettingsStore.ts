// Global turntable-brake defaults (an app preference). Mirrors the persisted
// `prefs.brake` presets, resolves them to the numeric platter-stop time + rate-
// curve power the backend and timeline overlay use, and pushes them to the
// backend live and on every (re)connect — the same pattern as keep-awake.

import { defineStore } from 'pinia'
import { send as sendBridge } from '@/lib/bridgeService'
import { log } from '@/lib/log'
import type { BrakeDurationDto, BrakeCurveDto } from '@shared/types'

// Preset → numeric mappings. The backend clamps independently; these are the
// single source of truth the renderer sends and draws.
export const BRAKE_DURATION_SECONDS: Record<BrakeDurationDto, number> = {
  short: 0.4,
  medium: 0.6,
  long: 0.9
}
export const BRAKE_CURVE_POWER: Record<BrakeCurveDto, number> = {
  linear: 1,
  curved: 2,
  steep: 3
}

interface BrakeSettingsState {
  duration: BrakeDurationDto
  curve: BrakeCurveDto
}

export const useBrakeSettingsStore = defineStore('brakeSettings', {
  state: (): BrakeSettingsState => ({ duration: 'medium', curve: 'curved' }),
  getters: {
    /** Platter stop time in seconds for the current duration preset. */
    seconds: (s): number => BRAKE_DURATION_SECONDS[s.duration],
    /** Rate-curve power for the current curve preset. */
    curvePower: (s): number => BRAKE_CURVE_POWER[s.curve]
  },
  actions: {
    /** Push the current resolved settings to the backend. */
    sendToBackend(): void {
      sendBridge('BRAKE_SETTINGS_SET', { seconds: this.seconds, curve: this.curvePower })
    },

    /** Persist + apply new presets; pushes them to the backend live. */
    setBrakeSettings(duration: BrakeDurationDto, curve: BrakeCurveDto): void {
      this.duration = duration
      this.curve = curve
      window.silverdaw.setBrakeSettings({ duration, curve })
      this.sendToBackend()
    },

    /**
     * On every bridge (re)connect the backend starts at its built-in default, so
     * re-send the user's persisted brake settings once the engine is ready.
     */
    async applyBrakeSettingsOnReady(): Promise<void> {
      try {
        const prefs = await window.silverdaw.getBrakeSettings()
        this.duration = prefs.duration
        this.curve = prefs.curve
      } catch (err) {
        log.warn('brake', `brake settings hydrate failed, using defaults: ${String(err)}`)
        this.duration = 'medium'
        this.curve = 'curved'
      }
      this.sendToBackend()
    }
  }
})

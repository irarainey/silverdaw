// Global turntable-backspin defaults (an app preference). Mirrors the persisted
// `prefs.backspin` presets, resolves them to the numeric spin duration + peak
// reverse speed the backend and timeline overlay use, and pushes them to the
// backend live and on every (re)connect — the same pattern as the brake.

import { defineStore } from 'pinia'
import { send as sendBridge } from '@/lib/bridgeService'
import { log } from '@/lib/log'
import type { BackspinDurationDto, BackspinIntensityDto } from '@shared/types'

// Preset → numeric mappings. The backend clamps independently; these are the
// single source of truth the renderer sends and draws.
export const BACKSPIN_DURATION_SECONDS: Record<BackspinDurationDto, number> = {
  short: 0.4,
  medium: 0.6,
  long: 0.9
}
export const BACKSPIN_INTENSITY_SPEED: Record<BackspinIntensityDto, number> = {
  gentle: 4,
  medium: 6,
  wild: 8
}
// Momentum-decay curve power. Fixed (not exposed) to keep the preference to two knobs.
export const BACKSPIN_CURVE_POWER = 2

interface BackspinSettingsState {
  duration: BackspinDurationDto
  intensity: BackspinIntensityDto
}

export const useBackspinSettingsStore = defineStore('backspinSettings', {
  state: (): BackspinSettingsState => ({ duration: 'long', intensity: 'medium' }),
  getters: {
    /** Spin duration in seconds for the current duration preset. */
    seconds: (s): number => BACKSPIN_DURATION_SECONDS[s.duration],
    /** Peak reverse speed (x normal) for the current intensity preset. */
    speed: (s): number => BACKSPIN_INTENSITY_SPEED[s.intensity],
    /** Momentum-decay curve power. */
    curvePower: (): number => BACKSPIN_CURVE_POWER
  },
  actions: {
    /** Push the current resolved settings to the backend. */
    sendToBackend(): void {
      sendBridge('BACKSPIN_SETTINGS_SET', {
        seconds: this.seconds,
        speed: this.speed,
        curve: this.curvePower
      })
    },

    /** Persist + apply new presets; pushes them to the backend live. */
    setBackspinSettings(duration: BackspinDurationDto, intensity: BackspinIntensityDto): void {
      this.duration = duration
      this.intensity = intensity
      window.silverdaw.setBackspinSettings({ duration, intensity })
      this.sendToBackend()
    },

    /**
     * On every bridge (re)connect the backend starts at its built-in default, so
     * re-send the user's persisted backspin settings once the engine is ready.
     */
    async applyBackspinSettingsOnReady(): Promise<void> {
      try {
        const prefs = await window.silverdaw.getBackspinSettings()
        this.duration = prefs.duration
        this.intensity = prefs.intensity
      } catch (err) {
        log.warn('backspin', `backspin settings hydrate failed, using defaults: ${String(err)}`)
        this.duration = 'long'
        this.intensity = 'medium'
      }
      this.sendToBackend()
    }
  }
})

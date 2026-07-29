// Playwright configuration for the Electron end-to-end tier.
//
// This is the integration tier that ADR 0014 anticipates ("Playwright for
// Electron e2e is planned"). It does NOT replace Vitest: unit and store logic
// stays under `tests/**/*.test.ts` (run by `pnpm test`), and this tier covers
// only cross-process wiring that unit tests structurally cannot reach — real
// window creation, real IPC, and a real JUCE backend over the bridge.
//
// Specs are `e2e/**/*.e2e.ts` so the two tiers can never collect each other's
// files: Vitest globs `tests/**/*.test.ts`, Playwright globs the below.

import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',

  // Each spec launches a real Electron app that spawns a real audio engine and
  // opens an output device. Parallel workers would contend for the audio device
  // and multiply cold-launch cost, so the tier is deliberately serial.
  fullyParallel: false,
  workers: 1,

  // A cold launch pays for backend spawn (deferred until the window paints),
  // bridge AUTH, and audio-device open, so allow well beyond a UI-only budget.
  timeout: 90_000,
  expect: { timeout: 20_000 },

  // Fail fast on an accidentally committed `test.only`.
  forbidOnly: Boolean(process.env['CI']),
  retries: process.env['CI'] ? 1 : 0,

  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : [['list']],

  use: {
    // Traces make a cross-process failure diagnosable after the fact; combined
    // with the app's own diagnostics log (attached by the fixture on failure)
    // a red run explains itself without a local repro.
    trace: 'retain-on-failure'
  }
})

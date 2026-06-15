import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './assets/style.css'
import { useAppStore } from './stores/appStore'
import { log, setLogEnabled } from './lib/log'

// Surface otherwise-invisible failures. Exceptions thrown inside rAF callbacks
// (e.g. a timeline redraw) reach neither Vue's error handler nor any try/catch,
// so without these listeners they only appear in the DevTools console and never
// in the diagnostic logs — which is exactly what made the "waveforms go black"
// blackout impossible to diagnose from log files alone.
function installGlobalErrorLogging(): void {
  window.addEventListener('error', (event) => {
    const e = event.error
    const detail = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(event.message)
    log.error('renderer', `uncaught error: ${detail}`)
  })
  window.addEventListener('unhandledrejection', (event) => {
    const r = event.reason
    const detail = r instanceof Error ? `${r.message}\n${r.stack ?? ''}` : String(r)
    log.error('renderer', `unhandled rejection: ${detail}`)
  })
}

// Bootstrap order matters here: the appStore caches the startup developer
// prefs and the renderer logger gates on them. Both need to be settled
// BEFORE `App.vue` mounts so `AppTitleBar` builds the correct menu list
// from the very first render (otherwise the Debug menu would flicker on
// DevTools-enabled sessions and the early `log.info('app', 'mounted')`
// calls would slip through as no-ops on disabled sessions but still
// hit the IPC layer on enabled ones).
async function bootstrap(): Promise<void> {
  // Wire the static splash's close button (declared in `index.html`) to
  // the same quit path as the title-bar ×. It only needs to work during
  // the brief window before `app.mount()` swaps the splash markup out for
  // the Vue tree, but the hydrate() await below can keep the static
  // splash on screen long enough that a user may want to bail early.
  document
    .getElementById('splash-close')
    ?.addEventListener('click', () => window.silverdaw.closeWindow())

  const app = createApp(App)
  const pinia = createPinia()
  app.use(pinia)

  // Pinia must be installed before any `useStore()` call resolves;
  // `useAppStore()` only works after `app.use(pinia)` above.
  const appStore = useAppStore()
  await appStore.hydrate()
  setLogEnabled(appStore.loggingEnabled)
  installGlobalErrorLogging()

  app.mount('#app')
}

void bootstrap()

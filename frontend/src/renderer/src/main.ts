import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './assets/style.css'
import { useAppStore } from './stores/appStore'
import { vSliderDetent } from './directives/vSliderDetent'
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
// BEFORE `App.vue` mounts so shortcut registration and the renderer logger use
// the startup snapshot from the first render.
async function bootstrap(): Promise<void> {
  // Wire the static splash's window controls (declared in `index.html`) to the same
  // paths as the title-bar buttons, so a user can minimise, maximise, or quit during
  // the brief pre-mount window.
  document
    .getElementById('splash-minimize')
    ?.addEventListener('click', () => window.silverdaw.minimizeWindow())
  document
    .getElementById('splash-maximize')
    ?.addEventListener('click', () => window.silverdaw.toggleMaximizeWindow())
  document
    .getElementById('splash-close')
    ?.addEventListener('click', () => window.silverdaw.closeWindow())

  const app = createApp(App)
  const pinia = createPinia()
  app.use(pinia)

  // Global centre-detent + double-click-reset behaviour for range sliders.
  app.directive('slider-detent', vSliderDetent)

  // Capture uncaught errors from the first frame onward.
  installGlobalErrorLogging()

  // Mount IMMEDIATELY behind the static splash — do NOT block first paint on the startup
  // preference/recents IPC. The appStore hydrates AFTER mount and the shell reconciles
  // reactively: the title-bar menu (Debug entries), recent-projects list, and the renderer
  // logger all update the moment hydrate() resolves. This removes the batched 4-IPC call
  // from the mount critical path.
  const appStore = useAppStore()
  app.mount('#app')

  void appStore.hydrate().then(() => {
    setLogEnabled(appStore.loggingEnabled)
    log.info('perf', `renderer hydrate reconciled @ ${Math.round(performance.now())}ms`)
  })
}

void bootstrap()

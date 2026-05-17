import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './assets/style.css'
import { useAppStore } from './stores/appStore'
import { setLogEnabled } from './lib/log'

// Bootstrap order matters here: the appStore caches the startup debug
// flag and the renderer logger gates on it. Both need to be settled
// BEFORE `App.vue` mounts so `AppTitleBar` builds the correct menu list
// from the very first render (otherwise the Debug menu would flicker on
// debug-enabled sessions and the early `log.info('app', 'mounted')`
// calls would slip through as no-ops on disabled sessions but still
// hit the IPC layer on enabled ones).
async function bootstrap(): Promise<void> {
  const app = createApp(App)
  const pinia = createPinia()
  app.use(pinia)

  // Pinia must be installed before any `useStore()` call resolves;
  // `useAppStore()` only works after `app.use(pinia)` above.
  const appStore = useAppStore()
  await appStore.hydrate()
  setLogEnabled(appStore.debugMode)

  app.mount('#app')
}

void bootstrap()

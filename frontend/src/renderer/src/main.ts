// PixiJS v8 ships a CSP-safe ("unsafe-eval"-free) shader system as an opt-in
// side-effect import. Electron's renderer disallows `unsafe-eval` by default,
// which breaks PixiJS's default uniform-setter generator. Must be imported
// before any `Application` / renderer is created.
import 'pixi.js/unsafe-eval'

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './assets/style.css'

const app = createApp(App)
app.use(createPinia())
app.mount('#app')

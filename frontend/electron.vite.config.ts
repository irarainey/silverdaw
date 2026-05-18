import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    plugins: [
      // Bundle `music-metadata` (the main process's only npm-published
      // runtime dep) into `out/main/index.js` instead of leaving it as
      // a runtime `require()`. electron-builder's production-dependency
      // walker has flaky support for pnpm's node_modules topology —
      // even in `nodeLinker: hoisted` mode it silently drops transitive
      // deps (we hit it with `ieee754` under `token-types` under
      // `music-metadata`), producing a packaged app that crashes on
      // launch with "Cannot find package '<x>'". Inlining the dep + its
      // entire tree side-steps the walker entirely. Pure-JS deps only;
      // anything native would need to stay external.
      externalizeDepsPlugin({ exclude: ['music-metadata'] })
    ],
    build: {
      outDir: 'out/main'
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      // Force CommonJS output for the preload bundle. The renderer runs with
      // `sandbox: true` (see frontend/src/main/index.ts), and Electron only
      // accepts CJS preload scripts in sandboxed renderers — an ESM preload
      // is silently rejected, which leaves `window.silverdaw` undefined and
      // every menu-driven IPC call (Import, Toggle DevTools, …) no-ops.
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs'
        }
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    // Serve the icons folder as a Vite public dir so `index.html` can
    // load the logo before any Vue / Tailwind code has evaluated — the
    // static splash inside `<div id="app">` needs the image at a
    // fetchable URL from the very first paint, and the standard
    // `@resources` alias only works for code that goes through the
    // module graph.
    publicDir: resolve(__dirname, 'resources/icons'),
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer/src'),
        '@shared': resolve(__dirname, 'src/shared'),
        // Icons + future static assets live at the project root (outside
        // `src/renderer/`) so the main process can also reach them via
        // `app.getAppPath()`. Renderer code imports them through this
        // alias and Vite handles the asset URL generation.
        '@resources': resolve(__dirname, 'resources')
      }
    },
    plugins: [vue(), tailwindcss()],
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html')
        }
      }
    }
  }
})

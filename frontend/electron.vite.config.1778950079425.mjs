// electron.vite.config.ts
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";
var __electron_vite_injected_dirname = "C:\\Users\\ira\\code\\silverdaw\\frontend";
var electron_vite_config_default = defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "out/main"
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "out/preload",
      // Force CommonJS output for the preload bundle. The renderer runs with
      // `sandbox: true` (see frontend/src/main/index.ts), and Electron only
      // accepts CJS preload scripts in sandboxed renderers — an ESM preload
      // is silently rejected, which leaves `window.silverdaw` undefined and
      // every menu-driven IPC call (Import, Toggle DevTools, …) no-ops.
      rollupOptions: {
        output: {
          format: "cjs",
          entryFileNames: "[name].cjs"
        }
      }
    }
  },
  renderer: {
    root: "src/renderer",
    resolve: {
      alias: {
        "@": resolve(__electron_vite_injected_dirname, "src/renderer/src"),
        "@shared": resolve(__electron_vite_injected_dirname, "src/shared")
      }
    },
    plugins: [vue(), tailwindcss()],
    build: {
      outDir: "out/renderer",
      rollupOptions: {
        input: {
          index: resolve(__electron_vite_injected_dirname, "src/renderer/index.html")
        }
      }
    }
  }
});
export {
  electron_vite_config_default as default
};

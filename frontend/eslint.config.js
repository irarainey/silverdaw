import js from '@eslint/js'
import vue from 'eslint-plugin-vue'
import vueParser from 'vue-eslint-parser'
import tsParser from '@typescript-eslint/parser'
import tsPlugin from '@typescript-eslint/eslint-plugin'
import globals from 'globals'

export default [
  {
    ignores: ['out/**', 'dist/**', 'coverage/**', 'node_modules/**']
  },
  js.configs.recommended,
  ...vue.configs['flat/recommended'],
  // TypeScript files (Electron main + preload run in Node; renderer TS runs in the browser).
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module'
      },
      globals: {
        ...globals.node,
        ...globals.browser
      }
    },
    plugins: {
      '@typescript-eslint': tsPlugin
    },
    rules: {
      // Defer to typescript-eslint's variant so TS-specific constructs
      // (declared module augmentations, interface members, etc.) aren't flagged.
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ],
      // TypeScript's own checker catches undefined identifiers (including
      // ambient globals declared in `env.d.ts`) far better than ESLint's
      // core rule, which can't see `declare global { … }`. The official
      // typescript-eslint guidance is to disable this rule for TS files.
      'no-undef': 'off'
    }
  },
  // Vue SFCs: parsed by vue-eslint-parser; <script lang="ts"> delegated to TS parser.
  {
    files: ['**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        parser: tsParser,
        ecmaVersion: 'latest',
        sourceType: 'module',
        extraFileExtensions: ['.vue']
      },
      globals: {
        ...globals.browser
      }
    },
    plugins: {
      '@typescript-eslint': tsPlugin
    },
    rules: {
      // Multi-word names are best practice (avoids clashes with native HTML
      // elements). Allow `App` for the conventional root-component name —
      // re-enabling globally would force `TheApp`/`AppRoot` style renames
      // that just add noise.
      'vue/multi-word-component-names': ['error', { ignores: ['App'] }],
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ]
    }
  },
  // Ambient declaration files: relax unused-var rules since interfaces/types
  // are not "used" in the runtime sense. TypeScript itself catches undefined
  // identifiers here far better than core ESLint can.
  {
    files: ['**/*.d.ts'],
    rules: {
      'no-undef': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': 'off'
    }
  },
  // Renderer source: forbid direct console.* calls so all observability
  // flows through `lib/log.ts` (which forwards to the per-session file
  // logger via IPC). `lib/log.ts` itself is the only allowed exception
  // — it falls back to console.warn when the IPC flush itself fails.
  {
    files: ['src/renderer/**/*.{ts,vue}'],
    ignores: ['src/renderer/src/lib/log.ts'],
    rules: {
      'no-console': 'error'
    }
  }
]

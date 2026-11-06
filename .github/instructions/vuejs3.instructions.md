---
description: "VueJS 3 development standards and best practices with Composition API and TypeScript"
applyTo: "**/*.vue, **/*.ts, **/*.js, **/*.scss"
---

# VueJS 3 Development Instructions

Instructions for building high-quality VueJS 3 applications with the Composition API, TypeScript, and modern best practices.

## Project Context

- Vue 3.x with Composition API as default
- TypeScript for type safety
- Single File Components (`.vue`) with `<script setup>` syntax
- Existing electron-vite / Vite build; Windows desktop only
- Pinia for application state management
- Official Vue style guide and best practices
- **Package manager: pnpm only.** Always use `pnpm` for installing dependencies and running scripts (`pnpm install`, `pnpm run <script>`, `pnpm dlx`). Never use `npm` (or `yarn`) in this repo — the lockfile is `pnpm-lock.yaml` and mixing managers corrupts it.

## Development Standards

### Architecture

- Favor the Composition API (`setup` functions and composables) over the Options API
- Organize components and composables by feature or domain for scalability
- Separate UI-focused components (presentational) from logic-focused components (containers)
- Keep composables in the existing domain folders under `renderer/src/lib/`
- Structure store modules (Pinia) by domain, with clearly defined actions, state, and getters

### TypeScript Integration

- Enable `strict` mode in `tsconfig.json` for maximum type safety
- Use `defineComponent` or `<script setup lang="ts">` with `defineProps` and `defineEmits`
- Leverage `PropType<T>` for typed props and default values
- Use interfaces or type aliases for complex prop and state shapes
- Define types for event handlers, refs, shared bridge payloads and preload IPC
- Implement generic components and composables where applicable

### Component Design

Follow **ADR 0016** (`docs/adr/0016-maintainability-file-size.md`) for the
maintainability gate. Vue specifics:

- Soft ceiling **~250 lines** per SFC; ~800 is a hard trigger. When over budget,
  extract child components for distinct UI regions and lift logic into `useXxx`
  composables, keeping `<template>` thin — preserve emitted events, props, and
  watcher timing exactly (no behaviour change; keep `pnpm typecheck` / `lint` /
  `test` green).
- Each domain (timeline, clip editor, library, transport, …) in its own
  component / composable / store; keep presentation ↔ store ↔ preload ↔ main
  boundaries clean and cross-domain coupling explicit.
- Use `<script setup>` and PascalCase `.vue` component filenames; match
  neighbouring TypeScript helper/composable filenames.
- Validate props with TypeScript; use runtime checks only when necessary.
- Favour slots and scoped slots for flexible composition.

### State Management

- Use Pinia for global state: define stores with `defineStore`
- For simple local state, use `ref` and `reactive` within `setup`
- Use `computed` for derived state
- Keep state normalized for complex structures
- Use actions in Pinia stores for asynchronous logic
- Mirror persisted project state from the backend ValueTree. Preferences go
  through the existing main/preload IPC; do not add Pinia persistence plugins
  that create a second source of truth.

### Composition API Patterns

- Create reusable composables for shared logic, e.g., `useFetch`, `useAuth`
- Use `watch` and `watchEffect` with precise dependency lists
- Cleanup side effects in `onUnmounted` or `watch` cleanup callbacks
- Use `provide`/`inject` sparingly for deep dependency injection
- Reuse existing async composables and bridge/IPC services; Nuxt and Vue Query
  are not part of this application.

### Styling

- Use `<style scoped>` for component-level styles or CSS Modules
- Consider utility-first frameworks (Tailwind CSS) for rapid styling
- Follow BEM or functional CSS conventions for class naming
- Leverage CSS custom properties for theming and design tokens
- Adapt CSS Grid/Flexbox layouts to resizable Windows desktop panels
- Ensure styles are accessible (contrast, focus states)

### Performance Optimization

- Lazy-load components with dynamic imports and `defineAsyncComponent`
- Use `<Suspense>` for async component loading fallbacks
- Apply `v-once` and `v-memo` for static or infrequently changing elements
- Profile with Vue DevTools Performance tab
- Avoid unnecessary watchers; prefer `computed` where possible
- Tree-shake unused code and leverage Vite’s optimization features

### Data Fetching

- Use the existing bridge/IPC and model-download flows, not a new web data layer
- Handle loading, error, and success states explicitly
- Cancel stale requests on component unmount or param change
- Implement optimistic updates with rollbacks on failure
- Preserve existing cache ownership and invalidation; do not add persistent
  caching where only in-flight work is shared.

### Error Handling

- Use global error handler (`app.config.errorHandler`) for uncaught errors
- Wrap risky logic in `try/catch`; provide user-friendly messages
- Use `errorCaptured` hook in components for local boundaries
- Display fallback UI or error alerts gracefully
- Use the existing local logging and notification helpers; do not introduce
  external telemetry or upload diagnostic data.

### Forms and Validation

- Reuse existing field validators and shared schemas; no additional form
  framework is installed.
- Build forms with controlled `v-model` bindings
- Validate on blur or input with debouncing for performance
- Handle native file-picking and transactional forms through existing composables
- Ensure accessible labeling, error announcements, and focus management

### Navigation

- Silverdaw is a desktop SPA without Vue Router or browser-history routes.
- Reuse `App.vue`, the existing domain stores and dialog/panel state for
  navigation. Do not introduce a router or hosted/web assumptions.

### Testing

Follow **ADR 0014** (`docs/adr/0014-testing-strategy.md`). Vue specifics:

- Vitest runs in a `node` environment and Vue Test Utils is **not** installed, so
  test composables and stores directly (`effectScope()` for a composable that
  registers scope hooks) and leave rendered-component behaviour to the e2e tier.
- Playwright (`frontend/e2e/`) is the tier that drives real components in the
  built app; a DOM-level defect belongs there.

### Security

- Avoid using `v-html`; sanitize any HTML inputs rigorously
- Use CSP headers to mitigate XSS and injection attacks
- Validate and escape data in templates and directives
- Use HTTPS for external model downloads. The local bridge intentionally uses
  authenticated loopback `ws://` with a dynamic port.
- Keep the per-session AUTH token in the existing main/preload handoff; do not
  persist it in localStorage or introduce a web cookie/session layer.

### Accessibility

- Use semantic HTML elements and ARIA attributes
- Manage focus for modals and dynamic content
- Provide keyboard navigation for interactive components
- Add meaningful `alt` text for images and icons
- Ensure color contrast meets WCAG AA standards

## Implementation Process

1. Plan component and composable architecture
2. Locate the existing domain components, composables and shared helpers
3. Define Pinia stores and composables
4. Create core UI components and layout
5. Integrate with existing panel/dialog navigation
6. Wire bridge/IPC state logic without duplicating authoritative state
7. Build forms with validation and error states
8. Add global error handling and fallback UIs
9. Add unit and E2E tests
10. Optimize performance and bundle size
11. Ensure accessibility compliance
12. Document components, composables, and stores

## Additional Guidelines

- Follow Vue’s official style guide (vuejs.org/style-guide)
- Use the existing ESLint flat configuration and Prettier settings
- Write meaningful commit messages and maintain clean git history
- Keep dependencies up to date and audit for vulnerabilities
- Keep comments short and minimal — one line wherever possible. Default to no
  comment; comment the *why*, never the *what*, and avoid verbose blocks.
  Prioritise documentation over comments for substantial information, and
  condense existing comments rather than letting them grow.
- Use Vue DevTools for debugging and profiling

## Common Patterns

- Renderless components and scoped slots for flexible UI
- Compound components using provide/inject
- Custom directives for cross-cutting concerns
- Teleport for modals and overlays
- Existing app-level providers and shared helpers, without adding global services
- Composable factories for parameterized logic

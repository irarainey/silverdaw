// Shared Tailwind class strings for the compact library pills (BPM, sample, …).
// Centralised so the library-panel tiles and the item info dialog render visually
// identical badges from one source of truth, rather than re-declaring the literals.

/** Base pill: shape, padding, tiny type — the variant colours are appended. */
export const LIBRARY_PILL_BASE_CLASS =
  'shrink-0 whitespace-nowrap rounded border px-1 py-0.5 text-[9px] leading-none shadow-sm'

/** Detected-tempo BPM pill (steady tempo). */
export const LIBRARY_BPM_PILL_CLASS = `${LIBRARY_PILL_BASE_CLASS} border-zinc-700 bg-zinc-800 text-zinc-300`

/** BPM pill for a variable-tempo source — the shown BPM is a rough average. */
export const LIBRARY_BPM_VARIABLE_PILL_CLASS =
  `${LIBRARY_PILL_BASE_CLASS} border-amber-800 bg-amber-900/60 text-amber-200`

/** Non-musical "Sample" classification pill. */
export const LIBRARY_SAMPLE_PILL_CLASS =
  `${LIBRARY_PILL_BASE_CLASS} border-indigo-800 bg-indigo-900/60 text-indigo-200`

<script setup lang="ts">
// The "this tempo was detected wrongly" affordance (ADR 0027), shared by every surface
// that offers it: the Clip Editor's beat grid and the Edit BPM dialog.
//
// Purely presentational. Each host works out whether a correction is available and how
// to apply it — the Clip Editor has a grid draft to unwind first, the Edit BPM dialog
// does not — but the wording and the consequences the user is shown must be identical
// wherever they read them, so they live here once.
//
// There is no project-tempo question here. The project tempo is seeded from the first
// musical clip as a one-time convenience, which makes it the user's number rather than
// the file's, so a correction to a file is not evidence about what the project should
// play at. Offering to move it turned one clear action into two coupled ones and put
// the arrangement at risk for a case the user can settle directly in the transport.

const props = defineProps<{
  /** The tempo the surface opened with — the number believed to be wrong. */
  originalBpm: number | null
  /** The tempo the user has typed. */
  correctedBpm: number
  /** Set when the tempo is inherited, naming the item that actually owns it. */
  ownerName: string | null
  /** True when the owner's tempo comes from a recorded musical length. */
  fromMusicalLength: boolean
  /**
   * Whether to draw the apply button. A host with a primary action of its own — the
   * Edit BPM dialog's Save — commits from that instead, so that a dialog never shows
   * two buttons which both write.
   */
  showApply?: boolean
}>()

const emit = defineEmits<{
  (e: 'apply'): void
}>()

function bpmText(value: number | null): string {
  return value !== null && Number.isFinite(value) ? value.toFixed(2) : '—'
}
</script>

<template>
  <div
    data-testid="tempo-correction"
    class="mt-1 flex flex-col gap-2 rounded border border-zinc-700 bg-zinc-900/60 p-2"
  >
    <p class="text-[11px] text-zinc-300">
      Is {{ bpmText(props.originalBpm) }} BPM wrong? Setting it to
      {{ bpmText(props.correctedBpm) }} BPM keeps every clip start, marker and automation
      point exactly where it is.
    </p>
    <p
      v-if="props.ownerName"
      class="text-[10px] text-zinc-400"
    >
      This tempo comes from {{ props.ownerName }}, so the correction is applied there and
      fixes everything cut from it.
    </p>
    <p
      v-if="props.fromMusicalLength"
      data-testid="tempo-correction-musical-length"
      class="text-[10px] text-amber-400"
    >
      This tempo is measured from a recorded musical length. Correcting it discards
      that measurement, which can change the item's bar length.
    </p>
    <p
      data-testid="tempo-correction-project-note"
      class="text-[10px] text-zinc-500"
    >
      The project tempo is separate and is not changed. Set it in the transport bar if it
      needs correcting too.
    </p>

    <button
      v-if="props.showApply !== false"
      type="button"
      data-testid="tempo-correction-apply"
      class="self-start rounded border border-sky-600 bg-sky-600/20 px-2 py-1 text-[11px] text-sky-200 transition-colors hover:border-sky-500 hover:bg-sky-600/30 hover:text-zinc-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-400"
      @click="emit('apply')"
    >
      Correct Tempo
    </button>
  </div>
</template>

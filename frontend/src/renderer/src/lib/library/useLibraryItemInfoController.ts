import { computed, onBeforeUnmount, onMounted, watch, type Ref } from 'vue'
import { useProjectStore, type Clip } from '@/stores/projectStore'
import { libraryItemDisplayName, libraryItemIsSample, useLibraryStore, type LibraryItem } from '@/stores/libraryStore'
import { useTransportStore } from '@/stores/transportStore'
import { keyBadgeClass } from '@/lib/keyBadge'
import { shiftedKey } from '@/lib/pitchKey'
import { effectiveTempoRatio } from '@/lib/warp'

export type LibraryItemInfoProps = {
  open: boolean
  item: LibraryItem | null
  clipId?: string | null
}

export type LibraryItemInfoEmit = {
  (e: 'close'): void
}

export function useLibraryItemInfoController(
  props: Readonly<LibraryItemInfoProps>,
  emit: LibraryItemInfoEmit,
  dialogEl: Ref<HTMLDivElement | null>
) {
  const project = useProjectStore()
  const library = useLibraryStore()
  const transport = useTransportStore()
  const clip = computed(() => props.clipId ? project.clips[props.clipId] ?? null : null)
  const sourceItem = computed(() => {
    const item = props.item
    if (!item?.derivedFrom?.sourceItemId) return null
    return library.byId[item.derivedFrom?.sourceItemId] ?? null
  })
  const displayTitle = computed(() => {
    const item = props.item
    if (!item) return ''
    if (clip.value?.name?.trim()) return clip.value.name.trim()
    return libraryItemDisplayName(item)
  })
  const infoSettings = computed(() => clip.value ?? props.item)

  /**
   * Whether this library item is currently treated as a non-musical sample.
   * Used to (a) gate BPM/key/beats rows in the analysis section, and
   * (b) preselect the right radio in the classification control.
   */
  const isSample = computed(() => {
    const item = props.item
    if (!item) return false
    return libraryItemIsSample(item, library.byId)
  })

  /** Current classification mode for the radio control: 'auto' when no
   *  override is set, otherwise the explicit choice. */
  const classificationMode = computed<'auto' | 'sample' | 'music'>(() => {
    const item = props.item
    if (!item) return 'auto'
    return item.sampleMode ?? 'auto'
  })

  function setClassification(mode: 'auto' | 'sample' | 'music'): void {
    const item = props.item
    if (!item || item.kind !== 'audio-file') return
    library.setItemSampleMode(item.id, mode)
  }
  const instanceRows = computed(() => {
    const c = clip.value
    if (!c) return []
    const track = project.tracks.find((candidate) => candidate.id === c.trackId)
    return [
      ['Track', track?.name],
      ['Start', formatTime(c.startMs)],
      ['Source window', `${formatTime(c.inMs)} - ${formatTime(c.inMs + c.durationMs)}`],
      ['Clip duration', formatPreciseDuration(c.durationMs)]
    ].filter((row): row is [string, string] => typeof row[1] === 'string' && row[1].length > 0)
  })

  const usages = computed(() => {
    const item = props.item
    if (!item) return []
    // Truth lives in the project file: each timeline clip records the
    // `libraryItemId` of its parent library entry. Match on that.
    //
    // Audio-file sources additionally count timeline clips whose
    // libraryItemId references any saved-clip derived FROM this
    // source — that's a structural relationship recorded by
    // `derivedFrom.sourceItemId` on the saved-clip, not a heuristic.
    const derivedSavedClipIds =
      item.kind === 'audio-file'
        ? new Set(
            library.items
              .filter((i) => i.derivedFrom?.sourceItemId === item.id)
              .map((i) => i.id)
          )
        : null
    const rows: { trackId: string; trackName: string; clipCount: number; starts: string[] }[] = []
    for (const track of project.tracks) {
      const matching = track.clipIds
        .map((clipId) => project.clips[clipId])
        .filter((clip): clip is Clip => {
          if (!clip) return false
          if (clip.libraryItemId === item.id) return true
          if (derivedSavedClipIds?.has(clip.libraryItemId)) return true
          return false
        })
      if (matching.length === 0) continue
      rows.push({
        trackId: track.id,
        trackName: track.name,
        clipCount: matching.length,
        starts: matching.map((clip) => formatTime(clip.startMs))
      })
    }
    return rows
  })

  const pitchShifted = computed(() => {
    const current = infoSettings.value
    return !!current && ((current.semitones ?? 0) !== 0 || (current.cents ?? 0) !== 0)
  })
  const displayKey = computed(() => {
    const item = props.item
    if (!item) return undefined
    const current = infoSettings.value
    if (pitchShifted.value) {
      return shiftedKey(
        sourceItem.value?.key ?? sourceItem.value?.metadata?.key ?? item.key ?? item.metadata?.key,
        current?.semitones,
        current?.cents
      )
    }
    return item.key ?? item.metadata?.key
  })
  const warpedBpm = computed(() => {
    const item = props.item
    const current = infoSettings.value
    if (!item || !current || current.warpEnabled !== true) return undefined
    const sourceBpm = item.bpm ?? sourceItem.value?.bpm
    if (typeof sourceBpm !== 'number' || sourceBpm <= 0) return undefined
    // The "warped BPM" for an auto-warped clip follows the project tempo
    // (effective ratio = projectBpm / sourceBpm); for a pinned-ratio
    // clip it is sourceBpm × tempoRatio. Passing `sourceBpm` as the
    // projectBpm — which the previous code did — degenerated the ratio
    // to 1 and made the display always equal the source BPM. Use the
    // real project BPM instead.
    const ratio = effectiveTempoRatio({
      tempoRatio: current.tempoRatio,
      sourceBpm,
      projectBpm: transport.bpm
    })
    return sourceBpm * ratio
  })
  const bpmLabel = computed(() => warpedBpm.value ? 'Warped BPM' : 'Detected BPM')
  const keyLabel = computed(() => pitchShifted.value ? 'Shifted key' : 'Detected key')
  const displayDecodedCachePath = computed(() => {
    const item = props.item
    if (!item) return 'Not available yet'
    // Saved-clip items don't carry their own decoded-WAV cache —
    // they play through their source's cache. Inherit the source's
    // value so the info dialog shows the same path that's actually
    // serving audio for this clip.
    return (
      item.decodedCacheFilePath ?? sourceItem.value?.decodedCacheFilePath ?? 'Not available yet'
    )
  })

  const metadataRows = computed(() => {
    const item = props.item
    if (!item) return []
    const m = props.item?.metadata
    return [
      ['Title', m?.title],
      ['Artist', m?.artist],
      ['Album artist', m?.albumArtist],
      ['Album', m?.album],
      ['Year', formatNumber(m?.year)],
      ['Track', formatPartTotal(m?.trackNumber, m?.trackTotal)],
      ['Disc', formatPartTotal(m?.discNumber, m?.discTotal)],
      ['Genre', m?.genre?.join(', ')],
      ['Composer', m?.composer],
      ['BPM tag', formatNumber(m?.bpm)],
      ['Comment', m?.comment],
      ['Codec', m?.codec],
      ['Container', m?.container],
      ['Bitrate', typeof m?.bitrate === 'number' ? `${Math.round(m.bitrate / 1000)} kbps` : undefined],
      ['Encoding', typeof m?.lossless === 'boolean' ? (m.lossless ? 'Lossless' : 'Lossy') : undefined],
      ['Tag types', m?.tagTypes?.join(', ')]
    ].filter((row): row is [string, string] => typeof row[1] === 'string' && row[1].length > 0)
  })

  function onKeyDown(e: KeyboardEvent): void {
    if (!props.open) return
    if (e.key === 'Escape') {
      e.preventDefault()
      emit('close')
    }
  }

  onMounted(() => {
    window.addEventListener('keydown', onKeyDown)
  })

  onBeforeUnmount(() => {
    window.removeEventListener('keydown', onKeyDown)
  })

  watch(
    () => props.open,
    (isOpen) => {
      if (isOpen) requestAnimationFrame(() => dialogEl.value?.focus())
    }
  )

  return {
    clip,
    sourceItem,
    displayTitle,
    isSample,
    classificationMode,
    setClassification,
    instanceRows,
    usages,
    displayKey,
    warpedBpm,
    bpmLabel,
    keyLabel,
    displayDecodedCachePath,
    metadataRows,
    libraryItemDisplayName,
    keyBadgeClass,
    formatDuration,
    formatPreciseDuration,
    formatTime,
    channelLabel
  }
}

function formatNumber(value: number | undefined): string | undefined {
  return typeof value === 'number' ? String(value) : undefined
}

function formatPartTotal(value: number | undefined, total: number | undefined): string | undefined {
  if (typeof value !== 'number') return undefined
  return typeof total === 'number' ? `${value} of ${total}` : String(value)
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`
}

function formatPreciseDuration(ms: number): string {
  const safe = Math.max(0, ms)
  if (safe < 1000) return `${Math.round(safe)} ms`
  if (safe < 60_000) return `${(safe / 1000).toFixed(safe < 10_000 ? 3 : 2)} s`
  return formatDuration(safe)
}

function formatTime(ms: number): string {
  return `${formatDuration(ms)}.${String(Math.floor(ms % 1000)).padStart(3, '0')}`
}

function channelLabel(count: number): string {
  if (count === 1) return 'Mono'
  if (count === 2) return 'Stereo'
  return `${count} channels`
}

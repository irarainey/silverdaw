// Pure-logic composable resolving the Clip Editor's editing target from the
// `(item, clipId)` open-arguments into an explicit `EditorMode` discriminant
// plus the source/clip/item refs the editor depends on. Centralises the
// `kind === 'saved-clip'` decision behind exhaustive `editsExistingClip` /
// `editsSavedClipLibrary` / `editsSingleTimelineClip` booleans, replacing the
// dialog's previously scattered, drift-prone kind checks.

import { computed, type ComputedRef, type Ref } from 'vue'
import {
  libraryItemDisplayName,
  libraryItemSourceBpm,
  useLibraryStore,
  type LibraryItem
} from '@/stores/libraryStore'
import { useProjectStore, type Clip } from '@/stores/projectStore'

export type EditorMode =
  | 'source-library'
  | 'saved-library'
  | 'timeline-linked'
  | 'timeline-unlinked'

export interface ClipEditorTarget {
  timelineClip: ComputedRef<Clip | null>
  editorItem: ComputedRef<LibraryItem | null>
  editorMode: ComputedRef<EditorMode | null>
  editsExistingClip: ComputedRef<boolean>
  editsSavedClipLibrary: ComputedRef<boolean>
  editsSingleTimelineClip: ComputedRef<boolean>
  editsTimelineClip: ComputedRef<boolean>
  titleText: ComputedRef<string>
  sourceItem: ComputedRef<LibraryItem | null>
  sourceDurationMs: ComputedRef<number>
  sourceBpm: ComputedRef<number | undefined>
  sourceKey: ComputedRef<string | undefined>
}

export function useClipEditorTarget(
  itemRef: Ref<LibraryItem | null | undefined> | ComputedRef<LibraryItem | null | undefined>,
  clipIdRef: Ref<string | null | undefined> | ComputedRef<string | null | undefined>
): ClipEditorTarget {
  const project = useProjectStore()
  const library = useLibraryStore()

  const timelineClip = computed<Clip | null>(() => {
    const id = clipIdRef.value
    return id ? project.clips[id] ?? null : null
  })

  const editorItem = computed<LibraryItem | null>(() => {
    const clip = timelineClip.value
    if (clip) return library.byId[clip.libraryItemId] ?? null
    return itemRef.value ?? null
  })

  const editorMode = computed<EditorMode | null>(() => {
    const clip = timelineClip.value
    const entry = editorItem.value
    if (!entry) return null
    if (clip) return entry.kind === 'saved-clip' ? 'timeline-linked' : 'timeline-unlinked'
    return entry.kind === 'saved-clip' ? 'saved-library' : 'source-library'
  })

  const editsExistingClip = computed(
    () => editorMode.value !== null && editorMode.value !== 'source-library'
  )
  const editsSavedClipLibrary = computed(
    () => editorMode.value === 'saved-library' || editorMode.value === 'timeline-linked'
  )
  const editsSingleTimelineClip = computed(() => editorMode.value === 'timeline-unlinked')
  // Both linked and unlinked timeline clips can shape volume; a placed instance
  // gives the post-warp ms timebase the envelope needs.
  const editsTimelineClip = computed(() => timelineClip.value !== null)

  const titleText = computed(() => {
    const clip = timelineClip.value
    const entry = editorItem.value
    if (clip?.name?.trim()) return clip.name.trim()
    return entry ? libraryItemDisplayName(entry) : ''
  })

  const sourceItem = computed<LibraryItem | null>(() => {
    const entry = editorItem.value
    if (!entry) return null
    if (entry.kind === 'saved-clip' && entry.derivedFrom?.sourceItemId) {
      return library.byId[entry.derivedFrom?.sourceItemId] ?? entry
    }
    return entry
  })

  const sourceDurationMs = computed(() => sourceItem.value?.durationMs ?? 0)
  const sourceBpm = computed(() => {
    const entry = editorItem.value
    if (!entry) return undefined
    return libraryItemSourceBpm(entry, library.byId)
  })
  const sourceKey = computed(() => {
    const source = sourceItem.value
    return source?.key ?? source?.metadata?.key
  })

  return {
    timelineClip,
    editorItem,
    editorMode,
    editsExistingClip,
    editsSavedClipLibrary,
    editsSingleTimelineClip,
    editsTimelineClip,
    titleText,
    sourceItem,
    sourceDurationMs,
    sourceBpm,
    sourceKey
  }
}

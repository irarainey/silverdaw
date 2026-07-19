import {
  libraryItemDisplayName,
  libraryItemSourceBpm
} from '@/stores/libraryItemHelpers'
import type { LibraryItem } from '@/stores/libraryTypes'

/** Match a Library item by its displayed name, detected BPM, or artist. */
export function libraryItemMatchesFilter(
  item: LibraryItem,
  query: string,
  itemsById: Readonly<Record<string, LibraryItem>>
): boolean {
  const needle = query.trim().toLocaleLowerCase()
  if (needle.length === 0) return true

  const source = item.derivedFrom?.sourceItemId
    ? itemsById[item.derivedFrom.sourceItemId]
    : undefined
  const bpm = libraryItemSourceBpm(item, itemsById)
  const fields = [
    libraryItemDisplayName(item),
    item.fileName,
    item.metadata?.artist ?? source?.metadata?.artist ?? '',
    typeof bpm === 'number' ? String(bpm) : '',
    typeof bpm === 'number' ? bpm.toFixed(2) : ''
  ]

  return fields.some((field) => field.toLocaleLowerCase().includes(needle))
}

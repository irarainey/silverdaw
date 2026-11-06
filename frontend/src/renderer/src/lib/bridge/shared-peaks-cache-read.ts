const pendingReads = new Map<string, Promise<ArrayBuffer | null>>()

/** Share IPC buffers within a load burst, without caching mutable files between reads. */
export function readSharedPeaksCacheFile(cachePath: string): Promise<ArrayBuffer | null> {
  const pending = pendingReads.get(cachePath)
  if (pending) return pending

  const read = window.silverdaw.readPeaksCacheFile(cachePath).finally(() => {
    pendingReads.delete(cachePath)
  })
  pendingReads.set(cachePath, read)
  return read
}

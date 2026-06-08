#pragma once

#include "Waveform.h"

#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_core/juce_core.h>

namespace silverdaw
{

/**
 * Disk-backed peaks cache.
 *
 * Keyed by a stable hash of (filePath, mtime, size, peaksPerSecond) so
 * any meaningful change to the underlying audio invalidates the entry
 * automatically. Cache files live at
 *
 *   <userAppData>/Silverdaw/peaks/<hex>.peaks
 *
 * Each cache file is the same format used on the wire (modulo header
 * length / JSON header): a tiny fixed-size binary header followed by raw
 * little-endian float32 peaks. Reading is a single mmap-style file read;
 * writing is one atomic file write.
 *
 * Thread-safe by file-system locking (each entry is read-only after
 * write; concurrent writers for the same key produce identical bytes
 * and either wins).
 */
class PeaksCache
{
  public:
    /** Resolve and create the cache directory under user app data. Idempotent. */
    PeaksCache();

    /** Resolve and create a caller-supplied cache directory. Intended for tests. */
    explicit PeaksCache(const juce::File& cacheDirectory);

    /**
     * Read a cached entry. Returns an empty `PeaksResult` if the entry
     * is missing or fails validation.
     */
    waveform::PeaksResult tryLoad(const juce::File& sourceFile, int peaksPerSecond) const;

    /**
     * Atomically persist `result` for `sourceFile` at `peaksPerSecond`.
     * No-op if `result.peaks` is empty (don't cache failures). Errors
     * are logged but not propagated — cache misses are recoverable.
     */
    void store(const juce::File& sourceFile, const waveform::PeaksResult& result) const;

    /**
     * Resolve the absolute on-disk path that the cache uses for
     * `(sourceFile, peaksPerSecond)`. Used by the bridge to send the
     * renderer a `WAVEFORM_READY { cachePath }` envelope instead of
     * streaming the bytes back over the WebSocket. The returned file
     * may not exist yet — callers must check / produce as needed.
     */
    juce::File getCacheFilePath(const juce::File& sourceFile, int peaksPerSecond) const;

  private:
    juce::File cacheFileFor(const juce::File& sourceFile, int peaksPerSecond) const;
    juce::File cacheDir;
};

} // namespace silverdaw

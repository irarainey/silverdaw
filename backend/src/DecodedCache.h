#pragma once

#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_core/juce_core.h>

namespace silverdaw
{

/**
 * Disk-backed decoded-audio cache.
 *
 * Every imported audio file is decoded once on the worker pool and
 * written out as a 16-bit linear PCM WAV under
 *
 *   <userAppData>/Silverdaw/decoded/<hex>.wav
 *
 * Keyed by a stable hash of `(filePath | mtime | size)` so any
 * meaningful change to the source invalidates the entry automatically
 * (same scheme used by `PeaksCache`).
 *
 * The point of the cache is to keep `AudioFormatReader` reads cheap
 * for the audio engine. Native MP3 / WMA decode on the read-ahead
 * thread is fine for *one* clip in flight, but the cumulative load
 * of many simultaneous tracks — plus the synchronous initial fill
 * every fresh `BufferingAudioSource` does — became a perceptible
 * lag in import / duplicate flows. With this cache the engine
 * always plays back a WAV, decoding is amortised to a one-shot
 * import-time cost, and the AAC/M4A renderer-side transcode detour
 * can be retired in a follow-up.
 *
 * Thread-safe by file-system convention: each entry is read-only
 * after first write; concurrent writers for the same key produce
 * the same bytes and either wins.
 */
class DecodedCache
{
  public:
    /** Resolve and create the cache directory under user app data. Idempotent. */
    DecodedCache();

    /**
     * Decode the contents of `sourceFile` into a 16-bit PCM WAV at
     * the cache location for that file. No-op if the cache entry
     * already exists. Returns the cache path on success (existing or
     * newly written), or an empty `juce::File` on failure (reader
     * unavailable, write error, etc.).
     *
     * Designed to be invoked from a background worker thread —
     * decoding is potentially slow (full-length MP3 / WMA pass),
     * but never touches the message or audio thread.
     */
    juce::File ensureDecoded(const juce::File& sourceFile, juce::AudioFormatManager& formatManager) const;

    /**
     * Resolve the absolute on-disk path the cache would use for
     * `sourceFile`. The returned file may not exist; callers can
     * test `existsAsFile()` to see whether `ensureDecoded` has
     * already run for this entry.
     */
    juce::File getCacheFilePath(const juce::File& sourceFile) const;

  private:
    juce::File cacheFileFor(const juce::File& sourceFile) const;
    juce::File cacheDir;
};

} // namespace silverdaw

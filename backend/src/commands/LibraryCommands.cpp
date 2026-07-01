#include "LibraryCommands.h"

#include "AudioEngine.h"
#include "BridgeServer.h"
#include "DecodedCache.h"
#include "EnginePlaybackPath.h"
#include "LibraryAnalysis.h"
#include "Log.h"
#include "PayloadHelpers.h"
#include "ProjectFile.h"
#include "ProjectState.h"
#include "ProjectSession.h"

#include <juce_events/juce_events.h>

#include <map>
#include <optional>

namespace silverdaw
{

using silverdaw::bridge::readOptionalString;
using silverdaw::bridge::tryGetRequiredString;

void handleLibraryAdd(const juce::var& payload, AudioEngine& engine, ProjectState& projectState,
                      BridgeServer& bridge, juce::ThreadPool& peakPool, const DecodedCache& decodedCache)
{
    const juce::String itemId = tryGetRequiredString(payload, "itemId").value_or(juce::String{});
    const juce::String filePath = tryGetRequiredString(payload, "filePath").value_or(juce::String{});
    const juce::String fileName = tryGetRequiredString(payload, "fileName").value_or(juce::String{});
    const double durationMs = static_cast<double>(payload.getProperty("durationMs", 0.0));
    const int sampleRate = static_cast<int>(payload.getProperty("sampleRate", 0));
    const int channelCount = static_cast<int>(payload.getProperty("channelCount", 0));
    const juce::String playbackPath = tryGetRequiredString(payload, "playbackFilePath").value_or(juce::String{});
    const juce::String key = tryGetRequiredString(payload, "key").value_or(juce::String{});
    const juce::String kind = tryGetRequiredString(payload, "kind").value_or(juce::String{});
    // name/sourceItemId/sourceClipId are optional: only clips and stems carry provenance.
    const juce::String displayName = readOptionalString(payload, "name").value_or(juce::String{});
    const juce::String sourceItemId = readOptionalString(payload, "sourceItemId").value_or(juce::String{});
    const juce::String sourceClipId = readOptionalString(payload, "sourceClipId").value_or(juce::String{});
    const double sourceInMs = payload.hasProperty("sourceInMs")
                                  ? static_cast<double>(payload.getProperty("sourceInMs", 0.0))
                                  : -1.0;
    const double sourceDurationMs = payload.hasProperty("sourceDurationMs")
                                        ? static_cast<double>(payload.getProperty("sourceDurationMs", 0.0))
                                        : -1.0;
    const int collapsedFlag = payload.hasProperty("collapsed")
                                  ? (bool(payload.getProperty("collapsed", false)) ? 1 : 0)
                                  : -1;
    const juce::String mediaId = readOptionalString(payload, "mediaId").value_or(juce::String{});
    silverdaw::log::info("bridge", "recv LIBRARY_ADD itemId=" + itemId);
    projectState.addLibraryItem(itemId, filePath, fileName, durationMs, sampleRate, channelCount, playbackPath, key,
                                kind, displayName, sourceItemId, sourceClipId, sourceInMs, sourceDurationMs,
                                collapsedFlag, mediaId);
    if (kind == "clip")
    {
        // Saved-clip warp fields are partial; missing fields keep identity defaults.
        std::optional<bool> warpEnabled;
        if (payload.hasProperty("warpEnabled"))
            warpEnabled = static_cast<bool>(payload.getProperty("warpEnabled", false));
        std::optional<juce::String> warpMode;
        if (payload.hasProperty("warpMode"))
            warpMode = tryGetRequiredString(payload, "warpMode").value_or(juce::String{});
        std::optional<double> tempoRatio;
        bool tempoRatioClear = false;
        if (payload.hasProperty("tempoRatio"))
        {
            const auto& v = payload["tempoRatio"];
            if (v.isVoid() || v.isUndefined())
                tempoRatioClear = true;
            else
                tempoRatio = static_cast<double>(v);
        }
        std::optional<double> semitones;
        if (payload.hasProperty("semitones"))
            semitones = static_cast<double>(payload.getProperty("semitones", 0.0));
        std::optional<double> cents;
        if (payload.hasProperty("cents"))
            cents = static_cast<double>(payload.getProperty("cents", 0.0));
        if (warpEnabled.has_value() || warpMode.has_value() || tempoRatio.has_value() ||
            tempoRatioClear || semitones.has_value() || cents.has_value())
        {
            projectState.setLibraryItemWarp(itemId, warpEnabled, warpMode, tempoRatio,
                                            tempoRatioClear, semitones, cents);
        }
    }
    else if (kind == "stem")
    {
        // Stems are derived from an already-analysed source; inherit its grid and
        // ensure a decoded cache exists for cheap playback (no re-analysis).
        inheritAnalysisFromSource(itemId, sourceItemId, engine, projectState, bridge);
        ensureDecodedCache(filePath, engine, projectState, peakPool, decodedCache);
    }
    else
    {
        ensureBpmDetection(filePath, engine, projectState, bridge, peakPool, decodedCache);
    }
}

void handleLibraryRemove(const juce::var& payload, ProjectState& projectState, const ProjectSession& session)
{
    const juce::String itemId = tryGetRequiredString(payload, "itemId").value_or(juce::String{});
    // A "clean up project files" removal deletes the item's generated file from disk, so it
    // is irreversible: remove it without marking the project dirty or recording an undo step.
    const bool cleanup = silverdaw::bridge::readOptionalBool(payload, "cleanup").value_or(false);
    silverdaw::log::info("bridge", "recv LIBRARY_REMOVE itemId=" + itemId + (cleanup ? " (cleanup)" : ""));
    if (cleanup)
    {
        projectState.removeLibraryItemNonDirty(itemId);
        // Also prune the item from the ALREADY-SAVED project file so its now-deleted file
        // can't dangle in the saved project — without committing the user's other unsaved
        // edits (a targeted in-place edit, not a full save). No-op if never saved.
        if (session.currentPath.isNotEmpty())
        {
            const auto result =
                silverdaw::ProjectFile::removeLibraryItems(juce::File(session.currentPath), {itemId});
            if (result.failed())
                silverdaw::log::warn("bridge", "LIBRARY_REMOVE cleanup file-prune failed: " + result.getErrorMessage());
        }
    }
    else
    {
        projectState.removeLibraryItem(itemId);
    }
}

// Background retry for removing a per-source artifact folder whose files we deleted. On
// Windows a just-deleted WAV can briefly linger in "delete-pending" limbo (a reader
// handle closing, or a sync client / AV scanner momentarily holding the folder), so the
// directory removal can fail for a moment. Rather than block the message thread, a failed
// removal is retried on a timer. Each pending folder remembers the exact filenames we are
// allowed to delete, so the retry only ever removes a folder that still contains nothing
// but those files (a foreign file appearing in the window aborts the removal — we never
// blindly recurse).
class DeferredFolderPruner final : private juce::Timer
{
  public:
    void queue(const juce::File& folder, const juce::StringArray& deletableNames)
    {
        for (auto& p : pending)
        {
            if (p.folder == folder)
            {
                p.names.mergeArray(deletableNames);
                p.ticks = 0;
                if (! isTimerRunning()) startTimer(kRetryIntervalMs);
                return;
            }
        }
        pending.add({folder, deletableNames, 0});
        if (! isTimerRunning()) startTimer(kRetryIntervalMs);
    }

  private:
    struct Entry
    {
        juce::File folder;
        juce::StringArray names;
        int ticks;
    };

    void timerCallback() override
    {
        for (int i = pending.size(); --i >= 0;)
        {
            auto& e = pending.getReference(i);
            if (! e.folder.isDirectory())
            {
                pending.remove(i); // already gone
                continue;
            }
            bool onlyOurs = true;
            for (const auto& child : e.folder.findChildFiles(juce::File::findFilesAndDirectories, false))
                if (! e.names.contains(child.getFileName(), /*ignoreCase*/ true)) { onlyOurs = false; break; }
            if (! onlyOurs)
            {
                silverdaw::log::warn("bridge", "LIBRARY_DELETE_ARTIFACTS folder gained a foreign file; keeping: "
                                                   + e.folder.getFullPathName());
                pending.remove(i);
                continue;
            }
            // Clear the OneDrive/sync READ-ONLY stamp so RemoveDirectory isn't denied.
            e.folder.setReadOnly(false, /*applyRecursively*/ true);
            if (e.folder.deleteRecursively())
            {
                silverdaw::log::info("bridge",
                                     "LIBRARY_DELETE_ARTIFACTS removed folder on retry: " + e.folder.getFullPathName());
                pending.remove(i);
            }
            else if (++e.ticks >= kMaxTicks)
            {
                silverdaw::log::warn("bridge",
                                     "LIBRARY_DELETE_ARTIFACTS gave up removing folder: " + e.folder.getFullPathName());
                pending.remove(i);
            }
        }
        if (pending.isEmpty()) stopTimer();
    }

    static constexpr int kRetryIntervalMs = 400;
    static constexpr int kMaxTicks = 30; // ~12 s of background retries
    juce::Array<Entry> pending;
};

DeferredFolderPruner& deferredFolderPruner()
{
    static DeferredFolderPruner instance;
    return instance;
}

// Delete a removed library item's generated stem/sample artifact files. Every path is
// re-validated against the project's stems/samples trees, so a user's original imported
// source can never be removed. The decision is made by counting the per-source folder's
// files BEFORE deleting anything: if the files we were asked to remove are the folder's
// ONLY contents, the whole directory is removed in one `deleteRecursively` (files + dir
// together) — this avoids leaving a just-deleted WAV in Windows "delete-pending" limbo
// that would make the folder look non-empty and block its removal. If other files remain
// (another still-referenced stem/sample, or a file the app didn't generate), only our
// files are deleted and the folder is kept. Before any delete, the engine releases any
// reader it holds on the file (the preview voice). A directory removal that fails behind a
// transient lock is retried in the background. The shared cover-art / tag media store lives
// in separate GUID-keyed folders (reference-counted across every stem/sample/source from
// the same origin) and is cleaned up separately in the main process — never touched here.
// Runs on the JUCE message thread.
void handleLibraryDeleteArtifacts(const juce::var& payload, const ProjectSession& session, AudioEngine& engine)
{
    const juce::var v = payload.getProperty("paths", juce::var());
    if (! v.isArray())
    {
        silverdaw::log::warn("bridge", "LIBRARY_DELETE_ARTIFACTS missing 'paths' array; ignored");
        return;
    }
    const auto* arr = v.getArray();
    if (arr == nullptr || arr->isEmpty()) return;

    const auto stemsRoot = silverdaw::projectArtifactsBaseDir(session.currentPath, "stems");
    const auto samplesRoot = silverdaw::projectArtifactsBaseDir(session.currentPath, "samples");

    // Group the requested deletions by their per-source folder (a direct child of a root),
    // WITHOUT deleting yet — so the folder's file count is read before any file goes into
    // delete-pending limbo. Paths not sitting in a per-source folder are deleted directly.
    std::map<juce::String, juce::StringArray> requestedByFolder;
    int deleted = 0;
    for (const auto& entry : *arr)
    {
        if (! entry.isString()) continue;
        const juce::String path = entry.toString();
        if (path.isEmpty() || ! juce::File::isAbsolutePath(path)) continue;

        const juce::File file(path);
        if (! file.isAChildOf(stemsRoot) && ! file.isAChildOf(samplesRoot))
        {
            silverdaw::log::warn("bridge",
                                 "LIBRARY_DELETE_ARTIFACTS refusing path outside artifact roots: " + path);
            continue;
        }
        // Close any engine reader on this file first, so the delete actually frees it.
        engine.releaseReadersForFile(file);

        const auto folder = file.getParentDirectory();
        if (folder.getParentDirectory() == stemsRoot || folder.getParentDirectory() == samplesRoot)
        {
            requestedByFolder[folder.getFullPathName()].add(file.getFileName());
        }
        else
        {
            // Directly under a root (or deeper) — only ever unlink the file, never a root.
            if (file.deleteFile()) ++deleted;
            else if (file.existsAsFile())
                silverdaw::log::warn("bridge", "LIBRARY_DELETE_ARTIFACTS could not delete " + path);
        }
    }

    int prunedFolders = 0;
    for (const auto& [folderPath, ourNames] : requestedByFolder)
    {
        const juce::File folder(folderPath);
        if (! folder.isDirectory())
        {
            ++prunedFolders; // already gone
            continue;
        }
        // Count how many files the folder holds that are NOT ones we were asked to delete.
        int foreign = 0;
        for (const auto& child : folder.findChildFiles(juce::File::findFilesAndDirectories, false))
            if (! ourNames.contains(child.getFileName(), /*ignoreCase*/ true)) ++foreign;

        silverdaw::log::info("bridge", "LIBRARY_DELETE_ARTIFACTS folder='" + folderPath
                                           + "' ours=" + juce::String(ourNames.size())
                                           + " foreign=" + juce::String(foreign));

        if (foreign > 0)
        {
            // Other files remain — delete only ours and keep the folder.
            for (const auto& name : ourNames)
                if (folder.getChildFile(name).deleteFile()) ++deleted;
        }
        else
        {
            // Our files are the folder's only contents — remove the whole directory (its
            // files AND the folder) in one step, so nothing is left delete-pending.
            deleted += ourNames.size();
            // OneDrive (and other sync clients) stamp synced folders READ-ONLY, which makes
            // Windows refuse RemoveDirectory with ERROR_ACCESS_DENIED. Clear it (recursively)
            // first so the removal isn't denied.
            folder.setReadOnly(false, /*applyRecursively*/ true);
            if (folder.deleteRecursively())
                ++prunedFolders;
            else
                deferredFolderPruner().queue(folder, ourNames); // locked — retry in background
        }
    }

    silverdaw::log::info("bridge", "recv LIBRARY_DELETE_ARTIFACTS deleted=" + juce::String(deleted)
                                       + " prunedFolders=" + juce::String(prunedFolders));
}

void handleLibraryReanalyse(const juce::var& payload, AudioEngine& engine, ProjectState& projectState,
                            BridgeServer& bridge, juce::ThreadPool& peakPool, const DecodedCache& decodedCache)
{
    const juce::String itemId = tryGetRequiredString(payload, "itemId").value_or(juce::String{});
    const juce::String filePath = tryGetRequiredString(payload, "filePath").value_or(juce::String{});
    const juce::String fileName = tryGetRequiredString(payload, "fileName").value_or(juce::String{});
    const double durationMs = static_cast<double>(payload.getProperty("durationMs", 0.0));
    const int sampleRate = static_cast<int>(payload.getProperty("sampleRate", 0));
    const int channelCount = static_cast<int>(payload.getProperty("channelCount", 0));
    const juce::String playbackPath = tryGetRequiredString(payload, "playbackFilePath").value_or(juce::String{});
    silverdaw::log::info("bridge", "recv LIBRARY_REANALYSE itemId=" + itemId);
    projectState.addLibraryItem(itemId, filePath, fileName, durationMs, sampleRate, channelCount, playbackPath);
    if (payload.hasProperty("key"))
    {
        projectState.setLibraryItemKey(itemId, tryGetRequiredString(payload, "key").value_or(juce::String{}));
    }
    const juce::String analysisPath = playbackPath.isNotEmpty() ? playbackPath : filePath;
    forceLibraryItemAnalysis(itemId, analysisPath, engine, projectState, bridge, peakPool, decodedCache);
}

void handleLibraryItemSetAudioType(const juce::var& payload, ProjectState& projectState)
{
    const juce::String itemId = tryGetRequiredString(payload, "itemId").value_or(juce::String{});
    const juce::String audioType = readOptionalString(payload, "audioType").value_or(juce::String{});
    silverdaw::log::info("bridge", "recv LIBRARY_ITEM_SET_AUDIO_TYPE itemId=" + itemId + " audioType='" + audioType + "'");
    if (itemId.isEmpty())
    {
        silverdaw::log::warn("bridge", "LIBRARY_ITEM_SET_AUDIO_TYPE missing itemId");
    }
    else if (!audioType.isEmpty() && audioType != "simple" && audioType != "music" && audioType != "auto")
    {
        silverdaw::log::warn("bridge", "LIBRARY_ITEM_SET_AUDIO_TYPE bad audioType='" + audioType + "'");
    }
    else
    {
        // "auto" and empty both clear the override.
        const juce::String stored = (audioType == "simple" || audioType == "music") ? audioType : juce::String{};
        projectState.setLibraryItemAudioType(itemId, stored);
    }
}

void handleLibraryItemSetManualTempo(const juce::var& payload, AudioEngine& engine,
                                     ProjectState& projectState, BridgeServer& bridge)
{
    const juce::String itemId = tryGetRequiredString(payload, "itemId").value_or(juce::String{});
    const double bpm = static_cast<double>(payload.getProperty("bpm", 0.0));
    const double beatAnchorSec = static_cast<double>(payload.getProperty("beatAnchorSec", 0.0));
    silverdaw::log::info("bridge", "recv LIBRARY_ITEM_SET_MANUAL_TEMPO itemId=" + itemId
                                       + " bpm=" + juce::String(bpm, 2)
                                       + " anchor=" + juce::String(beatAnchorSec, 3) + "s");
    if (itemId.isEmpty())
    {
        silverdaw::log::warn("bridge", "LIBRARY_ITEM_SET_MANUAL_TEMPO missing itemId");
        return;
    }
    if (bpm < 20.0 || bpm > 300.0)
    {
        silverdaw::log::warn("bridge", "LIBRARY_ITEM_SET_MANUAL_TEMPO bpm out of range: " + juce::String(bpm, 2));
        return;
    }
    applyManualTempo(itemId, bpm, beatAnchorSec, engine, projectState, bridge);
}


// Clips reference library items by id, so relink rebuilds each dependent clip.
void handleLibraryItemRelink(const juce::var& payload, silverdaw::AudioEngine& engine,
                             silverdaw::ProjectState& projectState, silverdaw::BridgeServer& bridge,
                             const silverdaw::ProjectSession& session, juce::ThreadPool& peakPool,
                             const silverdaw::DecodedCache& decodedCache)
{
    const juce::String itemId = tryGetRequiredString(payload, "itemId").value_or(juce::String{});
    const juce::String filePath = tryGetRequiredString(payload, "filePath").value_or(juce::String{});
    if (itemId.isEmpty() || filePath.isEmpty())
    {
        return;
    }
    if (!projectState.setLibraryItemFilePath(itemId, filePath))
    {
        silverdaw::log::warn("project", "LIBRARY_ITEM_RELINK unknown itemId=" + itemId);
        return;
    }

    // Each clip is its own playable source, so rebuild dependents individually.
    const auto& root = projectState.getTree();
    int rebuilt = 0;
    int failed = 0;
    for (int t = 0; t < root.getNumChildren(); ++t)
    {
        const auto track = root.getChild(t);
        if (!track.hasType(juce::Identifier{"TRACK"})) continue;
        for (int c = 0; c < track.getNumChildren(); ++c)
        {
            const auto clip = track.getChild(c);
            if (!clip.hasType(juce::Identifier{"CLIP"})) continue;
            if (clip.getProperty("libraryItemId", {}).toString() != itemId) continue;

            const juce::String clipId = clip.getProperty("id").toString();
            const double offsetMs = static_cast<double>(clip.getProperty("offsetMs", 0.0));
            const double inMs = static_cast<double>(clip.getProperty("inMs", 0.0));
            const double durationMs = static_cast<double>(clip.getProperty("durationMs", 0.0));
            const auto trackId = track.getProperty("id").toString();
            const auto effectiveGain = projectState.getEffectiveTrackGain(trackId);

            engine.removeClip(clipId);
            const juce::String engineFilePath =
                silverdaw::resolveEnginePlaybackPath(filePath, projectState, decodedCache);
            if (engineFilePath == filePath)
            {
                silverdaw::ensureDecodedCache(filePath, engine, projectState, peakPool, decodedCache);
            }
            juce::String err;
            if (engine.addClip(trackId, clipId, juce::File(engineFilePath), offsetMs, inMs, durationMs, effectiveGain, &err))
            {
                engine.setClipGain(clipId, effectiveGain);
                ++rebuilt;
            }
            else
            {
                ++failed;
                silverdaw::log::warn("project", "relink-rebuild failed clipId=" + clipId + " err=" + err);
            }
        }
    }
    silverdaw::log::info("project", "LIBRARY_ITEM_RELINK itemId=" + itemId + " rebuilt=" + juce::String(rebuilt) +
                                        " failed=" + juce::String(failed));

    // Re-broadcast so dependent clips clear unresolved state.
    bridge.broadcast("PROJECT_STATE", silverdaw::buildProjectStateEnvelope(session, projectState, false));
}
} // namespace silverdaw

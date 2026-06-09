#include "StemSeparationCommands.h"

#include <algorithm>
#include <vector>

#include "BridgeServer.h"
#include "DecodedCache.h"
#include "EnginePlaybackPath.h"
#include "Log.h"
#include "PayloadHelpers.h"
#include "ProjectState.h"
#include "StemBroadcast.h"
#include "StemSeparationEngine.h"
#include "StemSeparator.h"

namespace silverdaw
{

using silverdaw::bridge::tryGetRequiredString;

namespace
{

void failInvalid(BridgeServer& bridge, const juce::String& jobId, const juce::String& clipId,
                 const juce::String& message)
{
    silverdaw::log::warn("stems", "STEM_SEPARATE rejected job=" + jobId + " error=" + message);
    stem_bridge::broadcastFailed(bridge, jobId, clipId, StemFailureCode::Invalid, message);
}

juce::File stemsOutputDir(const juce::String& jobId)
{
    return juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory)
        .getChildFile("Silverdaw")
        .getChildFile("stems")
        .getChildFile(jobId);
}

// Canonical four-stem vocabulary, mirroring the zod schema. Selections are
// validated against it so a malformed envelope can't request an unknown model.
bool isCanonicalStem(const juce::String& stem)
{
    return stem == "vocals" || stem == "drums" || stem == "bass" || stem == "other";
}

// Parse the `stems` array into a deduped, canonical-ordered selection. Returns
// false (with the out vector untouched) when the field is absent/empty/invalid.
bool parseSelectedStems(const juce::var& payload, std::vector<juce::String>& out)
{
    const juce::var v = payload.getProperty("stems", juce::var());
    if (! v.isArray()) return false;
    const auto* arr = v.getArray();
    if (arr == nullptr || arr->isEmpty()) return false;

    static const char* kOrder[] = {"vocals", "drums", "bass", "other"};
    std::vector<juce::String> requested;
    for (const auto& entry : *arr)
    {
        if (! entry.isString()) return false;
        const auto stem = entry.toString();
        if (! isCanonicalStem(stem)) return false;
        requested.push_back(stem);
    }

    out.clear();
    for (const char* name : kOrder)
    {
        const juce::String stem{name};
        if (std::find(requested.begin(), requested.end(), stem) != requested.end())
            out.push_back(stem);
    }
    return ! out.empty();
}

} // namespace

void handleStemSeparate(const juce::var& payload,
                        ProjectState& projectState,
                        BridgeServer& bridge,
                        juce::ThreadPool& pool,
                        const DecodedCache& decodedCache,
                        StemSeparator& separator,
                        std::atomic<bool>& busyFlag,
                        std::atomic<bool>& cancelFlag,
                        juce::String& activeJobId)
{
    using silverdaw::bridge::readOptionalString;

    const auto jobId = tryGetRequiredString(payload, "jobId").value_or(juce::String{});
    const auto sourceItemId = tryGetRequiredString(payload, "sourceItemId").value_or(juce::String{});
    const auto clipId = readOptionalString(payload, "clipId").value_or(juce::String{});
    const auto modelDirStr = tryGetRequiredString(payload, "modelDir").value_or(juce::String{});
    const auto payloadSourceName = tryGetRequiredString(payload, "sourceName").value_or(juce::String{});

    if (jobId.isEmpty() || sourceItemId.isEmpty() || modelDirStr.isEmpty())
    {
        failInvalid(bridge, jobId, clipId, "STEM_SEPARATE requires jobId, sourceItemId and modelDir.");
        return;
    }

    std::vector<juce::String> selectedStems;
    if (! parseSelectedStems(payload, selectedStems))
    {
        failInvalid(bridge, jobId, clipId, "STEM_SEPARATE requires a non-empty stems selection.");
        return;
    }

    // One separation at a time — the engine is single-slot.
    if (busyFlag.load())
    {
        stem_bridge::broadcastFailed(bridge, jobId, clipId, StemFailureCode::Invalid,
                                     "A stem separation is already in progress.");
        return;
    }

    const auto modelDir = juce::File(modelDirStr);
    if (! modelDir.isDirectory())
    {
        stem_bridge::broadcastFailed(bridge, jobId, clipId, StemFailureCode::Model,
                                     "Model directory not found: " + modelDirStr);
        return;
    }

    const auto rawSourcePath = projectState.getLibraryItemFilePath(sourceItemId);
    if (rawSourcePath.isEmpty())
    {
        failInvalid(bridge, jobId, clipId, "Library item not found: " + sourceItemId);
        return;
    }

    const auto resolvedPath = resolveEnginePlaybackPath(rawSourcePath, projectState, decodedCache);
    const auto sourcePath = resolvedPath.isNotEmpty() ? resolvedPath : rawSourcePath;
    const auto sourceFile = juce::File(sourcePath);
    if (sourcePath.isEmpty() || ! sourceFile.existsAsFile())
    {
        stem_bridge::broadcastFailed(bridge, jobId, clipId, StemFailureCode::Decode,
                                     "Source audio not found for item " + sourceItemId);
        return;
    }

    // Prefer the renderer's friendly library name; fall back to the clip name (when
    // separating a timeline clip), then the RAW source file's basename (never the
    // resolved decoded-cache hash).
    auto sourceName = payloadSourceName;
    if (sourceName.isEmpty() && clipId.isNotEmpty()) sourceName = projectState.getClipName(clipId);
    if (sourceName.isEmpty()) sourceName = juce::File(rawSourcePath).getFileNameWithoutExtension();

    const auto outputDir = stemsOutputDir(jobId);
    const auto created = outputDir.createDirectory();
    if (created.failed())
    {
        stem_bridge::broadcastFailed(bridge, jobId, clipId, StemFailureCode::Io,
                                     "Could not create stems output directory: " +
                                         created.getErrorMessage());
        return;
    }

    StemSeparationRequest request;
    request.jobId = jobId;
    request.clipId = clipId;
    request.sourceName = sourceName;
    request.sourceFile = sourceFile;
    request.modelDir = modelDir;
    request.outputDir = outputDir;
    request.stems = std::move(selectedStems);

    activeJobId = jobId;
    silverdaw::log::info("stems", "STEM_SEPARATE job=" + jobId + " item=" + sourceItemId +
                                      " clip=" + (clipId.isNotEmpty() ? clipId : juce::String("(library)")) +
                                      " stems=" + juce::String((int) request.stems.size()) +
                                      " source=" + sourceFile.getFullPathName());
    runStemSeparationAsync(std::move(request), separator, pool, bridge, cancelFlag, busyFlag);
}

void handleStemSeparateCancel(const juce::var& payload,
                              std::atomic<bool>& busyFlag,
                              std::atomic<bool>& cancelFlag,
                              const juce::String& activeJobId)
{
    const auto jobId = tryGetRequiredString(payload, "jobId").value_or(juce::String{});
    if (! busyFlag.load() || (jobId.isNotEmpty() && jobId != activeJobId))
    {
        silverdaw::log::info("stems", "STEM_SEPARATE_CANCEL ignored job=" + jobId);
        return;
    }
    silverdaw::log::info("stems", "STEM_SEPARATE_CANCEL job=" + jobId);
    cancelFlag.store(true);
}

} // namespace silverdaw

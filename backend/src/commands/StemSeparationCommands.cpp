#include "StemSeparationCommands.h"

#include <algorithm>
#include <vector>

#include "BridgeServer.h"
#include "DecodedCache.h"
#include "EnginePlaybackPath.h"
#include "Log.h"
#include "PayloadHelpers.h"
#include "ProjectSession.h"
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


// Output folder named after the source file with a "-stems" suffix, e.g.
// "My Song-stems". A numeric suffix disambiguates repeat separations of the
// same source ("My Song-stems-2", "-3", ...) so they never overwrite earlier
// stems or their sidecar metadata.
juce::File uniqueStemsOutputDir(const juce::String& sourceName, const juce::File& base)
{
    auto safe = juce::File::createLegalFileName(sourceName).trim();
    if (safe.isEmpty()) safe = "stems";
    const auto rootName = safe + "-stems";
    auto candidate = base.getChildFile(rootName);
    for (int n = 2; candidate.exists(); ++n)
        candidate = base.getChildFile(rootName + "-" + juce::String(n));
    return candidate;
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

juce::File stemsOutputBaseDir(const juce::String& projectPath)
{
    return projectArtifactsBaseDir(projectPath, "stems");
}

void handleStemSeparate(const juce::var& payload,
                        ProjectState& projectState,
                        BridgeServer& bridge,
                        juce::ThreadPool& pool,
                        const DecodedCache& decodedCache,
                        StemSeparator& separator,
                        std::atomic<bool>& busyFlag,
                        std::atomic<bool>& cancelFlag,
                        juce::String& activeJobId,
                        const juce::String& projectPath)
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

    // The htdemucs base directory. It is NOT required to exist: a fully
    // pack-covered run (vocals from the vocal pack, drums/bass from the rhythm
    // pack, `other` as the residual) uses no htdemucs weights at all, so the
    // htdemucs folder may be absent. The separator validates exactly the weight
    // files it actually needs, per stem, and fails with a precise "Missing model
    // weight" error only when a stem genuinely falls back to the backup.
    const auto modelDir = juce::File(modelDirStr);

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
    // resolved decoded-cache hash). This drives the stem track / library item names.
    auto sourceName = payloadSourceName;
    if (sourceName.isEmpty() && clipId.isNotEmpty()) sourceName = projectState.getClipName(clipId);
    if (sourceName.isEmpty()) sourceName = juce::File(rawSourcePath).getFileNameWithoutExtension();

    // Name the on-disk stems folder from the ORIGINAL source file's name (never the
    // friendly title or the decoded-cache hash), so it matches the sample folders
    // grouped under `samples/<sourceFileName>/`.
    juce::String folderName = juce::File(rawSourcePath).getFileNameWithoutExtension();
    if (folderName.isEmpty()) folderName = sourceName;

    const auto outputDir = uniqueStemsOutputDir(folderName, stemsOutputBaseDir(projectPath));
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
    // Stamp each stem file with a unique GUID so regenerated stems never overwrite
    // earlier ones (including when an unsaved temp workspace is later merged into a
    // saved project's Stems folder).
    request.fileNameToken = juce::Uuid().toDashedString();
    request.stems = std::move(selectedStems);
    request.overlap = overlapForStemQuality(readOptionalString(payload, "quality").value_or(juce::String{}));
    request.shifts = shiftsForStemQuality(readOptionalString(payload, "quality").value_or(juce::String{}));
    // Optional Mel-Band RoFormer ("Vocal Quality Pack") core .onnx. When the
    // renderer supplies it (the pack is installed and enabled), vocals use it.
    const auto roformerPath = readOptionalString(payload, "roformerModelPath").value_or(juce::String{});
    if (roformerPath.isNotEmpty()) request.roformerModelFile = juce::File(roformerPath);
    // Optional 4-stem BS-RoFormer ("Rhythm Quality Pack") core .onnx. When the
    // renderer supplies it (the pack is installed and enabled), drums + bass use it.
    const auto rhythmPath = readOptionalString(payload, "rhythmModelPath").value_or(juce::String{});
    if (rhythmPath.isNotEmpty()) request.rhythmModelFile = juce::File(rhythmPath);
    // Clip-scoped separation: when a timeline clip is named, extract only that
    // clip's window of the source ([inMs, inMs+durationMs)) so the stem files are
    // clip-length. A library-item separation (no clipId) leaves the window at
    // 0/0 → the whole track is separated (full-source stems).
    if (clipId.isNotEmpty())
    {
        const auto clipDurationMs = projectState.getClipDurationMs(clipId);
        if (clipDurationMs > 0.0)
        {
            request.startMs = juce::jmax(0.0, projectState.getClipInMs(clipId));
            request.lengthMs = clipDurationMs;
        }
    }
    const juce::var useGpuVar = payload.getProperty("useGpu", juce::var());
    request.useGpu = useGpuVar.isBool() && static_cast<bool>(useGpuVar);

    const juce::var enhanceVar = payload.getProperty("enhanceVocals", juce::var());
    request.vocalEnhance.enabled = enhanceVar.isBool() && static_cast<bool>(enhanceVar);
    request.vocalEnhance.strength = vocalEnhanceStrengthFromString(
        readOptionalString(payload, "vocalEnhanceStrength").value_or(juce::String{}));

    const juce::var enhanceDrumsVar = payload.getProperty("enhanceDrums", juce::var());
    request.drumEnhance.enabled = enhanceDrumsVar.isBool() && static_cast<bool>(enhanceDrumsVar);
    request.drumEnhance.strength = drumEnhanceStrengthFromString(
        readOptionalString(payload, "drumEnhanceStrength").value_or(juce::String{}));

    const juce::var enhanceBassVar = payload.getProperty("enhanceBass", juce::var());
    request.bassEnhance.enabled = enhanceBassVar.isBool() && static_cast<bool>(enhanceBassVar);
    request.bassEnhance.strength = bassEnhanceStrengthFromString(
        readOptionalString(payload, "bassEnhanceStrength").value_or(juce::String{}));

    const juce::var enhanceOtherVar = payload.getProperty("enhanceOther", juce::var());
    request.otherEnhance.enabled = enhanceOtherVar.isBool() && static_cast<bool>(enhanceOtherVar);
    request.otherEnhance.strength = otherEnhanceStrengthFromString(
        readOptionalString(payload, "otherEnhanceStrength").value_or(juce::String{}));

    activeJobId = jobId;
    silverdaw::log::info("stems", "STEM_SEPARATE job=" + jobId + " item=" + sourceItemId +
                                      " clip=" + (clipId.isNotEmpty() ? clipId : juce::String("(library)")) +
                                      " stems=" + juce::String((int) request.stems.size()) +
                                      " window=" + (request.lengthMs > 0.0
                                                        ? juce::String(request.startMs) + ".." +
                                                              juce::String(request.startMs + request.lengthMs) + "ms"
                                                        : juce::String("full")) +
                                      " gpu=" + (request.useGpu ? juce::String("1") : juce::String("0")) +
                                      " enhanceVocals=" + (request.vocalEnhance.enabled
                                          ? juce::String(vocalEnhanceStrengthToString(request.vocalEnhance.strength))
                                          : juce::String("0")) +
                                      " enhanceDrums=" + (request.drumEnhance.enabled
                                          ? juce::String(drumEnhanceStrengthToString(request.drumEnhance.strength))
                                          : juce::String("0")) +
                                      " enhanceBass=" + (request.bassEnhance.enabled
                                          ? juce::String(bassEnhanceStrengthToString(request.bassEnhance.strength))
                                          : juce::String("0")) +
                                      " enhanceOther=" + (request.otherEnhance.enabled
                                          ? juce::String(otherEnhanceStrengthToString(request.otherEnhance.strength))
                                          : juce::String("0")) +
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

double overlapForStemQuality(const juce::String& quality)
{
    // Window overlap per preset: fast trades seam smoothness for fewer model
    // runs; best does the opposite. Balanced mirrors the long-standing default
    // and also covers absent/unknown values.
    if (quality == "fast") return 0.10;
    if (quality == "best") return 0.50;
    return 0.25; // balanced
}

int shiftsForStemQuality(const juce::String& quality)
{
    // Vocal test-time-augmentation passes. Fast and balanced stay single-pass so
    // the default separation time is unchanged; only "best" pays the ~2x cost for
    // visibly fewer phase/edge artefacts on the vocal stem. Unknown/absent values
    // fall back to the balanced (single-pass) default.
    if (quality == "best") return 4;
    return 1; // fast / balanced / unknown
}

} // namespace silverdaw

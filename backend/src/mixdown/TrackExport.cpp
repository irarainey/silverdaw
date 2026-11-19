#include "TrackExport.h"

#include "Log.h"
#include "MixdownExport.h"
#include "MixdownRender.h"

#include <cmath>
#include <windows.h>

namespace silverdaw
{
namespace
{
juce::String trackFileStem(const juce::String& name, int index)
{
    juce::String stem;
    const juce::String invalid{"<>:\"/\\|?*"};
    for (auto p = name.getCharPointer(); !p.isEmpty() && stem.length() < 100;)
    {
        const auto c = p.getAndAdvance();
        stem += juce::String::charToString(c < 32 || invalid.containsChar(c) ? '_' : c);
    }
    stem = stem.trim().trimCharactersAtEnd(". ");
    if (stem.isEmpty()) return "Track " + juce::String(index);
    const auto device = stem.upToFirstOccurrenceOf(".", false, false).trimEnd().toUpperCase();
    const juce::StringArray reserved{"CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"};
    if (reserved.contains(device) ||
        (device.length() == 4 && (device.startsWith("COM") || device.startsWith("LPT")) &&
         juce::String::fromUTF8("0123456789\xc2\xb9\xc2\xb2\xc2\xb3").containsChar(device[3])))
        stem = "_" + stem;
    return stem;
}

MixdownSnapshot::TrackSnapshot withoutEffects(MixdownSnapshot::TrackSnapshot track)
{
    MixdownSnapshot::TrackSnapshot dry;
    dry.id = track.id;
    dry.name = track.name;
    dry.gain = track.gain;
    dry.pan = track.pan;
    dry.clips = std::move(track.clips);
    for (auto& lane : track.automation)
        if (lane.paramId == "pan" || lane.paramId == "level")
            dry.automation.push_back(std::move(lane));
    return dry;
}
}

TrackExportResult renderTrackBatch(MixdownSnapshot snapshot, const juce::File& exportDir,
                                   MixdownOptions options, bool includeEffects,
                                   const TrackExportProgress& progress, std::atomic<bool>& cancel)
{
    if (options.lengthMs <= 0.0)
        return {MixdownFailureCode::Invalid, "Nothing to export. Add a clip to the timeline first.", {}};
    if (!options.outputFrameRange)
        options.outputFrameRange.emplace(0, static_cast<int64_t>(std::ceil(
            options.lengthMs * options.outputSampleRate / 1000.0)) +
            std::llround(options.tailSeconds * options.outputSampleRate));
    const auto created = exportDir.createDirectory();
    if (created.failed()) return {MixdownFailureCode::Io, created.getErrorMessage(), {}};

    const auto staging = exportDir.getChildFile(".partial-" + juce::Uuid().toString());
    if (!CreateDirectoryW(staging.getFullPathName().toWideCharPointer(), nullptr))
        return {MixdownFailureCode::Io, "Could not create the temporary export folder.", {}};
    juce::ScopeGuard cleanup{[&] {
        if (staging.exists() && !staging.deleteRecursively())
            log::warn("export", "Could not remove incomplete export: " + staging.getFullPathName());
    }};

    auto tracks = std::move(snapshot.tracks);
    snapshot.tracks.clear();
    snapshot.masterGain = 1.0F;
    snapshot.mixGlueAmount = 0.0F;
    snapshot.safetyLimiterEnabled = false;
    const auto count = static_cast<int>(tracks.size());
    const juce::String extension = "." + juce::String(mixdown_export::formatExtension(options.format));
    for (int i = 0; i < count; ++i)
    {
        if (cancel.load()) return {MixdownFailureCode::Cancelled, "Cancelled.", {}};
        auto& track = tracks[static_cast<size_t>(i)];
        const auto stem = trackFileStem(track.name, i + 1);
        const auto name = track.name.isEmpty() ? stem : track.name;
        options.outputFile = staging.getChildFile(stem + extension);
        for (int suffix = 2; options.outputFile.exists(); ++suffix)
            options.outputFile = staging.getChildFile(stem + " (" + juce::String(suffix) + ")" + extension);

        if (track.gain <= 0.0F) track.clips.clear();
        const bool silent = track.clips.empty();
        snapshot.tracks.push_back(includeEffects && !silent ? std::move(track) : withoutEffects(std::move(track)));
        options.dither = !silent && options.bitDepth == 16;
        const auto file = renderOfflineFile(snapshot, options, [&](double pct, const char* stage) {
            progress((100.0 * i + pct) / count, stage, i + 1, count, name);
        }, cancel);
        if (file.failure) return {file.failure, name + ": " + file.message, {}};
        snapshot.tracks.clear();
    }

    const auto timestamp = juce::Time::getCurrentTime().formatted("%Y-%m-%d_%H-%M-%S");
    for (int number = 1; ; ++number)
    {
        if (cancel.load()) return {MixdownFailureCode::Cancelled, "Cancelled.", {}};
        const auto target = exportDir.getChildFile(number == 1 ? timestamp : timestamp + "-" + juce::String(number));
        if (target.exists()) continue;
        // Same-volume rename, without replacement even if another instance wins the race.
        if (MoveFileW(staging.getFullPathName().toWideCharPointer(), target.getFullPathName().toWideCharPointer()))
            return {std::nullopt, {}, target};
        if (!target.exists()) return {MixdownFailureCode::Io, "Could not publish the track export folder.", {}};
    }
}
} // namespace silverdaw

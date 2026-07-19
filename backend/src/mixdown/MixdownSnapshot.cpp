#include "MixdownEngine.h"

#include "AudioConstants.h"
#include "Log.h"
#include "MixdownTiming.h"
#include "ProjectState.h"

#include <utility>

namespace silverdaw
{


MixdownSnapshot snapshotProjectForMixdown(const ProjectState& project,
                                          double brakeSeconds,
                                          double brakeCurve,
                                          double backspinSeconds,
                                          double backspinSpeed,
                                          double backspinCurve)
{
    MixdownSnapshot snapshot;
    const int explicitRate = project.getTargetSampleRate();
    snapshot.projectSampleRate = isSupportedSampleRate(explicitRate)
                                     ? explicitRate
                                     : kDefaultSampleRate;
    snapshot.masterGain = juce::jlimit(0.0F, 1.0F, project.getMasterVolume());
    snapshot.safetyLimiterEnabled = project.getSafetyLimiterEnabled();

    snapshot.reverbSize = project.getProjectReverbSize();
    snapshot.reverbDecay = project.getProjectReverbDecay();
    snapshot.reverbTone = project.getProjectReverbTone();
    snapshot.reverbMix = project.getProjectReverbMix();
    snapshot.delayNoteValue = project.getProjectDelayNoteValue();
    snapshot.delayFeedback = project.getProjectDelayFeedback();
    snapshot.delayTone = project.getProjectDelayTone();
    snapshot.delayMix = project.getProjectDelayMix();
    snapshot.bpm = project.getBpm();

    static const juce::Identifier kTrack{"TRACK"};
    static const juce::Identifier kClip{"CLIP"};
    static const juce::Identifier kLibrary{"LIBRARY"};
    static const juce::Identifier kId{"id"};
    static const juce::Identifier kGain{"gain"};
    static const juce::Identifier kLibraryItemId{"libraryItemId"};
    static const juce::Identifier kOffsetMs{"offsetMs"};
    static const juce::Identifier kInMs{"inMs"};
    static const juce::Identifier kDurationMs{"durationMs"};
    static const juce::Identifier kWarpEnabled{"warpEnabled"};
    static const juce::Identifier kWarpMode{"warpMode"};
    static const juce::Identifier kSemitones{"semitones"};
    static const juce::Identifier kCents{"cents"};
    static const juce::Identifier kSampleRate{"sampleRate"};
    static const juce::Identifier kChannelCount{"channelCount"};

    const auto root = project.getTree();
    if (!root.isValid()) return snapshot;

    for (int t = 0; t < root.getNumChildren(); ++t)
    {
        const auto trackTree = root.getChild(t);
        if (!trackTree.hasType(kTrack)) continue;
        MixdownSnapshot::TrackSnapshot track;
        track.id = trackTree.getProperty(kId).toString();
        const float rawEffectiveGain = project.getEffectiveTrackGain(track.id);
        track.gain = juce::jlimit(kMinTrackGain, kMaxTrackGain, rawEffectiveGain);

        // Snapshot live per-track parameters so offline render stays in parity with playback.
        track.toneBassDb = project.getTrackToneBassDb(track.id);
        track.toneMidDb = project.getTrackToneMidDb(track.id);
        track.toneTrebleDb = project.getTrackToneTrebleDb(track.id);
        track.toneFilter = project.getTrackToneFilter(track.id);
        track.levelerAmount = project.getTrackLevelerAmount(track.id);
        track.saturationDrive = project.getTrackSaturationDrive(track.id);
        track.saturationMix = project.getTrackSaturationMix(track.id);
        track.bitCrusherRate = project.getTrackBitCrusherRate(track.id);
        track.bitCrusherBits = project.getTrackBitCrusherBits(track.id);
        track.bitCrusherBoost = project.getTrackBitCrusherBoost(track.id);
        track.bitCrusherMix = project.getTrackBitCrusherMix(track.id);
        track.reverbSend = project.getTrackReverbSend(track.id);
        track.delaySend = project.getTrackDelaySend(track.id);
        track.pan = project.getTrackPan(track.id);
        track.beatRepeats = project.getBeatRepeatRegions(track.id);

        // Per-track effect automation lanes for export parity with playback.
        const auto autoLanes = project.getTrackAutomationLanes(track.id);
        for (const auto& lane : autoLanes)
        {
            const juce::String paramId =
                lane.getProperty(juce::Identifier{"paramId"}, juce::var()).toString();
            const auto& ptsVar = lane.getProperty(juce::Identifier{"points"}, juce::var());
            if (paramId.isEmpty() || !ptsVar.isArray()) continue;
            MixdownSnapshot::TrackSnapshot::AutomationLane outLane;
            outLane.paramId = paramId;
            for (const auto& p : *ptsVar.getArray())
            {
                if (!p.isObject()) continue;
                outLane.points.emplace_back(
                    static_cast<double>(p.getProperty("timeMs", 0.0)),
                    static_cast<float>(static_cast<double>(p.getProperty("value", 0.0))));
            }
            if (outLane.points.size() >= 2) track.automation.push_back(std::move(outLane));
        }

        const bool trackMuted = project.getTrackMuted(track.id);
        const bool trackSoloed = project.getTrackSoloed(track.id);
        silverdaw::log::info(
            "mixdown",
            "snapshot track=" + track.id + " volume=" +
                juce::String(static_cast<double>(trackTree.getProperty(kGain, 1.0)), 4) +
                " muted=" + (trackMuted ? juce::String("true") : juce::String("false")) +
                " soloed=" + (trackSoloed ? juce::String("true") : juce::String("false")) +
                " effectiveGainRaw=" + juce::String(rawEffectiveGain, 4) +
                " effectiveGainClamped=" + juce::String(track.gain, 4) +
                (track.gain <= 0.0F ? " (silent — skipped)" : ""));
        if (track.gain <= 0.0F) continue;

        for (int c = 0; c < trackTree.getNumChildren(); ++c)
        {
            const auto clipTree = trackTree.getChild(c);
            if (!clipTree.hasType(kClip)) continue;
            MixdownSnapshot::ClipSnapshot clip;
            clip.id = clipTree.getProperty(kId).toString();
            const auto libraryItemId = clipTree.getProperty(kLibraryItemId).toString();
            clip.libraryItemId = libraryItemId;
            // NOTE: dispatcher overwrites this with live's resolved playback path for parity.
            clip.filePath = project.getLibraryItemPlaybackPath(libraryItemId);
            if (clip.filePath.isEmpty()) clip.filePath = project.getLibraryItemFilePath(libraryItemId);
            clip.offsetMs = static_cast<double>(clipTree.getProperty(kOffsetMs, 0.0));
            clip.inMs = static_cast<double>(clipTree.getProperty(kInMs, 0.0));
            clip.durationMs = static_cast<double>(clipTree.getProperty(kDurationMs, 0.0));
            clip.warpEnabled = static_cast<bool>(clipTree.getProperty(kWarpEnabled, false));
            clip.warpMode = clipTree.getProperty(kWarpMode, "rhythmic").toString();
            // Silverdaw tempoRatio is project/source; Rubber Band receives the inverse
            // internally.
            const auto timing = project.getClipEffectiveTiming(clip.id);
            clip.tempoRatio = timing.tempoRatio > 0.0 ? timing.tempoRatio : 1.0;
            clip.semitones = static_cast<double>(clipTree.getProperty(kSemitones, 0.0));
            clip.cents = static_cast<double>(clipTree.getProperty(kCents, 0.0));
            clip.effectiveDurationMs = timing.durationMs > 0.0 ? timing.durationMs : clip.durationMs;
            clip.envelopePoints = project.getClipEnvelope(clip.id);

            const auto edge = project.getClipEdgeFade(clip.id);
            clip.edgeFadeIn = edge.hasFadeIn;
            clip.edgeFadeInStartMs = edge.fadeInStartMs;
            clip.edgeFadeInEndMs = edge.fadeInEndMs;
            clip.edgeFadeInCurve = edge.fadeInCurve;
            clip.edgeFadeOut = edge.hasFadeOut;
            clip.edgeFadeOutStartMs = edge.fadeOutStartMs;
            clip.edgeFadeOutEndMs = edge.fadeOutEndMs;
            clip.edgeFadeOutCurve = edge.fadeOutCurve;

            clip.brakeSeconds = project.isClipBrake(clip.id) ? brakeSeconds : 0.0;
            clip.brakeCurve = brakeCurve;
            clip.backspinSeconds = project.isClipBackspin(clip.id) ? backspinSeconds : 0.0;
            clip.backspinSpeed = backspinSpeed;
            clip.backspinCurve = backspinCurve;

            clip.scratchPatternId = project.getClipScratchPatternId(clip.id);

            const auto library = root.getChildWithName(kLibrary);
            if (library.isValid())
            {
                for (int li = 0; li < library.getNumChildren(); ++li)
                {
                    const auto item = library.getChild(li);
                    if (item.getProperty(kId).toString() == libraryItemId)
                    {
                        clip.sourceSampleRate =
                            static_cast<int>(item.getProperty(kSampleRate, 0));
                        clip.sourceChannelCount =
                            static_cast<int>(item.getProperty(kChannelCount, 0));
                        break;
                    }
                }
            }

            if (clip.filePath.isNotEmpty() && clip.durationMs > 0.0)
            {
                silverdaw::log::info(
                    "mixdown",
                    "snapshot clip=" + clip.id +
                        " offsetMs=" + juce::String(clip.offsetMs, 1) +
                        " inMs=" + juce::String(clip.inMs, 1) +
                        " durationMs=" + juce::String(clip.durationMs, 1) +
                        " warpEnabled=" + (clip.warpEnabled ? juce::String("true") : juce::String("false")) +
                        " tempoRatio=" + juce::String(clip.tempoRatio, 4) +
                        " effectiveDurationMs=" + juce::String(clip.effectiveDurationMs, 1) +
                        " semitones=" + juce::String(clip.semitones, 2) +
                        " cents=" + juce::String(clip.cents, 2) +
                        " warpMode=" + clip.warpMode);
                track.clips.push_back(std::move(clip));
            }
        }
        if (!track.clips.empty()) snapshot.tracks.push_back(std::move(track));
    }
    return snapshot;
}

double computeLastClipEndMs(const MixdownSnapshot& snapshot)
{
    double maxEnd = 0.0;
    for (const auto& track : snapshot.tracks)
    {
        for (const auto& clip : track.clips)
        {
            maxEnd = juce::jmax(maxEnd, clipTimelineEndMs(clip));
        }
    }
    return maxEnd;
}

} // namespace silverdaw

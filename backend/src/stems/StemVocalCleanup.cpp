#include "StemVocalCleanup.h"

#include "Dereverberator.h"
#include "Log.h"
#include "VocalDebleeder.h"
#include "VocalRestorer.h"

namespace silverdaw
{
namespace
{
constexpr int kStemSampleRate = 44100;

void throwIfCancelled(const StemCancelFn& shouldCancel)
{
    if (shouldCancel && shouldCancel())
        throw StemSeparationError(StemFailureCode::Cancelled, "Cancelled");
}
} // namespace

void processStemVocalCleanup(juce::AudioBuffer<float>& vocal,
                             const juce::AudioBuffer<float>& normalisedMixture,
                             float mixtureMean, float mixtureStandardDeviation,
                             const StemSeparationRequest& request, bool vocalFromRoformer,
                             const StemVocalCleanupProgressFn& onProgress,
                             const StemCancelFn& shouldCancel)
{
    const auto report = [&](double fraction)
    {
        throwIfCancelled(shouldCancel);
        if (onProgress) onProgress(fraction);
    };
    report(0.0);

    const double dereverbBand =
        request.dereverb.enabled ? (request.vocalEnhance.enabled ? 0.45 : 0.90) : 0.0;
    const double denoiseBand = request.vocalEnhance.enabled ? (0.90 - dereverbBand) : 0.0;

    if (request.vocalEnhance.enabled && ! vocalFromRoformer)
    {
        juce::AudioBuffer<float> instrumental(vocal.getNumChannels(), vocal.getNumSamples());
        for (int channel = 0; channel < vocal.getNumChannels(); ++channel)
        {
            const float* mix = normalisedMixture.getReadPointer(channel);
            const float* vocalSamples = vocal.getReadPointer(channel);
            float* output = instrumental.getWritePointer(channel);
            for (int sample = 0; sample < vocal.getNumSamples(); ++sample)
                output[sample] =
                    (mix[sample] * mixtureStandardDeviation + mixtureMean) - vocalSamples[sample];
        }
        VocalDebleeder::process(
            vocal, instrumental, kStemSampleRate, request.vocalEnhance.strength);
        throwIfCancelled(shouldCancel);
    }

    float vocalReferenceLevel = 0.0f;
    if (request.dereverb.enabled)
    {
        vocalReferenceLevel = VocalRestorer::activeLoudness(vocal, kStemSampleRate);
        silverdaw::log::info("stems",
                             juce::String("applied vocal dereverb strength=")
                                 + dereverbStrengthToString(request.dereverb.strength));
        Dereverberator::process(vocal, kStemSampleRate, request.dereverb.strength,
                                [&](double fraction) { report(dereverbBand * fraction); });
    }

    if (request.vocalEnhance.enabled)
    {
        auto vocalOptions = request.vocalEnhance;
        vocalOptions.cleanModel = vocalFromRoformer;
        const float wet =
            vocalDenoiseWetFor(request.vocalEnhance.strength, vocalFromRoformer);
        silverdaw::log::info(
            "stems",
            juce::String("applied vocal cleanup strength=")
                + vocalEnhanceStrengthToString(request.vocalEnhance.strength)
                + (vocalFromRoformer ? " (clean-model: de-bleed skipped)" : "")
                + " denoiseWet=" + juce::String(wet, 2));
        VocalDenoiser::process(
            vocal, kStemSampleRate, wet,
            [&](double fraction) { report(dereverbBand + denoiseBand * fraction); });
        VocalEnhancer::process(vocal, kStemSampleRate, vocalOptions);
        throwIfCancelled(shouldCancel);
    }

    if (request.dereverb.enabled)
    {
        const auto restore = VocalRestorer::process(
            vocal, kStemSampleRate, request.dereverb.strength, vocalReferenceLevel);
        silverdaw::log::info(
            "stems",
            juce::String("applied vocal restore ref=")
                + juce::String(restore.referenceLevel, 4)
                + " proc=" + juce::String(restore.processedLevel, 4)
                + " makeup=" + juce::String(restore.makeupDb, 2) + "dB"
                + (restore.clamped ? " (clamped)" : ""));
    }
    report(1.0);
}

} // namespace silverdaw

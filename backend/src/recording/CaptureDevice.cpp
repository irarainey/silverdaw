#include "CaptureDevice.h"

#include "Log.h"

namespace silverdaw::recording
{
namespace
{
juce::AudioIODeviceType* findType(juce::AudioDeviceManager& manager, const juce::String& typeName)
{
    for (auto* type : manager.getAvailableDeviceTypes())
    {
        if (type == nullptr) continue;
        if (typeName.isEmpty() || type->getTypeName() == typeName) return type;
    }
    return nullptr;
}

// Driver types Silverdaw will not choose on its own, though a user may still pin either
// in Preferences.
//
// Exclusive mode seizes the endpoint: while a take rolls nothing else on the machine can
// use the microphone, and — worse for a default — opening fails outright if anything
// already holds it, which presents as an input that inexplicably will not start. It is
// not reliably quicker either; a WASAPI endpoint in exclusive mode reports double
// buffering, so it can measure slower than the shared path it replaced.
//
// DirectSound is the legacy fallback, and its default buffer is several times longer than
// any WASAPI path — 53 ms against 10 ms on test hardware. Every one of those milliseconds
// is delay the performer hears while monitoring, so it is a poor automatic choice even
// though it is a necessary last resort.
const char* const kExclusiveTypeName = "Windows Audio (Exclusive Mode)";
const char* const kDirectSoundTypeName = "DirectSound";

/**
 * The candidate device whose driver runs at the shortest period.
 *
 * Driver types are ranked by what they actually do rather than by what they are called: on
 * test hardware the type named for low latency runs at exactly the same 10 ms period as the
 * plain shared type, so a name-based preference would be superstition. Each candidate is
 * created — not opened — and asked for its default buffer, which is the period the endpoint
 * will really run at.
 */
std::unique_ptr<juce::AudioIODevice> createQuickestDevice(juce::AudioDeviceManager& factory,
                                                          const juce::String& wantedName)
{
    std::unique_ptr<juce::AudioIODevice> best;
    double bestMs = 0.0;

    for (auto* type : factory.getAvailableDeviceTypes())
    {
        if (type == nullptr || ! isAutomaticCaptureType(type->getTypeName())) continue;
        type->scanForDevices();
        const auto names = type->getDeviceNames(/*wantInputNames*/ true);
        const auto name = wantedName.isNotEmpty() ? wantedName : names[0];
        if (name.isEmpty() || ! names.contains(name)) continue;

        std::unique_ptr<juce::AudioIODevice> candidate(type->createDevice(/*output*/ {}, name));
        if (candidate == nullptr) continue;

        const auto rate =
            candidate->getCurrentSampleRate() > 0.0 ? candidate->getCurrentSampleRate() : 48000.0;
        const double ms = 1000.0 * candidate->getDefaultBufferSize() / rate;
        if (best == nullptr || ms < bestMs)
        {
            best = std::move(candidate);
            bestMs = ms;
        }
    }
    return best;
}
} // namespace

bool isAutomaticCaptureType(const juce::String& typeName)
{
    return typeName != kExclusiveTypeName && typeName != kDirectSoundTypeName;
}


CaptureDevice::CaptureDevice() = default;

CaptureDevice::~CaptureDevice()
{
    close();
}

std::vector<CaptureInputListing> enumerateCaptureInputs(bool refresh)
{
    // Message-thread only, like every other command handler, so a plain static is
    // the whole cache: scanning all driver types costs hundreds of milliseconds and
    // the dialog opens on it.
    static std::vector<CaptureInputListing> cached;
    static bool scanned = false;
    if (scanned && ! refresh) return cached;

    juce::AudioDeviceManager manager;
    std::vector<CaptureInputListing> listings;
    for (auto* type : manager.getAvailableDeviceTypes())
    {
        if (type == nullptr) continue;
        type->scanForDevices();
        listings.push_back({type->getTypeName(), type->getDeviceNames(/*wantInputNames*/ true)});
    }
    cached = std::move(listings);
    scanned = true;
    return cached;
}

CaptureOpenResult CaptureDevice::open(const juce::String& typeName, const juce::String& deviceName,
                                      juce::String& error)
{
    close();

    // Try the exact request first, then relax it: a remembered device may have
    // been unplugged since it was chosen, and no input at all is a different
    // failure from the wrong input.
    const auto createFrom = [&](juce::AudioIODeviceType* type, const juce::String& wantedName) {
        if (type == nullptr || device != nullptr) return;
        type->scanForDevices();
        for (const auto& name : type->getDeviceNames(/*wantInputNames*/ true))
        {
            if (wantedName.isNotEmpty() && name != wantedName) continue;
            if (auto* candidate = type->createDevice(/*outputDeviceName*/ {}, name))
            {
                device.reset(candidate);
                return;
            }
        }
    };

    // An explicit driver choice is honoured as given. Without one, rank the candidates by
    // what they can actually be driven at rather than accepting whichever type the platform
    // happens to list first (ADR 0030, Amendment 20).
    if (typeName.isNotEmpty()) createFrom(findType(typeFactory, typeName), deviceName);
    else device = createQuickestDevice(typeFactory, deviceName);

    for (auto* type : typeFactory.getAvailableDeviceTypes())
        createFrom(type, deviceName);
    for (auto* type : typeFactory.getAvailableDeviceTypes())
        createFrom(type, {});

    if (device == nullptr)
    {
        error = "No audio input device is available";
        return CaptureOpenResult::noDevice;
    }

    juce::BigInteger inputChannels;
    inputChannels.setRange(0, juce::jmax(1, device->getInputChannelNames().size()), true);
    const juce::BigInteger noOutputs;
    const auto rate = device->getCurrentSampleRate() > 0.0 ? device->getCurrentSampleRate() : 48000.0;
    // The driver's default, and deliberately not a shorter buffer from
    // `getAvailableBufferSizes` (ADR 0030, Amendment 20). A shared WASAPI endpoint advertises
    // sizes from 3 ms upwards but runs at a fixed period regardless, and a shorter request is
    // honoured by handing over only part of each period and *discarding the remainder*:
    // measured on test hardware, a 256-frame request against a 480-frame period lost 47% of
    // the audio while reporting no error and no dropped block. Buffer size is not a latency
    // lever here, and shortening it silently corrupts takes.
    error = device->open(inputChannels, noOutputs, rate, device->getDefaultBufferSize());
    if (error.isNotEmpty())
    {
        device.reset();
        return CaptureOpenResult::openFailed;
    }

    // Input latency is the term the head trim can least afford to get wrong (ADR 0030), and a
    // processed endpoint reports none of its DSP delay — log it so a field log shows the claim.
    log::info("recording", "capture device open type=" + getTypeName() + " device=" + getDeviceName()
                               + " rate=" + juce::String(getSampleRate(), 1)
                               + " buffer=" + juce::String(getBufferSize())
                               + " channels=" + juce::String(getInputChannelCount())
                               + " inLatencyMs=" + juce::String(getInputLatencyMs(), 1));
    return CaptureOpenResult::ok;
}

void CaptureDevice::close()
{
    if (device == nullptr) return;
    stop();
    device->close();
    device.reset();
}

void CaptureDevice::start(juce::AudioIODeviceCallback& callback)
{
    if (device == nullptr || started) return;
    device->start(&callback);
    started = true;
}

void CaptureDevice::stop()
{
    if (device == nullptr || ! started) return;
    device->stop();
    started = false;
}

juce::String CaptureDevice::getTypeName() const
{
    return device != nullptr ? device->getTypeName() : juce::String();
}

juce::String CaptureDevice::getDeviceName() const
{
    return device != nullptr ? device->getName() : juce::String();
}

juce::StringArray CaptureDevice::getInputChannelNames() const
{
    return device != nullptr ? device->getInputChannelNames() : juce::StringArray();
}

int CaptureDevice::getInputChannelCount() const
{
    return device != nullptr ? device->getActiveInputChannels().countNumberOfSetBits() : 0;
}

double CaptureDevice::getSampleRate() const
{
    return device != nullptr ? device->getCurrentSampleRate() : 0.0;
}

int CaptureDevice::getBufferSize() const
{
    return device != nullptr ? device->getCurrentBufferSizeSamples() : 0;
}

double CaptureDevice::getInputLatencyMs() const
{
    if (device == nullptr) return 0.0;
    const auto rate = device->getCurrentSampleRate();
    if (rate <= 0.0) return 0.0;
    return 1000.0 * static_cast<double>(device->getInputLatencyInSamples()) / rate;
}

} // namespace silverdaw::recording

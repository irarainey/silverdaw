#include "MidiControllerProfiles.h"

#include "Log.h"

#include <algorithm>

namespace silverdaw
{
namespace
{
std::optional<MidiControllerAction> parseAction(const juce::String& value)
{
    constexpr std::array actions{
        MidiControllerAction::playPause,      MidiControllerAction::previousMarker,
        MidiControllerAction::nextMarker,    MidiControllerAction::deckToggle,
        MidiControllerAction::shift,         MidiControllerAction::syncModifier,
        MidiControllerAction::jogScratch,    MidiControllerAction::jogPitchBend,
        MidiControllerAction::jogSearch,     MidiControllerAction::jogTouch,
        MidiControllerAction::wheelPitchBend, MidiControllerAction::wheelSearch,
        MidiControllerAction::browseTracks,  MidiControllerAction::browsePress,
        MidiControllerAction::timelineZoom,  MidiControllerAction::markerJump,
        MidiControllerAction::markerToggle,  MidiControllerAction::trackGain,
        MidiControllerAction::toneBass,      MidiControllerAction::toneMid,
        MidiControllerAction::toneTreble,    MidiControllerAction::filter,
        MidiControllerAction::masterVolume,  MidiControllerAction::crossfader};
    for (const auto action : actions)
        if (value == midiControllerActionName(action)) return action;
    return std::nullopt;
}

std::optional<MidiInputEncoding> parseEncoding(const juce::String& value)
{
    if (value == "button") return MidiInputEncoding::button;
    if (value == "relative") return MidiInputEncoding::relative;
    if (value == "relativeTwosComplement")
        return MidiInputEncoding::relativeTwosComplement;
    if (value == "absolute7") return MidiInputEncoding::absolute7;
    if (value == "absolute14") return MidiInputEncoding::absolute14;
    if (value == "absolute14Relative") return MidiInputEncoding::absolute14Relative;
    if (value == "padRange") return MidiInputEncoding::padRange;
    return std::nullopt;
}

std::optional<MidiOutputPurpose> parseOutputPurpose(const juce::String& value)
{
    if (value == "channelMeter") return MidiOutputPurpose::channelMeter;
    if (value == "playLight") return MidiOutputPurpose::playLight;
    if (value == "cueLight") return MidiOutputPurpose::cueLight;
    if (value == "deckSelectionLight") return MidiOutputPurpose::deckSelectionLight;
    if (value == "hotCueLights") return MidiOutputPurpose::hotCueLights;
    return std::nullopt;
}

int parseMessageType(const juce::String& value)
{
    if (value == "note") return 0x90;
    if (value == "cc") return 0xb0;
    return 0;
}

bool parseIntArray(const juce::var& value, std::vector<int>& result, int maximum)
{
    const auto* array = value.getArray();
    if (array == nullptr || array->isEmpty()) return false;
    result.reserve(static_cast<std::size_t>(array->size()));
    for (const auto& item : *array)
    {
        if (!item.isInt() && !item.isInt64()) return false;
        const auto parsed = static_cast<int>(item);
        if (parsed < 0 || parsed > maximum) return false;
        result.push_back(parsed);
    }
    return true;
}

bool parseOptionalInt(const juce::DynamicObject& object,
                      const juce::Identifier& property,
                      int defaultValue,
                      int& result)
{
    if (!object.hasProperty(property))
    {
        result = defaultValue;
        return true;
    }
    const auto value = object.getProperty(property);
    if (!value.isInt() && !value.isInt64()) return false;
    result = static_cast<int>(value);
    return true;
}

bool parseInputBinding(const juce::var& value, MidiInputBinding& binding)
{
    const auto* object = value.getDynamicObject();
    if (object == nullptr) return false;
    const auto action = parseAction(object->getProperty("action").toString());
    const auto encoding = parseEncoding(object->getProperty("encoding").toString());
    const auto messageType = parseMessageType(object->getProperty("message").toString());
    if (!action.has_value() || !encoding.has_value() || messageType == 0) return false;
    const auto data1Value = object->getProperty("data1");
    if (!data1Value.isInt() && !data1Value.isInt64()) return false;

    binding.action = *action;
    binding.encoding = *encoding;
    binding.messageType = messageType;
    binding.data1 = static_cast<int>(data1Value);
    if (!parseOptionalInt(*object, "count", 1, binding.data1Count) ||
        !parseOptionalInt(*object, "lsbData1", -1, binding.lsbData1) ||
        !parseOptionalInt(*object, "center", 64, binding.center) ||
        !parseOptionalInt(*object, "direction", 1, binding.direction) ||
        !parseOptionalInt(*object, "padOffset", 0, binding.padOffset))
        return false;
    if (binding.data1 < 0 || binding.data1 > 127 || binding.data1Count < 1 ||
        binding.data1 + binding.data1Count > 128 || binding.center < 0 ||
        binding.center > 127 || (binding.direction != -1 && binding.direction != 1))
        return false;

    if (!parseIntArray(object->getProperty("channels"), binding.channels, 15) ||
        !parseIntArray(object->getProperty("decks"), binding.decks, 2) ||
        binding.channels.size() != binding.decks.size())
        return false;

    if (object->hasProperty("shiftedAction"))
    {
        binding.shiftedAction =
            parseAction(object->getProperty("shiftedAction").toString());
        if (!binding.shiftedAction.has_value()) return false;
    }
    if (object->hasProperty("touchedAction"))
    {
        binding.touchedAction =
            parseAction(object->getProperty("touchedAction").toString());
        if (!binding.touchedAction.has_value()) return false;
    }
    const auto isFourteenBit = binding.encoding == MidiInputEncoding::absolute14 ||
                               binding.encoding == MidiInputEncoding::absolute14Relative;
    if (isFourteenBit &&
        (binding.data1 > 31 || binding.lsbData1 < 0 || binding.lsbData1 > 127 ||
         binding.lsbData1 == binding.data1))
        return false;
    const auto isPad = binding.encoding == MidiInputEncoding::padRange;
    if (isPad != (binding.action == MidiControllerAction::markerJump ||
                  binding.action == MidiControllerAction::markerToggle))
        return false;
    if (isPad &&
        (binding.padOffset < 1 || binding.padOffset + binding.data1Count - 1 > 8))
        return false;
    if (binding.action == MidiControllerAction::deckToggle &&
        std::any_of(binding.decks.begin(), binding.decks.end(),
                    [](int deck) { return deck < 1 || deck > 2; }))
        return false;
    if (binding.shiftedAction.has_value() &&
        binding.encoding != MidiInputEncoding::button &&
        binding.encoding != MidiInputEncoding::padRange &&
        binding.encoding != MidiInputEncoding::relative &&
        binding.encoding != MidiInputEncoding::relativeTwosComplement)
        return false;
    if (binding.touchedAction.has_value() &&
        binding.encoding != MidiInputEncoding::relative &&
        binding.encoding != MidiInputEncoding::relativeTwosComplement)
        return false;
    return true;
}

bool bindingsOverlap(const MidiInputBinding& left, const MidiInputBinding& right)
{
    if (left.messageType != right.messageType) return false;
    const auto sharesChannel = std::any_of(
        left.channels.begin(), left.channels.end(),
        [&right](int channel)
        {
            return std::find(right.channels.begin(), right.channels.end(), channel) !=
                   right.channels.end();
        });
    if (!sharesChannel) return false;
    const auto leftEnd = left.data1 + left.data1Count;
    const auto rightEnd = right.data1 + right.data1Count;
    if (left.data1 < rightEnd && right.data1 < leftEnd) return true;
    const auto leftUsesRightLsb =
        right.lsbData1 >= left.data1 && right.lsbData1 < leftEnd;
    const auto rightUsesLeftLsb =
        left.lsbData1 >= right.data1 && left.lsbData1 < rightEnd;
    return leftUsesRightLsb || rightUsesLeftLsb ||
           (left.lsbData1 >= 0 && left.lsbData1 == right.lsbData1);
}

bool parseInitMessages(const juce::var& value, std::vector<std::vector<juce::uint8>>& result)
{
    // Optional field: absent is valid (no init frames).
    if (value.isVoid()) return true;
    const auto* array = value.getArray();
    if (array == nullptr) return false;
    for (const auto& item : *array)
    {
        const auto* bytes = item.getArray();
        if (bytes == nullptr || bytes->isEmpty()) return false;
        std::vector<juce::uint8> frame;
        frame.reserve(static_cast<std::size_t>(bytes->size()));
        for (const auto& byteValue : *bytes)
        {
            if (!byteValue.isInt() && !byteValue.isInt64()) return false;
            const auto parsed = static_cast<int>(byteValue);
            if (parsed < 0 || parsed > 255) return false;
            frame.push_back(static_cast<juce::uint8>(parsed));
        }
        // A frame must start with a status byte and be either a well-formed SysEx
        // (0xF0 ... 0xF7) or a 1-3 byte channel-voice/system message.
        if (frame.front() < 0x80) return false;
        if (frame.front() == 0xF0)
        {
            if (frame.size() < 2 || frame.back() != 0xF7) return false;
        }
        else if (frame.size() > 3)
        {
            return false;
        }
        result.push_back(std::move(frame));
    }
    return true;
}

bool parseOutputBinding(const juce::var& value, MidiOutputBinding& binding)
{
    const auto* object = value.getDynamicObject();
    if (object == nullptr) return false;
    const auto purpose = parseOutputPurpose(object->getProperty("purpose").toString());
    const auto messageType = parseMessageType(object->getProperty("message").toString());
    if (!purpose.has_value() || messageType == 0) return false;
    const auto data1Value = object->getProperty("data1");
    if (!data1Value.isInt() && !data1Value.isInt64()) return false;
    binding.purpose = *purpose;
    binding.messageType = messageType;
    binding.data1 = static_cast<int>(data1Value);
    if (!parseOptionalInt(*object, "onValue", 127, binding.onValue) ||
        !parseOptionalInt(*object, "offValue", 0, binding.offValue) ||
        !parseOptionalInt(*object, "count", 8, binding.count) ||
        binding.onValue < 0 || binding.onValue > 127 ||
        binding.offValue < 0 || binding.offValue > 127 ||
        binding.count < 1 || binding.count > 8)
        return false;
    if (object->hasProperty("data1Values"))
    {
        const auto* values = object->getProperty("data1Values").getArray();
        if (values == nullptr || values->isEmpty()) return false;
        for (const auto& valueItem : *values)
        {
            if (!valueItem.isInt() && !valueItem.isInt64()) return false;
            const auto parsed = static_cast<int>(valueItem);
            if (parsed < 0 || parsed > 127) return false;
            binding.data1Values.push_back(parsed);
        }
    }
    if (binding.data1 < 0 || binding.data1 > 127 ||
        !parseIntArray(object->getProperty("channels"), binding.channels, 15))
        return false;
    if (!binding.data1Values.empty() &&
        binding.data1Values.size() != binding.channels.size() &&
        !(binding.purpose == MidiOutputPurpose::hotCueLights &&
          binding.data1Values.size() == static_cast<std::size_t>(binding.count)))
        return false;
    return true;
}

bool parseProfile(const juce::File& file, MidiControllerProfile& profile)
{
    juce::var root;
    const auto result = juce::JSON::parse(file.loadFileAsString(), root);
    const auto* object = root.getDynamicObject();
    if (result.failed() || object == nullptr) return false;

    profile.name = object->getProperty("name").toString().trim();
    const auto* models = object->getProperty("models").getArray();
    const auto excludedModelsValue = object->getProperty("excludedModels");
    const auto* excludedModels = excludedModelsValue.getArray();
    const auto* inputs = object->getProperty("inputs").getArray();
    const auto* outputs = object->getProperty("outputs").getArray();
    if (profile.name.isEmpty() || models == nullptr || models->isEmpty() ||
        (!excludedModelsValue.isVoid() && excludedModels == nullptr) ||
        inputs == nullptr || inputs->isEmpty() || outputs == nullptr)
        return false;

    for (const auto& model : *models)
    {
        const auto name = model.toString().trim().toUpperCase();
        if (name.isEmpty()) return false;
        profile.models.push_back(name);
    }
    if (excludedModels != nullptr)
        for (const auto& model : *excludedModels)
        {
            if (!model.isString()) return false;
            const auto name = model.toString().trim().toUpperCase();
            if (name.isEmpty()) return false;
            profile.excludedModels.push_back(name);
        }
    for (const auto& input : *inputs)
    {
        MidiInputBinding binding{};
        if (!parseInputBinding(input, binding)) return false;
        profile.inputs.push_back(std::move(binding));
    }
    for (auto left = profile.inputs.begin(); left != profile.inputs.end(); ++left)
        for (auto right = left + 1; right != profile.inputs.end(); ++right)
            if (bindingsOverlap(*left, *right)) return false;
    for (const auto& output : *outputs)
    {
        MidiOutputBinding binding{};
        if (!parseOutputBinding(output, binding)) return false;
        profile.outputs.push_back(std::move(binding));
    }
    if (!parseInitMessages(object->getProperty("init"), profile.initMessages)) return false;
    // Parse optional scratchTicksPerTurn; 0 = auto-detect from jog encoding.
    if (!parseOptionalInt(*object, "scratchTicksPerTurn", 0, profile.scratchTicksPerTurn)
        || profile.scratchTicksPerTurn < 0)
        return false;
    if (profile.scratchTicksPerTurn == 0)
    {
        // Auto-detect from jog binding encodings.
        bool hasAbsolute14Relative = false;
        for (const auto& binding : profile.inputs)
        {
            if (binding.action == MidiControllerAction::jogScratch
                || binding.action == MidiControllerAction::jogPitchBend
                || binding.action == MidiControllerAction::jogSearch
                || binding.action == MidiControllerAction::wheelPitchBend
                || binding.action == MidiControllerAction::wheelSearch)
            {
                if (binding.encoding == MidiInputEncoding::absolute14Relative)
                    hasAbsolute14Relative = true;
            }
        }
        profile.scratchTicksPerTurn = hasAbsolute14Relative ? 16384 : 512;
    }
    return true;
}

bool containsModelName(const juce::String& deviceName, const juce::String& model)
{
    auto start = deviceName.indexOf(model);
    while (start >= 0)
    {
        const auto beforeIsBoundary =
            start == 0 || !juce::CharacterFunctions::isLetterOrDigit(deviceName[start - 1]);
        const auto after = start + model.length();
        const auto afterIsBoundary =
            after == deviceName.length() ||
            !juce::CharacterFunctions::isLetterOrDigit(deviceName[after]);
        if (beforeIsBoundary && afterIsBoundary) return true;
        start = deviceName.indexOf(start + 1, model);
    }
    return false;
}

juce::File profileDirectory()
{
    const auto besideExecutable =
        juce::File::getSpecialLocation(juce::File::currentExecutableFile)
            .getSiblingFile("midi-mappings");
    if (besideExecutable.isDirectory()) return besideExecutable;
    return juce::File(SILVERDAW_MIDI_MAPPING_DIR);
}

std::vector<MidiControllerProfile> loadProfiles()
{
    juce::Array<juce::File> files;
    profileDirectory().findChildFiles(
        files, juce::File::findFiles, false, "*.json", juce::File::FollowSymlinks::no);
    std::vector<MidiControllerProfile> profiles;
    profiles.reserve(static_cast<std::size_t>(files.size()));
    for (const auto& file : files)
    {
        MidiControllerProfile profile;
        if (!parseProfile(file, profile))
        {
            silverdaw::log::error("midi", "invalid MIDI controller profile: " +
                                             file.getFileName());
            continue;
        }
        const auto hasDuplicateModel = std::any_of(
            profile.models.begin(), profile.models.end(), [&profiles](const auto& model)
            {
                return std::any_of(
                    profiles.begin(), profiles.end(), [&model](const auto& existing)
                    {
                        return std::find(existing.models.begin(), existing.models.end(), model) !=
                               existing.models.end();
                    });
            });
        if (hasDuplicateModel)
        {
            silverdaw::log::error("midi", "duplicate model in MIDI controller profile: " +
                                             file.getFileName());
            continue;
        }
        profiles.push_back(std::move(profile));
    }
    return profiles;
}

const std::vector<MidiControllerProfile>& profiles()
{
    static const auto loaded = loadProfiles();
    return loaded;
}
} // namespace

const MidiControllerProfile* findMidiControllerProfile(const juce::String& deviceName)
{
    const auto upperName = deviceName.toUpperCase();
    const MidiControllerProfile* bestMatch = nullptr;
    auto bestModelLength = -1;
    for (const auto& profile : profiles())
    {
        if (std::any_of(profile.excludedModels.begin(), profile.excludedModels.end(),
                        [&upperName](const auto& model)
                        { return containsModelName(upperName, model); }))
            continue;
        for (const auto& model : profile.models)
            if (containsModelName(upperName, model) &&
                (model.length() > bestModelLength ||
                 (model.length() == bestModelLength && bestMatch != nullptr &&
                  profile.name < bestMatch->name)))
            {
                bestMatch = &profile;
                bestModelLength = model.length();
            }
    }
    return bestMatch;
}

const MidiOutputBinding* findMidiOutputBinding(const MidiControllerProfile& profile,
                                               MidiOutputPurpose purpose) noexcept
{
    const auto match = std::find_if(
        profile.outputs.begin(), profile.outputs.end(),
        [purpose](const auto& binding) { return binding.purpose == purpose; });
    return match != profile.outputs.end() ? &*match : nullptr;
}

} // namespace silverdaw

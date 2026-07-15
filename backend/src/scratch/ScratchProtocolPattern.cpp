#include "ScratchProtocol.h"
#include "ScratchProtocolInternal.h"

namespace silverdaw::scratch
{
namespace
{

using namespace detail;

template <typename Point, typename ParsePoint>
std::optional<std::vector<Point>> parseKeyframes(const juce::var& object, const char* key,
                                                 std::int64_t durationUs, ParsePoint parsePoint)
{
    const auto value = property(object, key);
    const auto* array = value ? value->getArray() : nullptr;
    // Lanes must be nonempty.
    if (array == nullptr || array->isEmpty() || array->size() > kMaxPatternPoints)
    {
        return std::nullopt;
    }

    std::vector<Point> points;
    points.reserve(static_cast<std::size_t>(array->size()));
    std::int64_t previousTimeUs = -1;
    for (const auto& item : *array)
    {
        auto point = parsePoint(item);
        if (!point || point->timeUs <= previousTimeUs || point->timeUs > durationUs)
        {
            return std::nullopt;
        }
        previousTimeUs = point->timeUs;
        points.push_back(*point);
    }
    // First timestamp must be exactly 0, last must be exactly durationUs.
    // Duration zero: single point at 0 without duplicate timestamps.
    if (points.front().timeUs != 0)
        return std::nullopt;
    if (durationUs > 0 && points.back().timeUs != durationUs)
        return std::nullopt;
    if (durationUs == 0 && points.size() != 1)
        return std::nullopt;
    return points;
}

} // namespace

std::optional<Pattern> parsePattern(const juce::var& value)
{
    const auto id = requiredString(value, "id");
    const auto name = requiredString(value, "name");
    const auto duration = timeUs(value, "durationUs");
    const auto cropStart = timeUs(value, "cropStartUs");
    const auto cropEnd = timeUs(value, "cropEndUs");
    const auto sourceOffset = boundedTurns(value, "sourceOffsetTurns", kMaxAbsoluteTurns);
    const auto ownerDeck = deckSide(value, "ownerDeck");
    const auto curve = requiredString(value, "crossfaderCurve");
    if (!hasVersion(value, "version", kPatternVersion) || !id || !name || !duration || !cropStart
        || !cropEnd || !sourceOffset || !ownerDeck || !curve || *curve != kCrossfaderCurveVersion
        || *cropStart > *cropEnd || *cropEnd > *duration)
    {
        return std::nullopt;
    }

    const auto platter = parseKeyframes<PlatterKeyframe>(
        value, "platter", *duration, [](const juce::var& item) -> std::optional<PlatterKeyframe> {
            const auto time = timeUs(item, "timeUs");
            const auto turns = boundedTurns(item, "turns", kMaxAbsoluteTurns);
            const auto touched = requiredBool(item, "touched");
            if (!time || !turns || !touched)
            {
                return std::nullopt;
            }
            return PlatterKeyframe{*time, *turns, *touched};
        });
    const auto crossfader = parseKeyframes<CrossfaderKeyframe>(
        value, "crossfader", *duration, [](const juce::var& item) -> std::optional<CrossfaderKeyframe> {
            const auto time = timeUs(item, "timeUs");
            const auto pointValue = finiteNumber(item, "value");
            if (!time || !pointValue || *pointValue < 0.0 || *pointValue > 1.0)
            {
                return std::nullopt;
            }
            return CrossfaderKeyframe{*time, *pointValue};
        });
    if (!platter || !crossfader)
    {
        return std::nullopt;
    }

    Pattern result;
    result.id = *id;
    result.name = *name;
    result.durationUs = *duration;
    result.cropStartUs = *cropStart;
    result.cropEndUs = *cropEnd;
    result.sourceOffsetTurns = *sourceOffset;
    result.ownerDeck = *ownerDeck;
    result.platter = *platter;
    result.crossfader = *crossfader;

    if (const auto provenanceValue = property(value, "provenance"))
    {
        const auto sourceClipId = requiredString(*provenanceValue, "sourceClipId");
        if (!sourceClipId)
        {
            return std::nullopt;
        }
        PatternProvenance provenance;
        provenance.sourceClipId = *sourceClipId;
        if (const auto libraryItemId = property(*provenanceValue, "sourceLibraryItemId"))
        {
            if (!libraryItemId->isString() || libraryItemId->toString().isEmpty())
            {
                return std::nullopt;
            }
            provenance.sourceLibraryItemId = libraryItemId->toString();
        }
        result.provenance = provenance;
    }
    return result;
}

juce::var serializePattern(const Pattern& pattern)
{
    auto* object = new juce::DynamicObject();
    object->setProperty("id", pattern.id);
    object->setProperty("name", pattern.name);
    object->setProperty("version", kPatternVersion);
    object->setProperty("durationUs", static_cast<juce::int64>(pattern.durationUs));
    object->setProperty("cropStartUs", static_cast<juce::int64>(pattern.cropStartUs));
    object->setProperty("cropEndUs", static_cast<juce::int64>(pattern.cropEndUs));
    object->setProperty("sourceOffsetTurns", pattern.sourceOffsetTurns);
    object->setProperty("ownerDeck", static_cast<int>(pattern.ownerDeck));
    object->setProperty("crossfaderCurve", juce::String(kCrossfaderCurveVersion));

    juce::Array<juce::var> platterArray;
    for (const auto& kf : pattern.platter)
    {
        auto* point = new juce::DynamicObject();
        point->setProperty("timeUs", static_cast<juce::int64>(kf.timeUs));
        point->setProperty("turns", kf.turns);
        point->setProperty("touched", kf.touched);
        platterArray.add(juce::var(point));
    }
    object->setProperty("platter", platterArray);

    juce::Array<juce::var> crossfaderArray;
    for (const auto& kf : pattern.crossfader)
    {
        auto* point = new juce::DynamicObject();
        point->setProperty("timeUs", static_cast<juce::int64>(kf.timeUs));
        point->setProperty("value", kf.value);
        crossfaderArray.add(juce::var(point));
    }
    object->setProperty("crossfader", crossfaderArray);

    if (pattern.provenance)
    {
        auto* prov = new juce::DynamicObject();
        prov->setProperty("sourceClipId", pattern.provenance->sourceClipId);
        if (pattern.provenance->sourceLibraryItemId)
            prov->setProperty("sourceLibraryItemId", *pattern.provenance->sourceLibraryItemId);
        object->setProperty("provenance", juce::var(prov));
    }

    return juce::var(object);
}

} // namespace silverdaw::scratch

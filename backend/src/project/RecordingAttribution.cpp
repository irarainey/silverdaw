#include "ProjectState.h"

#include <cmath>

namespace silverdaw
{
namespace
{
bool finiteNumber(const juce::var& value)
{
    return (value.isDouble() || value.isInt() || value.isInt64()) && std::isfinite(static_cast<double>(value));
}

juce::var readSnapshot(const juce::var& value)
{
    if (!value.isObject()) return {};
    juce::var result(new juce::DynamicObject());
    auto& out = *result.getDynamicObject();
    for (const auto* key : {"recordingId", "fileName", "parentId", "title", "artist", "album",
                            "isrc", "composer", "label", "copyright", "stemRole"})
    {
        auto field = value.getProperty(key, {});
        if (!field.isString()) continue;
        auto text = field.toString().trim();
        if (juce::String(key) == "fileName")
            text = text.replaceCharacter('\\', '/').fromLastOccurrenceOf("/", false, false);
        if (text.isNotEmpty()) out.setProperty(key, text);
    }
    if (!out.hasProperty("recordingId") || !out.hasProperty("fileName")) return {};
    const auto start = value.getProperty("startMs", {}), end = value.getProperty("endMs", {});
    if (finiteNumber(start) && static_cast<double>(start) >= 0 &&
        finiteNumber(end) && static_cast<double>(end) > static_cast<double>(start))
    {
        out.setProperty("startMs", start);
        out.setProperty("endMs", end);
        const auto ratio = value.getProperty("ratio", {});
        if (finiteNumber(ratio) && static_cast<double>(ratio) > 0) out.setProperty("ratio", ratio);
    }
    return result;
}

juce::var derived(juce::var source, const juce::String& parent, double in, double length, double ratio, bool sameFile)
{
    if (!source.isObject()) return {};
    auto result = source.clone();
    auto& out = *result.getDynamicObject();
    out.setProperty("parentId", parent);
    if (sameFile) return result; // The saved clip's trim is already in parent-file coordinates.

    const auto scale = static_cast<double>(out.getProperty("ratio"));
    out.removeProperty("ratio");
    if (scale <= 0 || !std::isfinite(in) || in < 0) return result;
    const double limit = out.getProperty("endMs");
    const auto start = static_cast<double>(out.getProperty("startMs")) + in * scale;
    const auto end = length < 0 ? limit : juce::jmin(limit, start + length * scale);
    if (end > start)
    {
        out.setProperty("startMs", start);
        out.setProperty("endMs", end);
        if (std::isfinite(scale * ratio) && ratio > 0) out.setProperty("ratio", scale * ratio);
    }
    return result;
}
}

juce::var ProjectState::readItemAttribution(const juce::ValueTree& item)
{
    auto snapshot = readSnapshot(item["attribution"]);
    if (snapshot.isObject()) return snapshot;
    if (item[kSourceItemId].toString().isNotEmpty() ||
        (item.getProperty(kKind, "source").toString() != "source" && !static_cast<bool>(item[kRecordingOrigin])))
        return {};
    juce::var result(new juce::DynamicObject());
    auto& out = *result.getDynamicObject();
    const auto id = item[kId].toString(), media = item[kMediaId].toString();
    // Renderer IDs such as l1 restart in each project; never export them as recording identities.
    const bool localIndex = id.startsWithChar('l') && id.length() > 1 && id.substring(1).containsOnly("0123456789");
    const auto legacyKey = localIndex ? "legacy-" + juce::String::toHexString(
        item[kFilePath].toString().replaceCharacter('/', '\\').toLowerCase().hashCode64()) : id;
    out.setProperty("recordingId", media.isNotEmpty() ? media : legacyKey);
    out.setProperty("fileName", item.getProperty(kName, item[kFilePath]).toString());
    out.setProperty("startMs", 0);
    out.setProperty("endMs", item[kDurationMs]);
    out.setProperty("ratio", 1);
    return readSnapshot(result);
}

juce::var ProjectState::resolveAttribution(const juce::ValueTree& library, const juce::String& itemId)
{
    juce::Array<juce::ValueTree> chain;
    juce::StringArray seen;
    juce::var result;
    auto item = library.getChildWithProperty(kId, itemId);
    while (item.isValid())
    {
        const auto id = item[kId].toString();
        if (seen.contains(id)) return {};
        seen.add(id);
        result = readItemAttribution(item);
        if (result.isObject()) break;
        const auto parent = item[kSourceItemId].toString();
        if (parent.isEmpty()) return {};
        chain.add(item);
        item = library.getChildWithProperty(kId, parent);
    }
    for (int i = chain.size(); --i >= 0 && result.isObject();)
    {
        const auto child = chain.getReference(i);
        const auto kind = child[kKind].toString();
        const bool sameFile = kind == "clip" && item[kFilePath].toString().equalsIgnoreCase(child[kFilePath].toString());
        const bool aligned = !child.hasProperty(kScratchPatternId) &&
                             (kind == "stem" || (kind == "sample" && child[kAudioType].toString() == "music"));
        const double offset = child.getProperty(kSourceInMs, -1.0);
        result = derived(result, item[kId].toString(), aligned ? offset : -1.0,
                         static_cast<double>(child[kDurationMs]), aligned ? 1.0 : 0.0, sameFile);
        item = child;
    }
    return result;
}

juce::var ProjectState::getLibraryItemAttribution(const juce::String& itemId) const
{
    return resolveAttribution(root.getChildWithName(kLibrary), itemId);
}

juce::var ProjectState::deriveAttribution(const juce::String& parentId, double in, double length,
                                          double ratio, bool sameFile) const
{
    const auto source = getLibraryItemAttribution(parentId);
    return derived(source, parentId, in, length, ratio, sameFile);
}

bool ProjectState::setLibraryItemAttribution(const juce::String& itemId, const juce::var& attribution)
{
    auto item = root.getChildWithName(kLibrary).getChildWithProperty(kId, itemId);
    const auto snapshot = readSnapshot(attribution);
    if (!item.isValid() || !snapshot.isObject()) return false;
    item.setProperty("attribution", snapshot, &undoManager);
    // Pin a legacy source's path-derived ID on first use, so moving the project cannot change it.
    if (snapshot["recordingId"].toString().startsWith("legacy-"))
    {
        auto library = item.getParent();
        auto parent = library.getChildWithProperty(kId, snapshot["parentId"]);
        juce::StringArray seen;
        while (parent.isValid() && !seen.contains(parent[kId].toString()))
        {
            seen.add(parent[kId].toString());
            if (parent.getProperty(kKind, "source").toString() == "source" && !parent.hasProperty("attribution"))
            {
                const auto original = resolveAttribution(library, parent[kId].toString());
                if (original.isObject() && original["recordingId"] == snapshot["recordingId"])
                    parent.setProperty("attribution", original, &undoManager);
                break;
            }
            parent = library.getChildWithProperty(kId, parent[kSourceItemId]);
        }
    }
    return true;
}
}

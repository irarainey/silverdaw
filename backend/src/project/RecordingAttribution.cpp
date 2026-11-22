#include "ProjectState.h"

#include <array>
#include <cmath>
#include <filesystem>
#include <windows.h>
#include <bcrypt.h>

#pragma comment(lib, "bcrypt.lib")

namespace silverdaw
{
namespace
{
juce::String projectFileFingerprint(const juce::File& file, const juce::File& directory)
{
    namespace fs = std::filesystem;
    std::error_code error;
    const auto root = fs::canonical(directory.getFullPathName().toWideCharPointer(), error);
    if (error) return {};
    const auto path = fs::canonical(file.getFullPathName().toWideCharPointer(), error);
    if (error || !juce::File(path.c_str()).isAChildOf(juce::File(root.c_str()))
        || !fs::is_regular_file(path, error)) return {};

    juce::FileInputStream stream{juce::File(path.c_str())};
    if (!stream.openedOk()) return {};
    const auto size = stream.getTotalLength();
    if (size <= 0) return {};
    // Silent passages can match across unrelated recordings. Include portable file evidence
    // while keeping cold reads bounded even for multi-GB recordings.
    constexpr int block = 4096;
    juce::MemoryBlock bytes;
    {
        juce::MemoryOutputStream evidence(bytes, false);
        evidence.writeInt64(size);
        evidence.writeInt64(file.getLastModificationTime().toMilliseconds());
        evidence.writeString(file.getRelativePathFrom(directory).replaceCharacter('\\', '/').toLowerCase());
        const auto read = [&](juce::int64 offset, juce::int64 count)
        {
            return stream.setPosition(offset) && evidence.writeFromInputStream(stream, count) == count;
        };
        if (size <= 3 * block)
        {
            if (!read(0, size)) return {};
        }
        else if (!read(0, block) || !read((size - block) / 2, block) || !read(size - block, block))
            return {};
    }
    std::array<UCHAR, 32> digest{};
    if (BCryptHash(BCRYPT_SHA256_ALG_HANDLE, nullptr, 0, static_cast<PUCHAR>(bytes.getData()), static_cast<ULONG>(bytes.getSize()),
                   digest.data(), static_cast<ULONG>(digest.size())) != 0)
        return {};
    return "legacy-audio-" + juce::String::toHexString(digest.data(), static_cast<int>(digest.size()), 0);
}

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

juce::String ProjectState::LegacyRecordingIds::forPath(const juce::String& path) const
{
    const auto key = path.replaceCharacter('/', '\\').toLowerCase();
    if (const auto it = byPath.find(key); it != byPath.end()) return it->second;
    juce::String id;
    if (projectDirectory != juce::File{} && juce::File::isAbsolutePath(path)
        && juce::File(path).isAChildOf(projectDirectory))
        id = projectFileFingerprint(juce::File(path), projectDirectory);
    if (id.isEmpty()) id = "legacy-" + juce::String::toHexString(key.hashCode64());
    return byPath.emplace(key, id).first->second;
}

juce::var ProjectState::readItemAttribution(const juce::ValueTree& item, const LegacyRecordingIds& legacyIds)
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
    out.setProperty("recordingId", media.isNotEmpty() ? media
                                 : localIndex ? legacyIds.forPath(item[kFilePath].toString()) : id);
    out.setProperty("fileName", item.getProperty(kName, item[kFilePath]).toString());
    out.setProperty("startMs", 0);
    out.setProperty("endMs", item[kDurationMs]);
    out.setProperty("ratio", 1);
    return readSnapshot(result);
}

juce::var ProjectState::resolveAttribution(const juce::ValueTree& library, const juce::String& itemId,
                                           const LegacyRecordingIds& legacyIds)
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
        result = readItemAttribution(item, legacyIds);
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
        const bool scratch = child.hasProperty(kScratchPatternId);
        const bool aligned = !scratch &&
                             (kind == "stem" || (kind == "sample" && child[kAudioType].toString() == "music"));
        const auto in = child.getProperty(kSourceInMs);
        const auto length = child.getProperty(scratch ? kSourceDurationMs : kDurationMs);
        const bool knownWindow = finiteNumber(in) && (aligned || (scratch && finiteNumber(length)
                                                                  && static_cast<double>(length) > 0));
        result = derived(result, item[kId].toString(), knownWindow ? static_cast<double>(in) : -1.0,
                         static_cast<double>(length), aligned ? 1.0 : 0.0, sameFile);
        item = child;
    }
    return result;
}

juce::var ProjectState::getLibraryItemAttribution(const juce::String& itemId) const
{
    return resolveAttribution(root.getChildWithName(kLibrary), itemId, legacyRecordingIds);
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
    // Keep the captured identity even if the original is later relinked or goes offline.
    if (snapshot["recordingId"].toString().startsWith("legacy-"))
    {
        auto library = item.getParent();
        auto parent = library.getChildWithProperty(kId, snapshot["parentId"]);
        juce::StringArray seen;
        while (parent.isValid() && !seen.contains(parent[kId].toString()))
        {
            seen.add(parent[kId].toString());
            if ((parent.getProperty(kKind, "source").toString() == "source" || static_cast<bool>(parent[kRecordingOrigin]))
                && !parent.hasProperty("attribution"))
            {
                const auto original = resolveAttribution(library, parent[kId].toString(), legacyRecordingIds);
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

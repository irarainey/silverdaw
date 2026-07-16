#include "ProjectState.h"
#include "ScratchPatternState.h"

#include "scratch/ScratchProtocol.h"

namespace silverdaw
{

using scratch_ids::kScratchPatterns;
using scratch_ids::kScratchPattern;
using scratch_ids::kScratchPatternData;

bool ProjectState::hasScratchPattern(const juce::String& patternId) const noexcept
{
    const auto patterns = root.getChildWithName(kScratchPatterns);
    if (!patterns.isValid()) return false;

    for (int i = 0; i < patterns.getNumChildren(); ++i)
    {
        const auto child = patterns.getChild(i);
        if (child.hasType(kScratchPattern) && child.getProperty(kId).toString() == patternId)
            return true;
    }
    return false;
}

bool ProjectState::addScratchPattern(const juce::var& patternData)
{
    // Validate before touching the tree — enforces all ScratchProtocol invariants.
    const auto parsed = scratch::parsePattern(patternData);
    if (!parsed)
        return false;

    const juce::String patternId = parsed->id;
    const auto serialized = scratch::serializePattern(*parsed);

    // Locate or lazily create the container. Use the undoManager so undo can
    // remove the container when the last pattern added in that transaction is
    // reverted, preventing an empty container from drifting the tree.
    juce::ValueTree patterns;
    for (int i = 0; i < root.getNumChildren(); ++i)
    {
        auto child = root.getChild(i);
        if (child.hasType(kScratchPatterns))
        {
            patterns = child;
            break;
        }
    }
    if (!patterns.isValid())
    {
        patterns = juce::ValueTree(kScratchPatterns);
        root.addChild(patterns, -1, &undoManager);
    }

    // If the id already exists, update in place (idempotent — same semantics as addMarker).
    for (int i = 0; i < patterns.getNumChildren(); ++i)
    {
        auto existing = patterns.getChild(i);
        if (existing.hasType(kScratchPattern) && existing.getProperty(kId).toString() == patternId)
        {
            existing.setProperty(kScratchPatternData, serialized, &undoManager);
            return true;
        }
    }

    // New pattern node.
    juce::ValueTree node(kScratchPattern);
    node.setProperty(kId, patternId, nullptr);
    node.setProperty(kScratchPatternData, serialized, nullptr);
    patterns.addChild(node, -1, &undoManager);
    return true;
}

bool ProjectState::updateScratchPattern(const juce::String& patternId, const juce::var& patternData)
{
    if (patternId.isEmpty())
        return false;

    // Validate before touching the tree.
    const auto parsed = scratch::parsePattern(patternData);
    if (!parsed)
        return false;

    const auto serialized = scratch::serializePattern(*parsed);

    auto patterns = root.getChildWithName(kScratchPatterns);
    if (!patterns.isValid())
        return false;

    for (int i = 0; i < patterns.getNumChildren(); ++i)
    {
        auto existing = patterns.getChild(i);
        if (existing.hasType(kScratchPattern) && existing.getProperty(kId).toString() == patternId)
        {
            existing.setProperty(kScratchPatternData, serialized, &undoManager);
            return true;
        }
    }
    return false;
}

bool ProjectState::removeScratchPattern(const juce::String& patternId)
{
    if (patternId.isEmpty())
        return false;

    auto patterns = root.getChildWithName(kScratchPatterns);
    if (!patterns.isValid())
        return false;

    for (int i = patterns.getNumChildren() - 1; i >= 0; --i)
    {
        auto child = patterns.getChild(i);
        if (child.hasType(kScratchPattern) && child.getProperty(kId).toString() == patternId)
        {
            patterns.removeChild(child, &undoManager);
            return true;
        }
    }
    return false;
}

bool ProjectState::renameScratchPattern(const juce::String& patternId, const juce::String& newName)
{
    if (patternId.isEmpty() || newName.isEmpty())
        return false;

    auto patterns = root.getChildWithName(kScratchPatterns);
    if (!patterns.isValid())
        return false;

    for (int i = 0; i < patterns.getNumChildren(); ++i)
    {
        auto child = patterns.getChild(i);
        if (child.hasType(kScratchPattern) && child.getProperty(kId).toString() == patternId)
        {
            // Parse, update the name, re-serialise: keeps the undo-manager old-value correct.
            const auto existing = scratch::parsePattern(child.getProperty(kScratchPatternData));
            if (!existing)
                return false;
            scratch::Pattern updated = *existing;
            updated.name = newName;
            child.setProperty(kScratchPatternData, scratch::serializePattern(updated), &undoManager);
            return true;
        }
    }
    return false;
}

} // namespace silverdaw

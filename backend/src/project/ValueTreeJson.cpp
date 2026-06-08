#include "ValueTreeJson.h"

namespace silverdaw::ValueTreeJson
{

juce::var toVar(const juce::ValueTree& tree)
{
    if (!tree.isValid())
    {
        return {};
    }

    auto* obj = new juce::DynamicObject();
    obj->setProperty(kTypeKey, tree.getType().toString());

    // Properties — `juce::var` is natively serialisable by `juce::JSON`
    // for the primitive / array / object flavours we use. Anything else
    // round-trips as its `.toString()` form rather than being lost, so a
    // mistakenly-stored MemoryBlock still produces readable output.
    const int numProps = tree.getNumProperties();
    for (int i = 0; i < numProps; ++i)
    {
        const auto name = tree.getPropertyName(i);
        const auto& value = tree.getProperty(name);
        obj->setProperty(name, value);
    }

    // Children — emit a `$children` array only when there are any, so
    // leaf nodes serialise as compact objects without trailing empty
    // arrays cluttering up diffs.
    const int numChildren = tree.getNumChildren();
    if (numChildren > 0)
    {
        juce::Array<juce::var> kids;
        kids.ensureStorageAllocated(numChildren);
        for (int i = 0; i < numChildren; ++i)
        {
            kids.add(toVar(tree.getChild(i)));
        }
        obj->setProperty(kChildrenKey, juce::var(std::move(kids)));
    }

    return juce::var{obj};
}

juce::ValueTree fromVar(const juce::var& value)
{
    auto* obj = value.getDynamicObject();
    if (obj == nullptr)
    {
        return {};
    }

    const auto typeStr = obj->getProperty(kTypeKey).toString();
    if (typeStr.isEmpty() || !juce::Identifier::isValidIdentifier(typeStr))
    {
        return {};
    }

    juce::ValueTree tree(juce::Identifier{typeStr});

    // Walk every property, skipping the two reserved keys. ValueTrees
    // don't preserve property iteration order in any meaningful sense,
    // so we don't sort — the JSON file will reflect whatever order JUCE
    // gave us, which is insertion order in practice.
    for (const auto& nameValue : obj->getProperties())
    {
        const auto& name = nameValue.name;
        if (name.toString() == kTypeKey || name.toString() == kChildrenKey)
        {
            continue;
        }
        tree.setProperty(name, nameValue.value, nullptr);
    }

    if (auto* childArray = obj->getProperty(kChildrenKey).getArray())
    {
        for (const auto& child : *childArray)
        {
            auto childTree = fromVar(child);
            if (childTree.isValid())
            {
                tree.appendChild(childTree, nullptr);
            }
        }
    }

    return tree;
}

} // namespace silverdaw::ValueTreeJson

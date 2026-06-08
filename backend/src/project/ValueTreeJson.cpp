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

    // Unsupported var flavours stringify rather than disappearing silently.
    const int numProps = tree.getNumProperties();
    for (int i = 0; i < numProps; ++i)
    {
        const auto name = tree.getPropertyName(i);
        const auto& value = tree.getProperty(name);
        obj->setProperty(name, value);
    }

    // Omit empty children arrays to keep saved diffs compact.
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

    // Preserve JUCE's property order; sorting would add churn without semantic value.
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

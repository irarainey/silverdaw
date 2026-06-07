#include "CommandHelpers.h"

#include "BridgeServer.h"

namespace silverdaw
{

void broadcastApplied(BridgeServer& bridge, juce::StringRef type,
                      std::initializer_list<std::pair<const char*, juce::var>> fields,
                      bool ok)
{
    auto* p = new juce::DynamicObject();
    for (const auto& field : fields)
    {
        p->setProperty(field.first, field.second);
    }
    p->setProperty("ok", ok);
    bridge.broadcast(type, juce::var(p));
}

} // namespace silverdaw

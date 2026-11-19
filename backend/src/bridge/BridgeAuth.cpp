#include "BridgeAuth.h"
#include "PayloadHelpers.h"

namespace silverdaw::bridge_auth
{

bool isTokenValid(const juce::String& expectedToken, const juce::var& payload)
{
    if (!expectedToken.containsNonWhitespaceChars())
    {
        return false;
    }

    const auto token = bridge::tryGetRequiredString(payload, "token");
    if (!token || token->length() != expectedToken.length())
    {
        return false;
    }

    int diff = 0;
    for (int i = 0; i < expectedToken.length(); ++i)
    {
        diff |= static_cast<int>(expectedToken[i]) ^ static_cast<int>((*token)[i]);
    }
    return diff == 0;
}

} // namespace silverdaw::bridge_auth

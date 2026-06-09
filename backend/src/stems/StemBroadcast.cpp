#include "StemBroadcast.h"

#include "BridgeServer.h"

namespace silverdaw::stem_bridge
{

void broadcastProgress(BridgeServer& bridge,
                       const juce::String& jobId,
                       const juce::String& clipId,
                       const char* stage,
                       double percent,
                       const juce::String& detail)
{
    auto* obj = new juce::DynamicObject();
    obj->setProperty("jobId", jobId);
    if (clipId.isNotEmpty())
        obj->setProperty("clipId", clipId);
    obj->setProperty("stage", juce::String(stage));
    obj->setProperty("percent", juce::jlimit(0.0, 100.0, percent));
    if (detail.isNotEmpty())
        obj->setProperty("detail", detail);
    bridge.broadcast("STEM_PROGRESS", juce::var(obj));
}

void broadcastPartial(BridgeServer& bridge,
                      const juce::String& jobId,
                      const juce::String& clipId,
                      const juce::String& sourceName,
                      const juce::String& stem,
                      const juce::File& file)
{
    auto* obj = new juce::DynamicObject();
    obj->setProperty("jobId", jobId);
    if (clipId.isNotEmpty())
        obj->setProperty("clipId", clipId);
    obj->setProperty("sourceName", sourceName);
    obj->setProperty("stem", stem);
    obj->setProperty("filePath", file.getFullPathName());
    bridge.broadcast("STEM_PARTIAL", juce::var(obj));
}

void broadcastReady(BridgeServer& bridge,
                    const juce::String& jobId,
                    const juce::String& clipId,
                    const juce::String& sourceName,
                    const std::vector<StemResultFile>& stems)
{
    auto* obj = new juce::DynamicObject();
    obj->setProperty("jobId", jobId);
    if (clipId.isNotEmpty())
        obj->setProperty("clipId", clipId);
    obj->setProperty("sourceName", sourceName);

    juce::Array<juce::var> stemArray;
    for (const auto& s : stems)
    {
        auto* entry = new juce::DynamicObject();
        entry->setProperty("stem", s.stem);
        entry->setProperty("filePath", s.file.getFullPathName());
        stemArray.add(juce::var(entry));
    }
    obj->setProperty("stems", stemArray);
    bridge.broadcast("STEM_READY", juce::var(obj));
}

void broadcastFailed(BridgeServer& bridge,
                     const juce::String& jobId,
                     const juce::String& clipId,
                     StemFailureCode code,
                     const juce::String& error)
{
    auto* obj = new juce::DynamicObject();
    obj->setProperty("jobId", jobId);
    if (clipId.isNotEmpty())
        obj->setProperty("clipId", clipId);
    obj->setProperty("code", juce::String(stemFailureCodeToString(code)));
    obj->setProperty("error", error);
    bridge.broadcast("STEM_FAILED", juce::var(obj));
}

} // namespace silverdaw::stem_bridge

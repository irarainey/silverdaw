#pragma once

// Shared scratch-pattern test fixtures. Consolidates pattern construction and
// JSON parsing helpers so persistence, protocol, and recorder tests share one
// source of truth for fixture data without duplicating pattern construction logic.

#include "TestSupport.h"
#include "scratch/ScratchProtocol.h"

#include <juce_core/juce_core.h>

namespace silverdaw::tests
{

// Parse a raw JSON literal into juce::var (shared across scratch test TUs).
inline juce::var parseJson(const char* json)
{
    return juce::JSON::parse(juce::String::fromUTF8(json));
}

// Minimal valid scratch-pattern JSON var (id, name, version 1, two platter + two
// crossfader keyframes over a 2-second duration). Used as the canonical fixture
// for CRUD, round-trip, dirty-baseline, and reconciliation tests.
inline juce::var makeValidPatternVar(const juce::String& id = "sp-1",
                                     const juce::String& name = "Test")
{
    auto* obj = new juce::DynamicObject();
    obj->setProperty("id", id);
    obj->setProperty("name", name);
    obj->setProperty("version", 1);
    obj->setProperty("durationUs", static_cast<juce::int64>(2000000));
    obj->setProperty("cropStartUs", static_cast<juce::int64>(0));
    obj->setProperty("cropEndUs", static_cast<juce::int64>(2000000));
    obj->setProperty("sourceOffsetTurns", 0.0);
    obj->setProperty("ownerDeck", 1);
    obj->setProperty("crossfaderCurve", juce::String("linear-v1"));

    juce::Array<juce::var> platter;
    {
        auto* p0 = new juce::DynamicObject();
        p0->setProperty("timeUs", static_cast<juce::int64>(0));
        p0->setProperty("turns", 0.0);
        p0->setProperty("touched", true);
        platter.add(juce::var(p0));
    }
    {
        auto* p1 = new juce::DynamicObject();
        p1->setProperty("timeUs", static_cast<juce::int64>(2000000));
        p1->setProperty("turns", -0.5);
        p1->setProperty("touched", false);
        platter.add(juce::var(p1));
    }
    obj->setProperty("platter", platter);

    juce::Array<juce::var> crossfader;
    {
        auto* c0 = new juce::DynamicObject();
        c0->setProperty("timeUs", static_cast<juce::int64>(0));
        c0->setProperty("value", 1.0);
        crossfader.add(juce::var(c0));
    }
    {
        auto* c1 = new juce::DynamicObject();
        c1->setProperty("timeUs", static_cast<juce::int64>(2000000));
        c1->setProperty("value", 0.5);
        crossfader.add(juce::var(c1));
    }
    obj->setProperty("crossfader", crossfader);

    return juce::var(obj);
}

} // namespace silverdaw::tests

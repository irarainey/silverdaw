#include "TestRegistry.h"

#include "midi/PioneerDeckMapping.h"

namespace silverdaw::tests
{
namespace
{
void testPioneerMappingMatchesSupportedModels()
{
    require(supportsPioneerTwoDeckMapping("DDJ-RB"), "DDJ-RB should use the common mapping");
    require(supportsPioneerTwoDeckMapping("PIONEER DDJ-SX2"), "prefixed model name should match");
    require(supportsPioneerTwoDeckMapping("DDJ-SB2"), "explicit compatible derivative should match");
    require(!supportsPioneerTwoDeckMapping("DDJ-SB3"), "unverified derivative should not match");
    require(!supportsPioneerTwoDeckMapping("DDJ-FLX4"), "incompatible jog-search family should not match");
    require(!supportsPioneerTwoDeckMapping("MPK mini"), "unrelated MIDI device should not match");
}

void testPioneerMappingMapsDeckTransport()
{
    PioneerDeckMapper mapper;
    const auto deck1 = mapper.mapMessage(0x90, 0x0b, 0x7f);
    const auto deck2 = mapper.mapMessage(0x91, 0x0b, 0x7f);
    require(deck1.has_value() && deck1->control == PioneerDeckControl::playPause &&
                deck1->deck == 1 && deck1->value == 1.0,
            "deck 1 Play should map to pressed play/pause");
    require(deck2.has_value() && deck2->control == PioneerDeckControl::playPause &&
                deck2->deck == 2,
            "deck 2 Play should map on MIDI channel 2");
}

void testPioneerMappingMapsCueNavigation()
{
    PioneerDeckMapper mapper;
    const auto previous = mapper.mapMessage(0x90, 0x0c, 0x7f);
    require(previous.has_value() && previous->control == PioneerDeckControl::previousMarker,
            "Cue should navigate to the previous marker");

    mapper.mapMessage(0x90, 0x3f, 0x7f);
    const auto shifted = mapper.mapMessage(0x90, 0x0c, 0x7f);
    require(shifted.has_value() && shifted->control == PioneerDeckControl::nextMarker,
            "Shift plus Cue should navigate to the next marker");

    const auto dedicatedShiftCue = mapper.mapMessage(0x91, 0x48, 0x7f);
    require(dedicatedShiftCue.has_value() &&
                dedicatedShiftCue->control == PioneerDeckControl::nextMarker &&
                dedicatedShiftCue->deck == 2,
            "hardware shifted-Cue note should navigate forward");
}

void testPioneerMappingMapsJogMovement()
{
    PioneerDeckMapper mapper;
    const auto clockwise = mapper.mapMessage(0xb0, 0x22, 0x43);
    const auto counterClockwise = mapper.mapMessage(0xb1, 0x22, 0x3e);
    require(clockwise.has_value() && clockwise->control == PioneerDeckControl::jogScratch &&
                clockwise->deck == 1 && clockwise->value == 3.0,
            "clockwise jog movement should retain its relative delta");
    require(counterClockwise.has_value() &&
                counterClockwise->control == PioneerDeckControl::jogScratch &&
                counterClockwise->deck == 2 && counterClockwise->value == -2.0,
            "counter-clockwise jog movement should decode its centred delta");
}

void testPioneerMappingMapsJogTouch()
{
    PioneerDeckMapper mapper;
    const auto pressed = mapper.mapMessage(0x91, 0x36, 0x7f);
    const auto released = mapper.mapMessage(0x91, 0x36, 0x00);
    require(pressed.has_value() && pressed->control == PioneerDeckControl::jogTouch &&
                pressed->deck == 2 && pressed->value == 1.0,
            "jog touch press should map for deck 2");
    require(released.has_value() && released->value == 0.0,
            "zero-velocity Note On should release jog touch");
}

void testPioneerMappingMapsHighResolutionCrossfader()
{
    PioneerDeckMapper mapper;
    require(!mapper.mapMessage(0xb6, 0x3f, 0x7f).has_value(),
            "orphan crossfader LSB should be ignored");
    mapper.mapMessage(0xb6, 0x1f, 0x40);
    const auto mapped = mapper.mapMessage(0xb6, 0x3f, 0x00);
    require(mapped.has_value() && mapped->control == PioneerDeckControl::crossfader &&
                mapped->kind == PioneerDeckControlKind::absolute && mapped->deck == 0,
            "crossfader should be a global absolute control");
    require(mapped->value > 0.49 && mapped->value < 0.51,
            "14-bit crossfader midpoint should normalize near 0.5");
}
} // namespace

void addPioneerDeckMappingTests(std::vector<TestCase>& tests)
{
    tests.push_back({"Pioneer mapping matches supported models", testPioneerMappingMatchesSupportedModels});
    tests.push_back({"Pioneer mapping maps deck transport", testPioneerMappingMapsDeckTransport});
    tests.push_back({"Pioneer mapping maps Cue navigation", testPioneerMappingMapsCueNavigation});
    tests.push_back({"Pioneer mapping maps jog movement", testPioneerMappingMapsJogMovement});
    tests.push_back({"Pioneer mapping maps jog touch", testPioneerMappingMapsJogTouch});
    tests.push_back(
        {"Pioneer mapping maps high-resolution crossfader", testPioneerMappingMapsHighResolutionCrossfader});
}

} // namespace silverdaw::tests

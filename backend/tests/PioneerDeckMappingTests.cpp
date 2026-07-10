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
    require(supportsPioneerTwoDeckMapping("DDJ-SB3"), "verified SB3 derivative should match");
    require(supportsPioneerTwoDeckMapping("DDJ-SR2"), "verified SR2 derivative should match");
    require(supportsPioneerTwoDeckMapping("DDJ-SX3"), "verified SX3 derivative should match");
    require(!supportsPioneerTwoDeckMapping("DDJ-FLX4"), "incompatible jog-search family should not match");
    require(!supportsPioneerTwoDeckMapping("MPK mini"), "unrelated MIDI device should not match");
}

void testPioneerMappingMapsSx3SyncNote()
{
    PioneerDeckMapper mapper{"DDJ-SX3"};
    const auto sync = mapper.mapMessage(0x90, 0x5d, 0x7f);
    const auto legacySync = mapper.mapMessage(0x90, 0x58, 0x7f);
    require(sync.has_value() && sync->control == PioneerDeckControl::syncModifier &&
                sync->deck == 1,
            "DDJ-SX3 alternate Sync note should map as the jog modifier");
    require(!legacySync.has_value(), "DDJ-SX3 should not claim the common Sync note");
}

void testPioneerMappingMapsDeckTransport()
{
    PioneerDeckMapper mapper{"DDJ-RB"};
    const auto deck1 = mapper.mapMessage(0x90, 0x0b, 0x7f);
    const auto deck2 = mapper.mapMessage(0x91, 0x0b, 0x7f);
    const auto sync = mapper.mapMessage(0x91, 0x58, 0x7f);
    require(deck1.has_value() && deck1->control == PioneerDeckControl::playPause &&
                deck1->deck == 1 && deck1->value == 1.0,
            "deck 1 Play should map to pressed play/pause");
    require(deck2.has_value() && deck2->control == PioneerDeckControl::playPause &&
                deck2->deck == 2,
            "deck 2 Play should map on MIDI channel 2");
    require(sync.has_value() && sync->control == PioneerDeckControl::syncModifier &&
                sync->deck == 2 && sync->value == 1.0,
            "Sync should map as a held per-deck jog modifier");
}

void testPioneerMappingMapsDeckSelection()
{
    PioneerDeckMapper mapper{"DDJ-RB"};
    const auto deckOneCue = mapper.mapMessage(0x90, 0x0c, 0x7f);
    require(deckOneCue.has_value() &&
                deckOneCue->control == PioneerDeckControl::previousMarker &&
                deckOneCue->deck == 1,
            "deck 1 playback Cue should navigate to the previous marker");

    mapper.mapMessage(0x90, 0x3f, 0x7f);
    const auto shifted = mapper.mapMessage(0x90, 0x0c, 0x7f);
    require(shifted.has_value() && shifted->control == PioneerDeckControl::nextMarker,
            "Shift plus playback Cue should navigate to the next marker");

    const auto dedicatedShiftCue = mapper.mapMessage(0x91, 0x48, 0x7f);
    require(dedicatedShiftCue.has_value() &&
                dedicatedShiftCue->control == PioneerDeckControl::nextMarker &&
                dedicatedShiftCue->deck == 2,
            "hardware shifted playback Cue note should navigate forward");

    const auto headphoneCue = mapper.mapMessage(0x91, 0x54, 0x7f);
    require(headphoneCue.has_value() &&
                headphoneCue->control == PioneerDeckControl::deckToggle &&
                headphoneCue->deck == 2,
            "mixer headphone Cue should toggle deck 2");

    PioneerDeckActivationState activation;
    const PioneerDeckControlEvent deckOnePlay{
        PioneerDeckControl::playPause, PioneerDeckControlKind::button, 1, 1.0};
    const PioneerDeckControlEvent deckTwoPlay{
        PioneerDeckControl::playPause, PioneerDeckControlKind::button, 2, 1.0};
    const PioneerDeckControlEvent browse{
        PioneerDeckControl::browseTracks, PioneerDeckControlKind::relative, 0, 1.0};
    require(activation.allows(deckOnePlay) && activation.allows(deckTwoPlay) &&
                activation.allows(browse),
            "both decks and shared controls should start enabled");
    activation.toggle(1);
    require(!activation.allows(deckOnePlay) && activation.allows(deckTwoPlay) &&
                activation.allows(browse),
            "disabling deck 1 should leave deck 2 and shared controls enabled");
    activation.toggle(2);
    require(!activation.allows(deckOnePlay) && !activation.allows(deckTwoPlay) &&
                !activation.allows(browse),
            "disabling both decks should disable shared controls");
    activation.toggle(1);
    require(activation.allows(deckOnePlay) && !activation.allows(deckTwoPlay) &&
                activation.allows(browse),
            "either active deck should re-enable shared controls");
    activation.setEnabled(1, false);
    activation.setEnabled(2, true);
    require(!activation.isEnabled(1) && activation.isEnabled(2),
            "persisted deck activation should restore each deck independently");

}

void testPioneerMappingMapsJogMovement()
{
    PioneerDeckMapper mapper{"DDJ-RB"};
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
    PioneerDeckMapper mapper{"DDJ-RB"};
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
    PioneerDeckMapper mapper{"DDJ-RB"};
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

void testPioneerMappingMapsBrowseAndPads()
{
    PioneerDeckMapper mapper{"DDJ-RB"};
    const auto browse = mapper.mapMessage(0xb6, 0x40, 0x42);
    const auto zoom = mapper.mapMessage(0xb6, 0x64, 0x3f);
    const auto browsePress = mapper.mapMessage(0x96, 0x41, 0x7f);
    const auto hotCue = mapper.mapMessage(0x97, 0x02, 0x7f);
    const auto deckTwoHotCue = mapper.mapMessage(0x98, 0x40, 0x7f);
    const auto deckTwoDeleteCue = mapper.mapMessage(0x98, 0x4f, 0x7f);

    require(browse.has_value() && browse->control == PioneerDeckControl::browseTracks &&
                browse->kind == PioneerDeckControlKind::relative && browse->value == -2.0,
            "Browse should normalize clockwise movement toward lower tracks");
    require(zoom.has_value() && zoom->control == PioneerDeckControl::timelineZoom &&
                zoom->value == -1.0,
            "Shift+Browse should decode centred relative zoom");
    require(browsePress.has_value() &&
                browsePress->control == PioneerDeckControl::browsePress &&
                browsePress->deck == 0 && browsePress->value == 1.0,
            "Browse press should map as a shared button");
    require(hotCue.has_value() && hotCue->control == PioneerDeckControl::markerJump &&
                hotCue->deck == 1 && hotCue->pad == 3,
            "Hot Cue pad should map to its one-based marker slot");
    require(deckTwoHotCue.has_value() &&
                deckTwoHotCue->control == PioneerDeckControl::markerJump &&
                deckTwoHotCue->deck == 2 && deckTwoHotCue->pad == 1,
            "deck 2 Hot Cue notes should mirror deck 1 marker slots");
    require(deckTwoDeleteCue.has_value() &&
                deckTwoDeleteCue->control == PioneerDeckControl::markerToggle &&
                deckTwoDeleteCue->deck == 2 && deckTwoDeleteCue->pad == 8,
            "shifted deck 2 Hot Cue notes should toggle the mirrored marker slot");
}

void testPioneerMappingMapsHighResolutionMixerControls()
{
    PioneerDeckMapper mapper{"DDJ-RB"};
    mapper.mapMessage(0xb0, 0x04, 0x7f);
    require(!mapper.mapMessage(0xb0, 0x24, 0x7f).has_value(),
            "Trim should remain unmapped after switching to the channel fader");
    require(!mapper.mapMessage(0xb0, 0x33, 0x7f).has_value(),
            "orphan channel-fader LSB should be ignored");
    mapper.mapMessage(0xb0, 0x13, 0x40);
    const auto channelFader = mapper.mapMessage(0xb0, 0x33, 0x00);
    mapper.mapMessage(0xb1, 0x0f, 0x7f);
    const auto bass = mapper.mapMessage(0xb1, 0x2f, 0x7f);
    mapper.mapMessage(0xb6, 0x18, 0x00);
    const auto filter = mapper.mapMessage(0xb6, 0x38, 0x00);
    mapper.mapMessage(0xb6, 0x08, 0x7f);
    const auto master = mapper.mapMessage(0xb6, 0x28, 0x7f);

    require(channelFader.has_value() &&
                channelFader->control == PioneerDeckControl::trackGain &&
                channelFader->deck == 1 && channelFader->value > 0.49 &&
                channelFader->value < 0.51,
            "channel fader should publish a normalized complete 14-bit pair");
    require(bass.has_value() && bass->control == PioneerDeckControl::toneBass &&
                bass->deck == 2 && bass->value == 1.0,
            "deck 2 Bass should publish its complete 14-bit pair");
    require(filter.has_value() && filter->control == PioneerDeckControl::filter &&
                filter->deck == 2 && filter->value == 0.0,
            "channel 2 Filter should map to deck 2");
    require(master.has_value() && master->control == PioneerDeckControl::masterVolume &&
                master->deck == 0 && master->value == 1.0,
            "DDJ-RB master volume should publish as a global control");
}

void testPioneerMappingBuildsSelectedTrackMeters()
{
    require(supportsPioneerChannelMeterOutput("DDJ-RB"),
            "DDJ-RB should support channel meter output");
    require(!supportsPioneerChannelMeterOutput("DDJ-WeGO4"),
            "unverified compact meter output should stay disabled");

    const auto silent = pioneerSelectedTrackMeterMessages(0.0F, 0.0F);
    require(silent[0].statusByte == 0xB0 && silent[1].statusByte == 0xB1 &&
                silent[0].data1 == 0x02 && silent[1].data1 == 0x02 &&
                silent[0].data2 == 0 && silent[1].data2 == 0,
            "silence should clear both mirrored channel meters");

    const auto signal = pioneerSelectedTrackMeterMessages(0.5F, 0.25F);
    require(signal[0].data2 > 0 && signal[0].data2 == signal[1].data2,
            "selected track peak should drive both channel meters");
}

void testPioneerMappingBuildsTransportPlayLights()
{
    const auto playing = pioneerTransportPlayMessages(true);
    require(playing[0].statusByte == 0x90 && playing[1].statusByte == 0x91 &&
                playing[0].data1 == 0x0B && playing[1].data1 == 0x0B &&
                playing[0].data2 == 0x7F && playing[1].data2 == 0x7F,
            "playing should light both deck Play buttons");

    const auto paused = pioneerTransportPlayMessages(false);
    require(paused[0].data2 == 0 && paused[1].data2 == 0,
            "paused transport should clear both deck Play buttons");
}

void testPioneerMappingBuildsMarkerLights()
{
    const auto cue = pioneerCueLightMessages(true);
    require(cue[0].statusByte == 0x90 && cue[1].statusByte == 0x91 &&
                cue[0].data1 == 0x0C && cue[1].data1 == 0x0C &&
                cue[0].data2 == 0x7F && cue[1].data2 == 0x7F,
            "playhead on a marker should light both playback Cue buttons");

    const auto deckSelection = pioneerDeckSelectionLightMessages(true, false);
    require(deckSelection[0].data1 == 0x54 && deckSelection[1].data1 == 0x54 &&
                deckSelection[0].data2 == 0x7F && deckSelection[1].data2 == 0,
            "headphone Cue lights should independently show active decks");

    const auto hotCues = pioneerHotCueLightMessages(3);
    require(hotCues[0].statusByte == 0x97 && hotCues[8].statusByte == 0x98 &&
                hotCues[0].data2 == 0x7F && hotCues[2].data2 == 0x7F &&
                hotCues[3].data2 == 0 && hotCues[10].data2 == 0x7F &&
                hotCues[11].data2 == 0,
            "first marker slots should light on both decks");
}

void testPioneerMappingAvoidsCompactLegacyMasterCollision()
{
    PioneerDeckMapper mapper{"DDJ-WeGO4"};
    mapper.mapMessage(0xb6, 0x08, 0x40);
    require(!mapper.mapMessage(0xb6, 0x28, 0x00).has_value(),
            "compact legacy deck 2 EQ must not be interpreted as master volume");
}
} // namespace

void addPioneerDeckMappingTests(std::vector<TestCase>& tests)
{
    tests.push_back({"Pioneer mapping matches supported models", testPioneerMappingMatchesSupportedModels});
    tests.push_back({"Pioneer mapping maps deck transport", testPioneerMappingMapsDeckTransport});
    tests.push_back({"Pioneer mapping maps SX3 Sync note", testPioneerMappingMapsSx3SyncNote});
    tests.push_back({"Pioneer mapping maps deck selection", testPioneerMappingMapsDeckSelection});
    tests.push_back({"Pioneer mapping maps jog movement", testPioneerMappingMapsJogMovement});
    tests.push_back({"Pioneer mapping maps jog touch", testPioneerMappingMapsJogTouch});
    tests.push_back(
        {"Pioneer mapping maps high-resolution crossfader", testPioneerMappingMapsHighResolutionCrossfader});
    tests.push_back(
        {"Pioneer mapping maps Browse and pads", testPioneerMappingMapsBrowseAndPads});
    tests.push_back({"Pioneer mapping maps high-resolution mixer controls",
                     testPioneerMappingMapsHighResolutionMixerControls});
    tests.push_back({"Pioneer mapping builds selected track meters",
                     testPioneerMappingBuildsSelectedTrackMeters});
    tests.push_back({"Pioneer mapping builds transport Play lights",
                     testPioneerMappingBuildsTransportPlayLights});
    tests.push_back({"Pioneer mapping builds marker lights",
                     testPioneerMappingBuildsMarkerLights});
    tests.push_back({"Pioneer mapping avoids compact legacy master collision",
                     testPioneerMappingAvoidsCompactLegacyMasterCollision});
}

} // namespace silverdaw::tests

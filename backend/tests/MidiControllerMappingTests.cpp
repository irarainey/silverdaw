#include "TestRegistry.h"

#include "midi/MidiControllerMapping.h"

#include <array>

namespace silverdaw::tests
{
namespace
{
void testMidiProfilesCoverInstalledDecks()
{
    constexpr std::array models{
        "DDJ-1000", "DDJ-200", "DDJ-400", "DDJ-800", "DDJ-ERGO", "DDJ-FLX10",
        "DDJ-FLX4", "DDJ-FLX6", "DDJ-RB", "DDJ-REV5", "DDJ-REV7", "DDJ-RR",
        "DDJ-RX", "DDJ-RZ", "DDJ-RZX", "DDJ-SB", "DDJ-SB2", "DDJ-SB3", "DDJ-SR",
        "DDJ-SR2", "DDJ-SX", "DDJ-SX2", "DDJ-SX3", "DDJ-SZ", "DDJ-WeGO",
        "DDJ-WeGO2", "DDJ-WeGO3", "DDJ-WeGO4",
        "OMNIS-DUO", "OPUS-QUAD", "XDJ-AERO", "XDJ-R1", "XDJ-RR", "XDJ-RX",
        "XDJ-RX2", "XDJ-RX3", "XDJ-XZ",
        "DJCONTROL INPULSE 200", "DJCONTROL INPULSE 300",
        "DJCONTROL INPULSE 500", "DJCONTROL STARLIGHT", "DJCONTROL MIX",
        "DJ2GO2 TOUCH", "MIXTRACK 3", "MIXTRACK PRO 3", "MC7000",
        "BEATMIX 2 MK2", "BEATMIX 4 MK2"};
    for (const auto* model : models)
        require(supportsMidiControllerMapping(model),
                "each installed deck should resolve to a JSON controller profile");
    require(midiControllerManufacturerName("2- DDJ-FLX4") == juce::String("Pioneer"),
            "manufacturer should come from the matched profile despite a Windows prefix");
    require(midiControllerManufacturerName("DJCONTROL INPULSE 500") ==
                juce::String("Hercules"),
            "manufacturer should reflect the matched profile family");
    require(!midiControllerManufacturerName("MPK mini").has_value(),
            "unmapped devices should not report a manufacturer");
}

void testMidiProfilesRejectUnmappedDevices()
{
    require(!supportsMidiControllerMapping("MPK mini"),
            "unrelated MIDI devices should remain unsupported");
    require(!supportsMidiControllerMapping("DJM-900NXS2"),
            "mixer-only devices should not resolve to a deck profile");
    require(!supportsMidiControllerMapping("DDJ-XP2"),
            "performance-pad accessories should not resolve to a deck profile");
    require(!supportsMidiControllerMapping("DJCONTROL INPULSE 200 MK2") &&
                !supportsMidiControllerMapping("DJCONTROL INPULSE 300 MK2"),
            "unverified Hercules variants should not inherit a family profile");
    require(!supportsMidiControllerMapping("KORG KAOSS DJ") &&
                !supportsMidiControllerMapping("TRAKTOR KONTROL S4") &&
                !supportsMidiControllerMapping("ROLAND DJ-505"),
            "controllers requiring SysEx, HID, or keep-alives should remain unsupported");
}

void testMidiProfilesUseModelSpecificCodes()
{
    MidiControllerMapper compact{"DDJ-400"};
    const auto compactSearch = compact.mapMessage(0xb0, 0x29, 0x41);
    require(compactSearch.has_value() &&
                compactSearch->action == MidiControllerAction::jogSearch,
            "DDJ-400 should use its JSON-defined jog-search controller");

    MidiControllerMapper sx3{"DDJ-SX3"};
    require(sx3.mapMessage(0x90, 0x5d, 0x7f).has_value(),
            "DDJ-SX3 should use its JSON-defined Sync note");
    require(!sx3.mapMessage(0x90, 0x58, 0x7f).has_value(),
            "DDJ-SX3 should not inherit another model's Sync note");
}

void testMidiMappingMapsDeckTransport()
{
    MidiControllerMapper mapper{"DDJ-RB"};
    const auto deck1 = mapper.mapMessage(0x90, 0x0b, 0x7f);
    const auto deck2 = mapper.mapMessage(0x91, 0x0b, 0x7f);
    require(deck1.has_value() && deck1->action == MidiControllerAction::playPause &&
                deck1->deck == 1 && deck1->value == 1.0,
            "deck 1 Play should map to pressed play/pause");
    require(deck2.has_value() && deck2->action == MidiControllerAction::playPause &&
                deck2->deck == 2,
            "deck 2 Play should map from its configured MIDI channel");

    const auto touch = mapper.mapMessage(0x91, 54, 127);
    const auto release = mapper.mapMessage(0x91, 54, 0);
    require(touch.has_value() && touch->action == MidiControllerAction::jogTouch &&
                touch->deck == 2 && touch->value == 1.0,
            "deck 2 jog touch should map Note 54 press");
    require(release.has_value() && release->action == MidiControllerAction::jogTouch &&
                release->deck == 2 && release->value == 0.0,
            "deck 2 jog touch should map Note 54 release");
}

void testMidiMappingMapsShiftedCue()
{
    MidiControllerMapper mapper{"DDJ-RB"};
    mapper.mapMessage(0x90, 0x3f, 0x7f);
    const auto shifted = mapper.mapMessage(0x90, 0x0c, 0x7f);
    require(shifted.has_value() && shifted->action == MidiControllerAction::nextMarker,
            "a profile's shifted Cue action should navigate to the next marker");
    mapper.mapMessage(0x90, 0x3f, 0);
    const auto unshifted = mapper.mapMessage(0x90, 0x0c, 0x7f);
    require(unshifted.has_value() &&
                unshifted->action == MidiControllerAction::previousMarker,
            "releasing Shift should restore the unshifted Cue action");
}

void testMidiMappingMapsRelativeControls()
{
    MidiControllerMapper mapper{"DDJ-RB"};
    const auto clockwise = mapper.mapMessage(0xb0, 0x22, 0x43);
    const auto counterClockwise = mapper.mapMessage(0xb1, 0x22, 0x3e);
    require(clockwise.has_value() && clockwise->action == MidiControllerAction::jogScratch &&
                clockwise->value == 3.0,
            "clockwise jog movement should retain its relative delta");
    require(counterClockwise.has_value() && counterClockwise->deck == 2 &&
                counterClockwise->value == -2.0,
            "counter-clockwise deck 2 movement should decode its relative delta");
}

void testMidiMappingMapsHighResolutionControls()
{
    MidiControllerMapper mapper{"DDJ-RB"};
    require(!mapper.mapMessage(0xb6, 0x3f, 0x7f).has_value(),
            "an orphan configured LSB should be ignored");
    mapper.mapMessage(0xb6, 0x1f, 0x40);
    const auto crossfader = mapper.mapMessage(0xb6, 0x3f, 0);
    require(crossfader.has_value() &&
                crossfader->action == MidiControllerAction::crossfader &&
                crossfader->kind == MidiControllerValueKind::absolute &&
                crossfader->value > 0.49 && crossfader->value < 0.51,
            "a complete configured 14-bit pair should normalize near its midpoint");
}

void testMidiMappingMapsBrowseAndPads()
{
    MidiControllerMapper mapper{"DDJ-400"};
    const auto browse = mapper.mapMessage(0xb6, 0x40, 0x42);
    const auto press = mapper.mapMessage(0x96, 0x41, 0x7f);
    const auto pad = mapper.mapMessage(0x97, 0x02, 0x7f);
    require(browse.has_value() && browse->action == MidiControllerAction::browseTracks &&
                browse->value == -2.0,
            "Browse direction should come from its JSON binding");
    require(press.has_value() && press->action == MidiControllerAction::browsePress,
            "Browse press should map from its JSON binding");
    require(pad.has_value() && pad->action == MidiControllerAction::markerJump &&
                pad->deck == 1 && pad->pad == 3,
            "a configured pad range should map to one-based marker slots");

    mapper.mapMessage(0x90, 0x3f, 0x7f);
    const auto zoomIn = mapper.mapMessage(0xb6, 0x40, 0x3e);
    const auto zoomOut = mapper.mapMessage(0xb6, 0x40, 0x42);
    require(zoomIn.has_value() && zoomIn->action == MidiControllerAction::timelineZoom &&
                zoomIn->value == 2.0,
            "Shift plus clockwise Browse should map to timeline zoom in");
    require(zoomOut.has_value() && zoomOut->action == MidiControllerAction::timelineZoom &&
                zoomOut->value == -2.0,
            "Shift plus anticlockwise Browse should map to timeline zoom out");

    mapper.mapMessage(0x80, 0x3f, 0);
    const auto browseAfterShift = mapper.mapMessage(0xb6, 0x40, 0x3e);
    require(browseAfterShift.has_value() &&
                browseAfterShift->action == MidiControllerAction::browseTracks,
            "Browse should return to track selection when Shift is released");

    MidiControllerMapper ddjRb{"2 - DDJ-RB"};
    ddjRb.mapMessage(0x90, 63, 127);
    const auto ddjRbZoomIn = ddjRb.mapMessage(0xb6, 100, 1);
    const auto ddjRbZoomOut = ddjRb.mapMessage(0xb6, 100, 127);
    ddjRb.mapMessage(0x90, 63, 0);
    require(ddjRbZoomIn.has_value() &&
                ddjRbZoomIn->action == MidiControllerAction::timelineZoom &&
                ddjRbZoomIn->value == 1.0,
            "DDJ-RB Shift plus clockwise Browse should map CC 100 value 1 to zoom in");
    require(ddjRbZoomOut.has_value() &&
                ddjRbZoomOut->action == MidiControllerAction::timelineZoom &&
                ddjRbZoomOut->value == -1.0,
            "DDJ-RB Shift plus anticlockwise Browse should map CC 100 value 127 to zoom out");
}

void testMidiMappingMapsSevenBitMixerControls()
{
    MidiControllerMapper mapper{"OMNIS-DUO"};
    const auto untouchedJog = mapper.mapMessage(0xb0, 0x22, 0x41);
    mapper.mapMessage(0x90, 0x20, 0x7f);
    const auto touchedJog = mapper.mapMessage(0xb0, 0x22, 0x41);
    const auto fader = mapper.mapMessage(0xb4, 0x11, 0x40);
    const auto cue = mapper.mapMessage(0xb4, 0x46, 0x7f);
    require(untouchedJog.has_value() &&
                untouchedJog->action == MidiControllerAction::jogPitchBend &&
                touchedJog.has_value() &&
                touchedJog->action == MidiControllerAction::jogScratch,
            "shared jog codes should select their touch-dependent action");
    require(fader.has_value() && fader->action == MidiControllerAction::trackGain &&
                fader->deck == 1 && fader->kind == MidiControllerValueKind::absolute,
            "standalone seven-bit faders should map through JSON");
    require(cue.has_value() && cue->action == MidiControllerAction::deckToggle &&
                cue->deck == 1 && cue->value == 1.0,
            "CC-based headphone Cue buttons should map as buttons");
}

void testMidiMappingMapsAbsoluteJog()
{
    MidiControllerMapper mapper{"DDJ-REV7"};
    mapper.mapMessage(0xb0, 0x19, 0x20);
    require(!mapper.mapMessage(0xb0, 0x39, 0).has_value(),
            "the first absolute platter position should establish an anchor");
    mapper.mapMessage(0xb0, 0x19, 0x20);
    const auto moved = mapper.mapMessage(0xb0, 0x39, 4);
    require(moved.has_value() && moved->action == MidiControllerAction::jogScratch &&
                moved->kind == MidiControllerValueKind::relative && moved->value == 4.0,
            "successive absolute platter positions should publish relative movement");
}

void testMidiMappingMapsHerculesControls()
{
    require(supportsMidiControllerMapping("Hercules DJControl Inpulse 300"),
            "the Hercules device name should resolve to its JSON profile");
    MidiControllerMapper mapper{"Hercules DJControl Inpulse 300"};

    const auto play = mapper.mapMessage(0x91, 0x07, 0x7f);
    const auto shiftedCue = mapper.mapMessage(0x94, 0x06, 0x7f);
    const auto deckToggle = mapper.mapMessage(0x92, 0x0c, 0x7f);
    const auto browseDown = mapper.mapMessage(0xb0, 0x01, 0x01);
    const auto browseUp = mapper.mapMessage(0xb0, 0x01, 0x7f);
    const auto jogBackward = mapper.mapMessage(0xb1, 0x0a, 0x7f);
    const auto deckTwoFader = mapper.mapMessage(0xb2, 0x00, 0x40);
    const auto hotCue = mapper.mapMessage(0x96, 0x02, 0x7f);

    require(play.has_value() && play->action == MidiControllerAction::playPause &&
                play->deck == 1,
            "Hercules Play should map from deck A's MIDI channel");
    require(shiftedCue.has_value() &&
                shiftedCue->action == MidiControllerAction::nextMarker &&
                shiftedCue->deck == 1,
            "Hercules Shift+Cue should use its dedicated shifted channel");
    require(deckToggle.has_value() &&
                deckToggle->action == MidiControllerAction::deckToggle &&
                deckToggle->deck == 2,
            "Hercules PFL should toggle deck 2");
    require(browseDown.has_value() && browseDown->value == -1.0 &&
                browseUp.has_value() && browseUp->value == 1.0,
            "Hercules Browse should decode two's-complement direction");
    require(jogBackward.has_value() &&
                jogBackward->action == MidiControllerAction::jogScratch &&
                jogBackward->value == -1.0,
            "Hercules jog movement should decode two's-complement values");
    require(deckTwoFader.has_value() &&
                deckTwoFader->action == MidiControllerAction::trackGain &&
                deckTwoFader->deck == 2 &&
                deckTwoFader->kind == MidiControllerValueKind::absolute,
            "Hercules channel faders should map as seven-bit absolute controls");
    require(hotCue.has_value() && hotCue->action == MidiControllerAction::markerJump &&
                hotCue->deck == 1 && hotCue->pad == 3,
            "Hercules hot-cue pads should map to marker slots");

    const auto playLights = mapper.transportPlayMessages(true);
    const auto hotCueLights = mapper.hotCueLightMessages(1);
    require(playLights[0].statusByte == 0x91 && playLights[1].statusByte == 0x92 &&
                playLights[0].data1 == 0x07,
            "Hercules Play output should use deck channels 2 and 3");
    require(hotCueLights[0].statusByte == 0x96 &&
                hotCueLights[8].statusByte == 0x97 &&
                hotCueLights[0].data2 == 0x7e && hotCueLights[1].data2 == 0,
            "Hercules pad lights should use their configured active value");
}

void testMidiMappingMapsAdditionalControllers()
{
    MidiControllerMapper inpulse500{"Hercules DJControl Inpulse 500"};
    require(!inpulse500.mapMessage(0xb1, 0x00, 0x40).has_value(),
            "Hercules 14-bit faders should wait for their precision byte");
    const auto inpulseFader = inpulse500.mapMessage(0xb1, 0x20, 0);
    require(inpulseFader.has_value() &&
                inpulseFader->action == MidiControllerAction::trackGain &&
                inpulseFader->value > 0.49 && inpulseFader->value < 0.51,
            "Hercules Inpulse 500 should decode its 14-bit channel fader");

    MidiControllerMapper mixtrack{"Numark Mixtrack Pro 3"};
    mixtrack.mapMessage(0x91, 0x0b, 0x7f);
    const auto shiftedPad = mixtrack.mapMessage(0x91, 0x1c, 0x7f);
    require(shiftedPad.has_value() &&
                shiftedPad->action == MidiControllerAction::markerToggle &&
                shiftedPad->deck == 1 && shiftedPad->pad == 2,
            "Numark shifted pads should clear markers through profile state");

    MidiControllerMapper dj2go{"Numark DJ2GO2 Touch"};
    const auto clearPad = dj2go.mapMessage(0x94, 0x0a, 0x7f);
    require(clearPad.has_value() &&
                clearPad->action == MidiControllerAction::markerToggle &&
                clearPad->deck == 1 && clearPad->pad == 2,
            "Numark DJ2GO2 Touch should map its dedicated clear-pad bank");

    MidiControllerMapper denon{"Denon DJ MC7000"};
    const auto denonJog = denon.mapMessage(0xb1, 0x06, 0x7f);
    require(denonJog.has_value() &&
                denonJog->action == MidiControllerAction::jogPitchBend &&
                denonJog->deck == 2 && denonJog->value == -1.0,
            "Denon MC7000 should decode deck 2 jog movement");

    MidiControllerMapper reloop{"Reloop Beatmix 4 MK2"};
    const auto reloopJog = reloop.mapMessage(0xb1, 0x60, 0x41);
    require(reloopJog.has_value() &&
                reloopJog->action == MidiControllerAction::jogPitchBend &&
                reloopJog->value == 1.0,
            "Reloop Beatmix should decode centre-relative jog movement");

    MidiControllerMapper inpulse200{"Hercules DJControl Inpulse 200"};
    const auto fourPadLights = inpulse200.hotCueLightMessages(8);
    require(fourPadLights[3].statusByte == 0x96 &&
                fourPadLights[4].statusByte == 0 &&
                fourPadLights[11].statusByte == 0x97 &&
                fourPadLights[12].statusByte == 0,
            "four-pad profiles should not emit output for nonexistent pads");
}

void testMidiMappingBuildsConfiguredOutputs()
{
    MidiControllerMapper ddj{"DDJ-RB"};
    const auto playing = ddj.transportPlayMessages(true);
    const auto meters = ddj.selectedTrackMeterMessages(0.5F, 0.25F);
    require(playing[0].statusByte == 0x90 && playing[1].statusByte == 0x91 &&
                playing[0].data1 == 0x0b && playing[0].data2 == 0x7f,
            "Play lights should use profile output bindings");
    require(meters[0].statusByte == 0xb0 && meters[1].statusByte == 0xb1 &&
                meters[0].data1 == 0x02 && meters[0].data2 > 0,
            "meter output should use profile output bindings");
}

void testMidiMappingBuildsNonContiguousPadOutputs()
{
    MidiControllerMapper mapper{"OPUS-QUAD"};
    const auto hotCues = mapper.hotCueLightMessages(3);
    require(hotCues[0].data1 == 8 && hotCues[1].data1 == 11 &&
                hotCues[2].data1 == 13 && hotCues[3].data1 == 15,
            "non-contiguous pad output notes should come from JSON");
    require(hotCues[2].data2 == 0x7f && hotCues[3].data2 == 0,
            "marker count should still control configured pad lights");
}

void testMidiDeckActivation()
{
    MidiDeckActivationState activation;
    const MidiControllerEvent deckOne{
        MidiControllerAction::playPause, MidiControllerValueKind::button, 1, 1.0};
    const MidiControllerEvent shared{
        MidiControllerAction::browseTracks, MidiControllerValueKind::relative, 0, 1.0};
    require(activation.allows(deckOne) && activation.allows(shared),
            "deck and shared actions should start enabled");
    activation.toggle(1);
    activation.toggle(2);
    require(!activation.allows(deckOne) && !activation.allows(shared),
            "disabling both decks should disable deck and shared actions");
    const MidiControllerEvent toggle{
        MidiControllerAction::deckToggle, MidiControllerValueKind::button, 1, 1.0};
    require(activation.allows(toggle), "deck toggles should remain available");

    activation.selectExclusive(2);
    require(!activation.isEnabled(1) && activation.isEnabled(2),
            "exclusive selection should enable only the selected deck");
}

void testMidiProfileInitMessages()
{
    MidiControllerMapper ddjRb{"DDJ-RB"};
    const auto& init = ddjRb.initMessages();
    require(init.size() == 3,
            "DDJ-RB should expose its three JSON-defined init frames");
    require(init[0] == std::vector<juce::uint8>{0xF0, 0x00, 0x20, 0x7F, 0x03, 0x01, 0xF7},
            "DDJ-RB init frame 0 should be the SB3-family software-connected handshake");
    require(init[1] == std::vector<juce::uint8>{0xF0, 0x00, 0x40, 0x05, 0x00, 0x00, 0x02, 0x06, 0x00, 0x03, 0x01, 0xF7},
            "DDJ-RB init frame 1 should be the rekordbox position-request SysEx");
    require(init[2] == std::vector<juce::uint8>{0x9B, 0x09, 0x7F},
            "DDJ-RB init frame 2 should be the Mixxx short position-request/wake message");

    MidiControllerMapper unmapped{"MPK mini"};
    require(unmapped.initMessages().empty(),
            "an unmapped device should expose no init frames");
}
} // namespace

void addMidiControllerMappingTests(std::vector<TestCase>& tests)
{
    tests.push_back({"MIDI profiles cover installed decks", testMidiProfilesCoverInstalledDecks});
    tests.push_back({"MIDI profiles reject unmapped devices", testMidiProfilesRejectUnmappedDevices});
    tests.push_back({"MIDI profiles use model-specific codes", testMidiProfilesUseModelSpecificCodes});
    tests.push_back({"MIDI mapping maps deck transport", testMidiMappingMapsDeckTransport});
    tests.push_back({"MIDI mapping maps shifted Cue", testMidiMappingMapsShiftedCue});
    tests.push_back({"MIDI mapping maps relative controls", testMidiMappingMapsRelativeControls});
    tests.push_back({"MIDI mapping maps high-resolution controls",
                     testMidiMappingMapsHighResolutionControls});
    tests.push_back({"MIDI mapping maps Browse and pads", testMidiMappingMapsBrowseAndPads});
    tests.push_back({"MIDI mapping maps seven-bit mixer controls",
                     testMidiMappingMapsSevenBitMixerControls});
    tests.push_back({"MIDI mapping maps absolute jog", testMidiMappingMapsAbsoluteJog});
    tests.push_back({"MIDI mapping maps Hercules controls",
                     testMidiMappingMapsHerculesControls});
    tests.push_back({"MIDI mapping maps additional controllers",
                     testMidiMappingMapsAdditionalControllers});
    tests.push_back({"MIDI mapping builds configured outputs",
                     testMidiMappingBuildsConfiguredOutputs});
    tests.push_back({"MIDI mapping builds non-contiguous pad outputs",
                     testMidiMappingBuildsNonContiguousPadOutputs});
    tests.push_back({"MIDI mapping applies deck activation", testMidiDeckActivation});
    tests.push_back({"MIDI profile exposes init frames", testMidiProfileInitMessages});
}

} // namespace silverdaw::tests

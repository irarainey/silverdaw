## MIDI controller profiles

Each JSON file maps one or more device-name substrings to Silverdaw actions.
The backend validates every profile when MIDI support is first used. Invalid
profiles and duplicate model names are logged and ignored.

`models` contains case-insensitive device-name fragments. The longest matching
model wins. Use `excludedModels` to stop an unverified variant from matching a
shorter family name.

Optional `sources` records the trusted mapping material used to derive a
profile. It is provenance metadata rather than a runtime field.

An input binding contains:

- `action`: a name from `MidiControllerAction`.
- `encoding`: `button`, `relative`, `relativeTwosComplement`, `absolute7`,
  `absolute14`, `absolute14Relative`, or `padRange`.
- `message`: `note` or `cc`.
- `data1`: the MIDI note or controller number as a decimal integer.
- `channels` and `decks`: corresponding arrays. Deck `0` means a shared
  control; decks `1` and `2` are deck-specific.

Optional input fields configure shifted actions, 14-bit LSB controllers,
relative centres and directions, and pad ranges. Output bindings identify
meter and light messages by `purpose`; `onValue` and `offValue` override their
default MIDI values, while `count` limits controllers with fewer than eight
physical pads.

Supported input actions:

| Action | Meaning |
| --- | --- |
| `playPause` | Toggle project playback. |
| `previousMarker`, `nextMarker` | Move to the previous or next timeline marker. While a Scratch Editor session is open, `previousMarker` runs the backing Build action instead. |
| `deckToggle` | Enable or disable messages from one physical deck. |
| `shift`, `syncModifier`, `jogTouch` | Maintain modifier or touch state for other actions. |
| `jogScratch`, `jogPitchBend`, `jogSearch` | Move the timeline playhead from a jog control; search is the faster variant. |
| `wheelPitchBend`, `wheelSearch` | Move the playhead from an outer wheel or dedicated search message. |
| `browseTracks`, `browsePress` | Select tracks or clips and enter/leave clip-browse mode. |
| `timelineZoom` | Zoom the timeline, or extend the clip selection while clip-browse mode is active. |
| `markerJump`, `markerToggle` | Jump to, add, or remove numbered timeline markers. |
| `trackGain` | Change the selected track's fader. |
| `toneBass`, `toneMid`, `toneTreble`, `filter` | Change the selected track's Tone/Filter controls. |
| `masterVolume` | Change the project master volume. |
| `crossfader` | Publish crossfader telemetry; it does not currently change the audible mix. |

Supported output purposes:

| Purpose | Feedback |
| --- | --- |
| `channelMeter` | Selected-track level meter. |
| `playLight` | Project transport state. |
| `cueLight` | Cue/marker state. |
| `deckSelectionLight` | Whether each physical deck is active. |
| `hotCueLights` | Marker count across four or eight pads. |

To add a device, add a validated JSON profile in this directory and rebuild.
CMake copies the complete directory beside the backend executable, and the
installer ships that copied directory unchanged.

Use verified byte-level messages rather than inferring a profile from a similar
model. Add model matching, representative controls, output values, and malformed
profile coverage to `backend/tests/MidiControllerMappingTests.cpp`. Then update
the canonical supported-device and capability table in
[`docs/midi-controllers.md`](../../../docs/midi-controllers.md).

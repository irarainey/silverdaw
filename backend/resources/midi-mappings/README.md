# MIDI controller profiles

Each JSON profile has a `name`, one or more `models`, at least one `inputs`
binding and an `outputs` array (empty for input-only devices). The backend
validates profiles on first use and skips invalid profiles, including ones
that duplicate a model already loaded from another file.

Model names match case-insensitively. Each end of a match must be either a
device-name boundary or next to a non-alphanumeric character. The longest
match wins. Use `excludedModels` to stop an unverified variant from matching
a shorter family name.

Optional `sources` records the trusted mapping material used to derive a
profile. It is provenance metadata rather than a runtime field.

Two optional fields affect the device at runtime:

- `init`: raw MIDI frames, each an array of byte values. With a mapped output
  port open, these are sent once after the input starts. The DDJ-RB/SR2 profile
  uses both SysEx and a short message. There is no periodic keep-alive.
- `scratchTicksPerTurn`: jog ticks per physical platter revolution in the
  Scratch Editor. Omit it or set it to `0` to infer 16,384 for an
  `absolute14Relative` jog binding, otherwise 512.

An input binding contains:

- `action`: a name from `MidiControllerAction`.
- `encoding`: `button`, `relative`, `relativeTwosComplement`, `absolute7`,
  `absolute14`, `absolute14Relative`, or `padRange`.
- `message`: `note` or `cc`.
- `data1`: the MIDI note or controller number as a decimal integer.
- `channels` and `decks`: corresponding arrays. MIDI channels are zero-based
  (`0`–`15`). Deck `0` means a shared control; decks `1` and `2` are
  deck-specific.

Optional input fields configure shifted and touched actions, 14-bit LSB
controllers, relative centres and directions, and pad ranges. Output bindings
identify meter and light messages by `purpose`; `onValue` and `offValue`
override the default light values. `count` limits feedback to the number of
physical pads. `data1Values` can map different note/controller numbers per
channel or a non-contiguous set of hot-cue pad notes.

Supported input actions:

| Action | Meaning |
| --- | --- |
| `playPause` | Toggle project playback, or arm, cancel or stop a take in the Scratch Editor. |
| `previousMarker`, `nextMarker` | Move to the previous or next timeline marker. While a Scratch Editor session is open, `previousMarker` runs the backing Build action instead. |
| `deckToggle` | Enable or disable one physical deck; in the Scratch Editor, select that deck exclusively. |
| `shift`, `syncModifier`, `jogTouch` | Maintain modifier or touch state for other actions. |
| `jogScratch`, `jogPitchBend`, `jogSearch` | Move the timeline playhead from a jog control; search is the faster variant. |
| `wheelPitchBend`, `wheelSearch` | Move the playhead from an outer wheel or dedicated search message. |
| `browseTracks`, `browsePress` | Select tracks or clips and enter/leave clip-browse mode. |
| `timelineZoom` | Zoom the timeline, or extend the clip selection while clip-browse mode is active. |
| `markerJump`, `markerToggle` | Jump to the pad's numbered marker, or toggle a marker at the exact playhead position, respectively. |
| `trackGain` | Change the selected track's fader. |
| `toneBass`, `toneMid`, `toneTreble`, `filter` | Change the selected track's Tone/Filter controls. |
| `masterVolume` | Change the project master volume. |
| `crossfader` | Report the hardware position without changing the arrangement mix. In the Scratch Editor the fader changes scratch gain and its movement can be recorded. |

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

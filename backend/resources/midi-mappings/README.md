## MIDI controller profiles

Each JSON file maps one or more device-name substrings to Silverdaw actions.
The backend validates every profile when MIDI support is first used. Invalid
profiles and duplicate model names are logged and ignored.

`models` contains case-insensitive device-name fragments. The longest matching
model wins. Use `excludedModels` to stop an unverified variant from matching a
shorter family name.

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

To add a device, add a validated JSON profile in this directory and rebuild.
CMake copies the complete directory beside the backend executable, and the
installer ships that copied directory unchanged.

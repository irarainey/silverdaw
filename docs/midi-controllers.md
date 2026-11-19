# MIDI deck controllers

Silverdaw can use supported MIDI deck controllers to operate the arrangement
timeline, markers, selected-track mixer controls, and transport. Controller
support is model-specific and comes from the JSON profiles installed with the
application. You can enable multiple supported MIDI deck devices at the same
time.

> **Only supported deck MIDI controllers can be enabled.** Other MIDI devices
> are still shown in **Preferences ▸ MIDI**, but their checkboxes are disabled.
> MIDI keyboards, pad controllers, instruments, generic unmapped controllers,
> and controllers that require HID or periodic keep-alive messages are not
> supported. A profile can send one-time MIDI initialisation messages,
> including SysEx, when the device connects.

> **Hardware testing:** The Pioneer DJ DDJ-RB is the only controller tested on
> physical hardware so far. Other listed devices have profile coverage but may
> need refinement; please report any issue with the device name and MIDI Monitor
> output.

Silverdaw remains a studio creation tool. MIDI deck control edits and navigates
the arrangement, including recording editable scratch patterns into a mix; it
is not a live-performance mode and does not sequence MIDI notes or control
virtual instruments.

## Connect and enable a controller

1. Connect and power on the controller.
2. Open **Edit ▸ Preferences… ▸ MIDI**.
3. Select **Rescan MIDI inputs** if the controller is not already listed.
4. Tick the controller. A recognised device is labelled **MIDI deck controls**.
5. Select **Save** to keep the enabled device for future sessions.

All detected MIDI inputs remain visible. An unsupported input is labelled
**Not supported yet** and cannot be selected. Silverdaw also rejects an
unsupported enable request in the backend rather than opening the device.

The enabled state and each controller's deck-selection state are saved by the
device identifier reported by Windows. If a driver changes that identifier,
enable the controller again.

Each supported controller tile also has device-specific preferences:

- **Play audio while moving the main timeline** controls whether held platter
  movement produces scratch audio. It is off by default. When off, the jog wheel
  still moves the playhead silently.
- **Crossfader direction** controls which way the fader cuts the scratch in
  the Scratch Editor. Choose **Left to right** (default) or **Right to left**.
  The hardware fader does not crossfade arrangement tracks.
- **Default deck** applies at startup if there is no saved deck selection.
  Choose **Deck 1 (Left)**, **Deck 2 (Right)**, or **None** (default), which
  leaves both decks enabled.

These settings remain saved by device identifier while the controller is
disconnected and return when Windows reports the same device again.

## What the controls do

The available physical controls vary by profile. When a profile contains the
corresponding binding, Silverdaw applies these actions:

> **Note:** Not every supported controller provides every mapping or function.
> Check the supported-controller table below for the controls available on each
> device. This table describes ordinary timeline behaviour; while the
> [Scratch Editor](#scratch-editor-with-a-physical-deck) is open, Play, Cue,
> the platter, and the crossfader are repurposed for the session instead.

| Controller control | Silverdaw action |
| --- | --- |
| Play | Starts or pauses the project transport. |
| Cue | Moves to the previous timeline marker, or the timeline start if none remains. The start of an active timeline range counts as a temporary marker. |
| Shift + Cue | Moves to the next timeline marker, or the timeline end if none remains. An active range's start again counts as a marker. Some controllers send a dedicated shifted Cue message. |
| Sync | Hold while jogging to step along the selected snap grid. With the grid set to Free, each step is relative to the playhead instead. Sync does not change tempo. |
| Jog wheel or platter | Moves the playhead. While playing, touching an enabled platter holds the transport until every touched platter is released; the Play button pulses during the hold. Moving a held platter auditions forward or backward grains only if its scrub-audio preference is on. Profiles with a search binding can jog faster. |
| Browse encoder | Selects tracks. Pressing it enters clip-browse mode on the selected track; rotation then selects clips, shifted rotation extends the clip range, and another press exits clip-browse mode. |
| Shift + Browse | Where the profile maps shifted rotation or a dedicated zoom message, zooms the timeline outside clip-browse mode. Each step uses the same increment as Zoom In or Zoom Out. |
| Hot-cue pads | Jump to the corresponding numbered timeline marker. A shifted or dedicated clear pad toggles a marker at the playhead: it removes the marker the playhead is sitting on, or adds one there when it is not. This is the same action as the `M` key. Profiles expose four or eight marker pads according to the hardware. |
| Headphone Cue / PFL | Enables or disables input from that physical deck. This is useful when a controller exposes more than one deck channel. |
| Channel fader | Changes the currently selected Silverdaw track's volume. |
| EQ and filter | Changes Bass, Mid, Treble, or Filter on the currently selected track and opens Track FX. Profiles only expose controls present on that model. |
| Master level | Changes the project master volume on profiles that bind it, even with an editor or dialog open. |
| Crossfader | Reports the hardware position; outside the Scratch Editor it does not change the arrangement mix. |
| Shift and jog touch | Maintain modifier and touch state used by the other mapped actions. |

Physical deck numbers identify the source control; they are not assigned to
specific Silverdaw tracks. Channel faders, EQ, and filter controls always target
the track currently selected in the arrangement.

Silverdaw cannot read every dial and slider's position when a controller first
connects. When you first move an absolute fader, dial, or knob whose hardware
value differs from the on-screen value, it catches up gradually instead of
jumping. This soft adjustment prevents an abrupt change after selecting a track
or editing a value on screen.

## Controller feedback

Profiles can send MIDI output to a matching output port. Depending on the
controller, Silverdaw can update:

- Play and Cue lights.
- Active-deck or headphone-Cue lights.
- Hot-cue lights for the current marker count.
- Selected-track level meters.

Feedback needs a mapped output. Silverdaw first tries the first output with
the same name as the input (ignoring case); otherwise it tries a partial name
match only if there is exactly one. Input can still work without an output.

## Supported controllers and profile coverage

The source profiles are stored in
`backend/resources/midi-mappings/*.json`. Builds copy them to a
`midi-mappings` directory beside the backend executable, which is where the
installed app loads them. The model names below are matched case-insensitively.
A profile can support several models that share the same verified protocol.
Controls not listed for a profile are not mapped.

| Supported model names | Mapped input coverage | Output feedback |
| --- | --- | --- |
| Denon MC7000 | Play, Cue, Sync, Shift, deck selection, Browse/zoom, jog/touch, eight marker pads, channel fader, three-band EQ, filter, crossfader | Play, Cue, deck selection, marker pads |
| Hercules DJControl Inpulse 200 | Play, Cue/Shift+Cue, Sync, deck selection, Browse, jog/touch, four marker pads, channel fader, Bass, filter, crossfader | Play, Cue, deck selection, marker pads |
| Hercules DJControl Inpulse 300 | Play, Cue/Shift+Cue, Sync, deck selection, Browse, jog/touch, eight marker pads, channel fader, three-band EQ, filter, crossfader | Play, Cue, deck selection, marker pads |
| Hercules DJControl Inpulse 500 | Play, Cue/Shift+Cue, Sync, deck selection, Browse, jog/touch, eight marker pads, high-resolution channel fader and three-band EQ, filter, crossfader | Selected-track meter, Play, Cue, deck selection, marker pads |
| Hercules DJControl Starlight; DJControl MIX | Play, Cue/Shift+Cue, Sync, deck selection, jog/touch, four marker pads, channel fader, Bass, filter, crossfader | Play, Cue, deck selection, marker pads |
| Numark DJ2GO2 Touch | Play, Cue, Sync, deck selection, Browse, jog/touch, four marker pads, channel fader, crossfader | Play, Cue, deck selection, marker pads |
| Numark Mixtrack 3; Mixtrack Pro 3 | Play, Cue, Sync, Shift, deck selection, Browse/zoom, jog/touch, four marker pads, channel fader, three-band EQ, filter, crossfader | Play, Cue, deck selection, marker pads |
| Pioneer DJ DDJ-ERGO; DDJ-WeGO; DDJ-WeGO2; DDJ-WeGO3; DDJ-WeGO4 | Play, Cue/Shift+Cue, Sync, Shift, deck selection, Browse/zoom, jog/touch/search, crossfader | None |
| Pioneer DJ DDJ-RR; DDJ-RX; DDJ-RZ; DDJ-RZX; DDJ-SB; DDJ-SB2; DDJ-SB3; DDJ-SR; DDJ-SX; DDJ-SX2; DDJ-SZ | Play, Cue/Shift+Cue, Sync, Shift, deck selection, Browse/zoom, jog/touch/search, eight marker pads, channel fader, three-band EQ, filter, crossfader | Selected-track meter, Play, Cue, deck selection, marker pads |
| Pioneer DJ DDJ-RB; DDJ-SR2 | Same coverage as the common DDJ profile, plus master level | Selected-track meter, Play, Cue, deck selection, marker pads |
| Pioneer DJ DDJ-1000; DDJ-800; DDJ-FLX10 | Play, Cue/Shift+Cue, Sync, Shift, deck selection, Browse/zoom, jog/touch/search, eight marker pads, channel fader, three-band EQ, filter, crossfader | Selected-track meter, Play, Cue, deck selection, marker pads |
| Pioneer DJ DDJ-200 | Play, Cue/Shift+Cue, Sync, Shift, deck selection, jog/touch/search, eight marker pads, channel fader, three-band EQ, filter, crossfader | Play, Cue, deck selection, marker pads |
| Pioneer DJ DDJ-400; DDJ-FLX4; DDJ-FLX6 | Play, Cue/Shift+Cue, Sync, Shift, deck selection, Browse/zoom, jog/touch/search, eight marker pads, channel fader, three-band EQ, filter, master level, crossfader | Selected-track meter, Play, Cue, deck selection, marker pads |
| Pioneer DJ DDJ-REV5 | Play, Cue/Shift+Cue, Sync, Shift, deck selection, Browse/zoom, jog/touch/search, eight marker pads, channel fader, three-band EQ, filter, crossfader | Selected-track meter, Play, Cue, deck selection, marker pads |
| Pioneer DJ DDJ-REV7 | Play, Cue, Sync, Shift, Browse/zoom, scratch platter, eight marker pads, channel fader, crossfader | Marker pads |
| Pioneer DJ DDJ-SX3 | Play, Cue/Shift+Cue, Sync, Shift, deck selection, Browse/zoom, jog/touch/search, eight marker pads, channel fader, three-band EQ, filter, crossfader | Selected-track meter, Play, Cue, deck selection, marker pads |
| Pioneer DJ OMNIS-DUO; XDJ-RR; XDJ-RX2; XDJ-RX3; XDJ-XZ | Play, Cue/Shift+Cue, Sync, Shift, deck selection, Browse/zoom, jog/touch/search, eight marker pads, channel fader, three-band EQ, filter, crossfader | Selected-track meter, Play, Cue, deck selection, marker pads |
| Pioneer DJ XDJ-AERO; XDJ-R1 | Play, Cue/Shift+Cue, Sync, Browse/zoom, jog/touch/search, crossfader | Play, Cue |
| Pioneer DJ XDJ-RX | Play, Cue, Sync, Browse/zoom, jog/touch/search, channel fader, crossfader | Selected-track meter, Play, Cue |
| Reloop Beatmix 2 MK2; Beatmix 4 MK2; shared device name Beatmix 2/4 MK2 | Play, Cue/Shift+Cue, Sync, deck selection, Browse, jog/touch, four marker pads, channel fader, three-band EQ, crossfader | Play, Cue, deck selection, marker pads |

The Hercules DJControl Inpulse 200 MK2 and Hercules DJControl Inpulse 300 MK2
are explicitly excluded because their byte-level mappings have not been
verified. A similar name does not make an unlisted controller compatible.

## Scratch Editor without a controller (experimental)

The Scratch Editor is designed around supported physical decks, which are the
primary way to perform scratches. The on-screen virtual deck is an experimental,
less expressive fallback when no controller is connected: use a trackpad and
keyboard to create a simple scratch, then edit its notation into a more complex
pattern.

- **Platter (experimental trackpad control).** Two-finger pan across the
  on-screen platter jogs it, exactly like touching a physical platter.
  Rightward or downward movement scratches forward; leftward or upward
  scratches back. The gesture only registers while your fingers are moving —
  Windows precision touchpads report nothing while fingers rest — so the
  platter releases automatically a moment after you stop. Tap the virtual
  platter to toggle its hold. While held, move one finger around the platter or
  use a two-finger pan to scratch. Small accidental movements are ignored;
  larger movements respond more quickly.
- **Platter (mouse and keyboard).** Click and drag around the platter to
  scratch, or focus it and use the arrow keys; hold Shift for larger steps.
- **Backing transport.** Press **Space** to toggle the prepared backing bed.
  It does not control scratch replay; press **P** to play or stop a recorded
  scratch.
- **Crossfader cut (keyboard).** Press the configured key to close the
  crossfader and silence the virtual deck; press it again to open the fader.
  The resting default is open (audible). Choose **Z** (right-handed) or **M** (left-handed)
  to suit your scratching hand in **Preferences ▸ Effects ▸ Scratch crossfader
  cut** (the default is Z).
- **Scratch realism.** Choose **Off**, **Medium** (the default), or **High** in
  **Preferences ▸ Effects** to add increasing held-platter softening and
  low-level groove texture. It affects on-screen and MIDI scratching only
  while the platter is held.

These on-screen controls share the same session model as a physical deck, so
you can begin a pattern without hardware and later refine it with a controller
or in the notation editor.

## Scratch Editor with a physical deck

While the Scratch Editor is open, a supported controller's **Play** and **Cue**
buttons and its platter/crossfader are repurposed for the session; this differs from their
ordinary timeline roles described above, which only apply with the editor
closed.

- **Headphone Cue / PFL** selects one physical deck and disables the other on
  that controller. The crossfader controls scratch gain for the selected deck;
  fader moves made during recording become part of the take.
- **Play** drives scratch recording instead of transport playback, mirroring
  the on-screen Record button's three phases: idle → **armed** (press arms;
  nothing records yet), armed → **cancelled** (a second press before any touch
  discards the arm), recording → **stopped** (a press while recording
  finalizes the take). The first eligible platter touch (or movement on a
  touch-less platter) starts the armed take.
- **Cue** runs **Build**, the same action as the backing panel's Build button.
  It prepares or rebuilds the selected backing tracks, anchor, and length. With
  the editor closed, Cue keeps its ordinary previous-marker behaviour unchanged.
- **Touch is authoritative, not the ordinary jog behaviour above.** On a
  capacitive platter, the touch sensor decides ownership and release: lifting
  off returns the platter to motor speed immediately. Jog movement that
  arrives after release (a lift-off nudge) is dropped rather than applied or
  used to re-claim the platter, so releasing can never be delayed by
  after-release movement. The separately encoded **search / outer-wheel**
  controls remain ordinary timeline controls only: because they do not report
  touch, they cannot safely participate in Scratch Editor ownership and remain
  unavailable to the modal editor. A touch-less, movement-only platter instead
  infers release after a short pause in movement.

See [ADR 0021](adr/0021-scratch-editor-action-patterns.md) for the full session
and recording model.

## Diagnose a controller

Open **Preferences ▸ Developer ▸ Open MIDI Monitor…**. The monitor shows the
latest Note On, Note Off, Control Change, Pitch Bend, and other short messages
from enabled inputs, including their controller code and value. It samples
at most one message per input every 250 ms and keeps the latest 200 reports;
it is not a complete MIDI trace. Clearing it does not change the mapping.

If a listed controller is shown as unsupported:

1. Select **Rescan MIDI inputs**.
2. Confirm that Windows reports the expected model name.
3. Reconnect the controller, then rescan again.
4. Report the exact device name. If the device can be enabled but a control
   does not work, include its MIDI Monitor output too.

Model detection uses the Windows-reported input name. Matching is
case-insensitive, requires model-name boundaries, and selects the longest
matching model when names overlap.

## Adding support for another controller

Controller mappings are data-driven JSON profiles. Contributors should follow
the schema and validation guidance in
[`backend/resources/midi-mappings/README.md`](../backend/resources/midi-mappings/README.md).
Adding a profile requires verified MIDI messages, tests, and an update to the
supported-controller table above.

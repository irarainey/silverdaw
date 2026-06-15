#!/usr/bin/env python3
"""Generate metronome click-track WAV files at exact, known BPMs.

These are deterministic ground-truth fixtures for testing Silverdaw's tempo /
beat detection and beat-grid drift. Because Silverdaw uses a fixed-tempo grid
(one BPM + an anchor offset), a correctly detected BPM should stay phase-locked
from the first beat to the last on perfectly quantised material like these
clicks. Measuring the position error of the final beat is the single most
revealing drift metric.

Pure standard library (wave, array, math) - no numpy required.

Examples:
    # Default set (several BPMs, 60s, 44.1 kHz, 4/4) into debug/click-tracks
    python scripts/Generate-ClickTracks.py

    # Custom BPMs and duration
    python scripts/Generate-ClickTracks.py --bpms 120 174 --duration 120

    # No accented downbeat (uniform clicks, hides phase/bar info)
    python scripts/Generate-ClickTracks.py --no-accent
"""

from __future__ import annotations

import argparse
import array
import math
import os
import wave

DEFAULT_BPMS = [90.0, 100.0, 120.0, 123.45, 128.0, 140.0, 174.0]
DEFAULT_SAMPLE_RATE = 44100
DEFAULT_DURATION_S = 60.0
DEFAULT_BEATS_PER_BAR = 4
DEFAULT_CLICK_MS = 25.0
DEFAULT_OUTPUT_DIR = os.path.join("debug", "click-tracks")

INT16_MAX = 32767


def _make_click(sample_rate: int, click_ms: float, freq_hz: float, gain: float) -> array.array:
    """A short exponentially-decaying sine burst (one metronome tick)."""
    length = max(1, int(round(sample_rate * click_ms / 1000.0)))
    decay = 5.0 / length  # ~99% decayed by the end of the click
    samples = array.array("h", bytes(2 * length))
    for n in range(length):
        env = math.exp(-decay * n)
        value = gain * env * math.sin(2.0 * math.pi * freq_hz * n / sample_rate)
        samples[n] = int(max(-INT16_MAX, min(INT16_MAX, round(value * INT16_MAX))))
    return samples


def generate_click_track(
    bpm: float,
    sample_rate: int,
    duration_s: float,
    beats_per_bar: int,
    click_ms: float,
    accent: bool,
) -> array.array:
    """Render a mono 16-bit click track with clicks placed at exact beat times."""
    total_samples = int(round(duration_s * sample_rate))
    buffer = array.array("h", bytes(2 * total_samples))

    beat_click = _make_click(sample_rate, click_ms, 1000.0, 0.6)
    accent_click = (
        _make_click(sample_rate, click_ms, 1500.0, 0.9) if accent else beat_click
    )

    seconds_per_beat = 60.0 / bpm
    beat_index = 0
    while True:
        beat_time = beat_index * seconds_per_beat
        start = int(round(beat_time * sample_rate))
        if start >= total_samples:
            break

        is_downbeat = accent and (beat_index % beats_per_bar == 0)
        click = accent_click if is_downbeat else beat_click
        for n in range(len(click)):
            pos = start + n
            if pos >= total_samples:
                break
            mixed = buffer[pos] + click[n]
            buffer[pos] = max(-INT16_MAX, min(INT16_MAX, mixed))

        beat_index += 1

    return buffer


def write_wav(path: str, samples: array.array, sample_rate: int) -> None:
    with wave.open(path, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(samples.tobytes())


def _format_bpm(bpm: float) -> str:
    return f"{bpm:.2f}".rstrip("0").rstrip(".")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Generate exact-BPM click-track WAV fixtures for tempo/beat testing.",
    )
    parser.add_argument(
        "--bpms",
        type=float,
        nargs="+",
        default=DEFAULT_BPMS,
        help="BPM values to generate (default: a spread from 90 to 174).",
    )
    parser.add_argument(
        "--duration",
        type=float,
        default=DEFAULT_DURATION_S,
        help="Track length in seconds (default: 60).",
    )
    parser.add_argument(
        "--sample-rate",
        type=int,
        default=DEFAULT_SAMPLE_RATE,
        help="Sample rate in Hz (default: 44100).",
    )
    parser.add_argument(
        "--beats-per-bar",
        type=int,
        default=DEFAULT_BEATS_PER_BAR,
        help="Beats per bar for the accented downbeat (default: 4).",
    )
    parser.add_argument(
        "--click-ms",
        type=float,
        default=DEFAULT_CLICK_MS,
        help="Click length in milliseconds (default: 25).",
    )
    parser.add_argument(
        "--no-accent",
        action="store_true",
        help="Disable the accented downbeat (uniform clicks).",
    )
    parser.add_argument(
        "--output-dir",
        default=DEFAULT_OUTPUT_DIR,
        help=f"Output directory (default: {DEFAULT_OUTPUT_DIR}).",
    )
    args = parser.parse_args()

    os.makedirs(args.output_dir, exist_ok=True)
    accent = not args.no_accent

    print(
        f"Generating {len(args.bpms)} click track(s): "
        f"{args.duration:g}s, {args.sample_rate} Hz, "
        f"{args.beats_per_bar}/4{' with accent' if accent else ''}\n"
    )

    for bpm in args.bpms:
        if bpm <= 0:
            print(f"  skipping invalid BPM {bpm}")
            continue
        samples = generate_click_track(
            bpm=bpm,
            sample_rate=args.sample_rate,
            duration_s=args.duration,
            beats_per_bar=args.beats_per_bar,
            click_ms=args.click_ms,
            accent=accent,
        )
        name = f"click_{_format_bpm(bpm)}bpm_{args.sample_rate}hz_{args.duration:g}s.wav"
        path = os.path.join(args.output_dir, name)
        write_wav(path, samples, args.sample_rate)

        beats = int(args.duration / (60.0 / bpm)) + 1
        last_beat_s = (beats - 1) * (60.0 / bpm)
        print(
            f"  {name}  -  {beats} beats, "
            f"final beat at {last_beat_s:.3f}s (true reference for drift checks)"
        )

    print(f"\nDone. Files written to: {os.path.abspath(args.output_dir)}")


if __name__ == "__main__":
    main()

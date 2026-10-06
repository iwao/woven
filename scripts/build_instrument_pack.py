#!/usr/bin/env python3
"""Render a small, lazy-loadable Web Audio instrument pack from a SoundFont.

The source SoundFont is deliberately not part of the web app.  Each pack holds
only a sparse set of root notes; the browser selects the nearest root and uses
playbackRate for the requested pitch.  Add a new entry to ROOT_NOTES to build a
new timbre without changing application code.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

SAMPLE_RATE = 48_000
ROOT_NOTES = (52, 59, 64, 71, 76)


def variable_length(value: int) -> bytes:
    values = [value & 0x7F]
    while value > 0x7F:
        value >>= 7
        values.append((value & 0x7F) | 0x80)
    return bytes(reversed(values))


def midi_note(note: int, program: int) -> bytes:
    track = b"".join((
        b"\x00\xC0" + bytes((program,)),
        b"\x00\x90" + bytes((note, 105)),
        variable_length(960) + b"\x80" + bytes((note, 0)),
        b"\x00\xFF\x2F\x00",
    ))
    return b"MThd\x00\x00\x00\x06\x00\x00\x00\x01\x01\xE0" + b"MTrk" + len(track).to_bytes(4, "big") + track


def run(command: list[str]) -> None:
    subprocess.run(command, check=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--soundfont", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--id", default="musescore-general-hq-piano")
    parser.add_argument("--name", default="MuseScore General HQ Piano")
    parser.add_argument("--program", type=int, default=0, help="General MIDI program, zero-indexed")
    args = parser.parse_args()
    for executable in ("fluidsynth", "ffmpeg"):
        if not shutil.which(executable):
            raise SystemExit(f"{executable} is required")
    args.output.mkdir(parents=True, exist_ok=True)
    samples = []
    with tempfile.TemporaryDirectory() as temporary:
        work = Path(temporary)
        for note in ROOT_NOTES:
            midi = work / f"{note}.mid"
            wave = work / f"{note}.wav"
            output = args.output / f"{note}.ogg"
            if not output.exists():
                midi.write_bytes(midi_note(note, args.program))
                run(["fluidsynth", "-ni", "-F", str(wave), "-T", "wav", "-r", str(SAMPLE_RATE), str(args.soundfont), str(midi)])
                run(["ffmpeg", "-y", "-v", "error", "-i", str(wave), "-ac", "1", "-ar", str(SAMPLE_RATE), "-c:a", "libopus", "-b:a", "64k", str(output)])
            samples.append({"note": note, "file": output.name})
    (args.output / "manifest.json").write_text(json.dumps({
        "id": args.id,
        "name": args.name,
        "format": "ogg/opus",
        "sample_rate": SAMPLE_RATE,
        "samples": samples,
    }, indent=2) + "\n")


if __name__ == "__main__":
    main()

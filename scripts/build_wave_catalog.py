#!/usr/bin/env python3
"""Create the browser-readable catalog for the selectable weave-clack sounds."""

from __future__ import annotations

import json
from pathlib import Path


def label(path: Path) -> str:
    parts = path.stem.split("__")
    creator = parts[1].replace("-", " ").title() if len(parts) > 1 else "Sample"
    title = parts[-1].replace("-", " ").title()
    return f"{creator} — {title}"


def main() -> None:
    folder = Path(__file__).parents[1] / "public" / "audio" / "wave"
    entries = [
        {"id": item.name, "name": label(item), "file": f"/public/audio/wave/{item.name}"}
        for item in sorted(folder.iterdir())
        if item.suffix.lower() in {".wav", ".ogg", ".mp3", ".m4a"}
    ]
    (folder / "manifest.json").write_text(json.dumps({"sounds": entries}, indent=2) + "\n")


if __name__ == "__main__":
    main()

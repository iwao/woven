#!/usr/bin/env python3
"""Build the small Cloudflare Assets bundle, excluding R2 runtime data."""
from __future__ import annotations

import argparse
import shutil
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
COPY_PATHS = ("index.html", "about", "src", "assets", "public/audio", "public/data/artworks", "public/og")


def main() -> None:
    parser = argparse.ArgumentParser(description="Create the Cloudflare Assets bundle for WOVEN.")
    parser.add_argument("--output", type=Path, default=ROOT / "dist")
    args = parser.parse_args()
    if args.output.exists():
        shutil.rmtree(args.output)
    args.output.mkdir(parents=True)
    for relative in COPY_PATHS:
        source, target = ROOT / relative, args.output / relative
        if source.is_dir():
            shutil.copytree(source, target)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
    print(args.output)


if __name__ == "__main__":
    main()

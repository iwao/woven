#!/usr/bin/env python3
"""Pack the runtime WOVEN overview tiles into typed-array binary artifacts.

The browser renders only normal Overview and fullscreen Overview Wide.  JSONL
is useful as an inspectable generation product, but not as a runtime format:
parsing it creates hundreds of thousands of short-lived JS objects.  This
exporter keeps JSONL as a local build input and writes the four deployable
layers as a compact little-endian binary layout.
"""
from __future__ import annotations

import argparse
import json
import struct
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE_DIRECTORY = ROOT.parent / "woven-data" / "output" / "woven_tiles_artist_first_5000_rism"
DEFAULT_OUTPUT_DIRECTORY = ROOT / "public" / "data" / "woven-tiles"
MAGIC = b"WVTL"
VERSION = 1
HEADER = struct.Struct("<4sHHIIIIII")
CELL = struct.Struct("<HHIHH")
DELTA = struct.Struct("<HHf")
RUNTIME_LAYERS = ("overview/artist", "overview/work", "overview-wide/artist", "overview-wide/work")


def pack_layer(source_directory: Path, output_directory: Path, key: str, info: dict[str, object]) -> dict[str, object]:
    source = source_directory / str(info["artifact"])
    cells: list[tuple[int, int, int, int]] = []
    deltas: list[tuple[int, float]] = []
    with source.open(encoding="utf-8") as handle:
        for line in handle:
            row = json.loads(line)
            start = len(deltas)
            values = row["deltas"]
            if len(values) > 65535:
                raise ValueError(f"too many deltas in one cell: {source}")
            deltas.extend((int(year), float(weight)) for year, weight in values)
            cells.append((int(row["x"]), int(row["y"]), start, len(values)))
    target = output_directory / source.with_suffix(".bin").name
    target.parent.mkdir(parents=True, exist_ok=True)
    cells_offset = HEADER.size
    deltas_offset = cells_offset + CELL.size * len(cells)
    with target.open("wb") as handle:
        handle.write(HEADER.pack(MAGIC, VERSION, 0, int(info["width"]), int(info["height"]), len(cells), len(deltas), cells_offset, deltas_offset))
        for x, y, start, count in cells:
            handle.write(CELL.pack(x, y, start, count, 0))
        for year, weight in deltas:
            handle.write(DELTA.pack(year, 0, weight))
    return {
        **info,
        "artifact": target.name,
        "encoding": "woven_tile_binary_v1",
        "byte_length": target.stat().st_size,
        "cell_count": len(cells),
        "delta_count": len(deltas),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Build WOVEN typed-array runtime tiles.")
    parser.add_argument("--source-directory", type=Path, default=DEFAULT_SOURCE_DIRECTORY, help="JSONL tile build input from woven-data output")
    parser.add_argument("--output-directory", type=Path, default=DEFAULT_OUTPUT_DIRECTORY, help="deployable binary tile output")
    args = parser.parse_args()
    manifest = json.loads((args.source_directory / "manifest.json").read_text(encoding="utf-8"))
    layers = dict(manifest["layers"])
    for key in RUNTIME_LAYERS:
        layers[key] = pack_layer(args.source_directory, args.output_directory, key, layers[key])
    manifest["layers"] = layers
    manifest["runtime_encoding"] = "woven_tile_binary_v1"
    args.output_directory.mkdir(parents=True, exist_ok=True)
    (args.output_directory / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"source": str(args.source_directory), "output": str(args.output_directory), "layers": list(RUNTIME_LAYERS)}, ensure_ascii=False))


if __name__ == "__main__":
    main()

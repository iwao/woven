#!/usr/bin/env python3
"""Create the bounded public Artist catalogue used by WOVEN artwork routes."""
from __future__ import annotations

import argparse
import json
import re
import unicodedata
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "public" / "data" / "woven-sample.json"
OUTPUT = ROOT / "public" / "data" / "artworks" / "catalog.json"

# The WOVEN source preserves its relation-facing Artist names. Public display
# metadata is sourced from the authoritative Classii Artist JSONL instead.
ENTITY_ARTIST_SOURCE = ROOT.parent / "all_entities_jsonl" / "artists.jsonl"


def artist_metadata(path: Path) -> dict[str, dict[str, object]]:
    """Read display metadata from the authoritative Classii Artist JSONL."""
    metadata: dict[str, dict[str, object]] = {}
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            artist = json.loads(line)
            artist_id = str(artist.get("id") or "")
            birth_date = artist.get("birthDate") or {}
            birth_year = birth_date.get("year") if isinstance(birth_date, dict) else None
            english_name = next((item.get("label") for item in artist.get("i18n") or []
                                 if item.get("lang") == "en" and item.get("label")), artist.get("name"))
            if artist_id and isinstance(birth_year, int) and isinstance(english_name, str):
                metadata[artist_id] = {"birthYear": birth_year, "displayName": english_name}
    return metadata


def slugify(name: str, artist_id: str, used: set[str]) -> str:
    text = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()
    base = re.sub(r"[^a-z0-9]+", "-", text).strip("-") or "artist"
    slug = base
    if slug in used:
        slug = f"{base}-{artist_id[:8]}"
    used.add(slug)
    return slug


def main() -> None:
    parser = argparse.ArgumentParser(description="Build the public WOVEN Artist artwork catalogue.")
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--source", type=Path, default=SOURCE)
    parser.add_argument("--artist-metadata", type=Path, default=ENTITY_ARTIST_SOURCE)
    parser.add_argument("--output", type=Path, default=OUTPUT)
    args = parser.parse_args()

    source = json.loads(args.source.read_text(encoding="utf-8"))
    if not args.artist_metadata.exists():
        parser.error(f"missing authoritative Artist JSONL: {args.artist_metadata}")
    metadata = artist_metadata(args.artist_metadata)
    years = [int(year) for year in source["years"]]
    artists = sorted(source["artists"], key=lambda artist: (-float(artist["weight"]), artist["name"].casefold(), artist["id"]))[:args.limit]
    used: set[str] = set()
    catalogue = []
    for rank, artist in enumerate(artists, start=1):
        series = artist.get("series") or []
        artist_id = str(artist["id"])
        metadata_row = metadata.get(artist_id)
        if not metadata_row:
            parser.error(f"missing Artist metadata for public Artist {artist_id}")
        display_name = str(metadata_row["displayName"])
        birth_year = int(metadata_row["birthYear"])
        if not 1000 <= birth_year <= 9999:
            parser.error(f"missing four-digit birth year for public Artist {artist_id} ({display_name})")
        catalogue.append({
            "rank": rank,
            # WOVEN's Artist identifiers are stable Classii entity IDs.
            "classiiId": artist_id,
            "slug": slugify(display_name, artist_id, used),
            "name": artist["name"],
            "displayName": display_name,
            "birthYear": birth_year,
            "weight": round(float(artist["weight"]), 6),
            "firstYear": min((int(row["year"]) for row in series), default=None),
            "lastYear": max((int(row["year"]) for row in series), default=None),
            "defaultYear": years[-1],
        })
    catalogue.sort(key=lambda artist: (artist["birthYear"], artist["displayName"].casefold(), artist["classiiId"]))
    payload = {
        "version": "woven-artwork-catalog-v1",
        "snapshotId": source["snapshotId"],
        "limit": args.limit,
        "routePattern": "/artists/<classii-id>/<slug>/<year>",
        "artists": catalogue,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(args.output), "artists": len(catalogue), "snapshotId": source["snapshotId"]}))


if __name__ == "__main__":
    main()

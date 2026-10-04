#!/usr/bin/env python3
"""Package the WOVEN sample outputs into one browser-ready static asset."""
from __future__ import annotations

import json
import argparse
from collections import defaultdict
from itertools import combinations
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "woven-data" / "output"
CLASSII = ROOT / "all_entities_jsonl"
OUTPUT = Path(__file__).resolve().parents[1] / "public" / "data" / "woven-sample.json"


def rows(path: Path):
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                yield json.loads(line)


def names(path: Path, wanted: set[str]) -> dict[str, str]:
    result = {}
    for item in rows(path):
        item_id = str(item.get("id") or "")
        if item_id in wanted:
            result[item_id] = str(item.get("name") or item_id)
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Package a bounded WOVEN validation sample for the browser.")
    parser.add_argument("--suffix", default="sample_1000_releases", help="Artifact suffix without the leading underscore.")
    args = parser.parse_args()
    suffix = args.suffix
    order = list(rows(DATA / f"work_dimension_order_{suffix}.jsonl"))
    vectors = list(rows(DATA / f"artist_year_vectors_{suffix}.jsonl"))
    relations = list(rows(DATA / f"artist_work_relations_{suffix}.jsonl"))
    lod_nodes = list(rows(DATA / f"work_lod_tree_{suffix}.jsonl"))
    manifest = json.loads((DATA / f"work_lod_tree_{suffix}.jsonl.manifest.json").read_text(encoding="utf-8"))
    positions = {str(row["work_id"]): int(row["position"]) for row in order}
    artist_ids = {str(row["artist_id"]) for row in vectors}
    work_ids = set(positions)
    artist_names = names(CLASSII / "artists.jsonl", artist_ids)
    work_names = names(CLASSII / "works.jsonl", work_ids)

    annual_all: dict[int, dict[int, float]] = defaultdict(lambda: defaultdict(float))
    artist_series: dict[str, list[dict]] = defaultdict(list)
    first_artist_work_year: dict[tuple[str, str], int] = {}
    for row in vectors:
        artist_id = str(row["artist_id"])
        for entry in row["work_deltas"]:
            work_id = str(entry["work_id"])
            if work_id in positions:
                key = (artist_id, work_id)
                first_artist_work_year[key] = min(first_artist_work_year.get(key, int(row["year"])), int(row["year"]))
        compact = {
            "year": row["year"],
            "delta": row["delta_total_weight"],
            "cumulative": row["cumulative_total_weight"],
            "activeWorks": row["active_work_count"],
            "works": [[positions[entry["work_id"]], entry["delta_weight"]] for entry in row["work_deltas"] if entry["work_id"] in positions],
        }
        artist_series[str(row["artist_id"])].append(compact)
        for position, value in compact["works"]:
            annual_all[int(row["year"])][position] += float(value)

    top_by_work: dict[str, list[dict]] = defaultdict(list)
    for row in relations:
        top_by_work[str(row["work_id"])].append({"artist": str(row["artist_id"]), "weight": row["total_weight"], "relations": row["relation_weights"]})
    for value in top_by_work.values():
        value.sort(key=lambda item: (-item["weight"], item["artist"]))

    # Artist–Artist co-occurrence is explicitly work-mediated.  A pair receives
    # the smaller of its two Artist–Work weights for each shared Work, so a lone
    # strong credit cannot inflate the connection by itself.
    artist_pairs: dict[tuple[str, str], dict] = {}
    for work_id, credits in top_by_work.items():
        for left, right in combinations(credits, 2):
            pair = tuple(sorted((left["artist"], right["artist"])))
            item = artist_pairs.setdefault(pair, {"weight": 0.0, "shared_work_count": 0, "first_year": None})
            item["weight"] += min(float(left["weight"]), float(right["weight"]))
            item["shared_work_count"] += 1
            active_years = [first_artist_work_year.get((left["artist"], work_id)), first_artist_work_year.get((right["artist"], work_id))]
            if all(year is not None for year in active_years):
                relation_year = max(active_years)
                item["first_year"] = relation_year if item["first_year"] is None else min(item["first_year"], relation_year)

    payload = {
        "version": "woven-app-validation-sample-v1",
        "datasetScope": suffix,
        "snapshotId": manifest["snapshot_id"],
        "years": sorted(annual_all),
        "works": [{"position": row["position"], "id": row["work_id"], "name": work_names.get(str(row["work_id"]), str(row["work_id"])), "weight": row["total_weight"]} for row in order],
        "allSeries": [{"year": year, "works": [[position, round(value, 6)] for position, value in sorted(values.items())], "delta": round(sum(values.values()), 6)} for year, values in sorted(annual_all.items())],
        "artists": [{"id": artist_id, "name": artist_names.get(artist_id, artist_id), "series": sorted(series, key=lambda item: item["year"])} for artist_id, series in sorted(artist_series.items(), key=lambda item: artist_names.get(item[0], item[0]))],
        "artistRelations": [
            {"source": source, "target": target, "weight": round(value["weight"], 6), "sharedWorks": value["shared_work_count"], "firstYear": value["first_year"]}
            for (source, target), value in sorted(artist_pairs.items())
        ],
        "workRelations": {work_id: values[:8] for work_id, values in top_by_work.items()},
        "lod": {
            **{key: manifest[key] for key in ("work_count", "artist_count", "component_count", "tree_node_count", "root_node_id")},
            # Compact runtime form: no repeated provenance or calculation-only fields.
            "tree": [
                {"id": node["node_id"], "kind": node["node_kind"], "work": node["work_id"], "children": node["children"], "leaves": node["leaf_count"], "dominantWorks": node["dominant_work_ids"]}
                for node in lod_nodes
            ],
        },
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(json.dumps({"output": str(OUTPUT), "bytes": OUTPUT.stat().st_size, "works": len(order), "artists": len(artist_series), "artist_pairs": len(artist_pairs)}))


if __name__ == "__main__":
    main()

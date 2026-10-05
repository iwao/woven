#!/usr/bin/env python3
"""Package Artist-first WOVEN assets; only the X Artist axis is LOD-compressed."""
from __future__ import annotations
import argparse
import json
from collections import defaultdict
from itertools import combinations
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA, CLASSII = ROOT / "woven-data" / "output", ROOT / "all_entities_jsonl"
OUTPUT = Path(__file__).resolve().parents[1] / "public" / "data" / "woven-sample.json"

def rows(path: Path):
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            if line.strip(): yield json.loads(line)

def names(path: Path, wanted: set[str]) -> dict[str, str]:
    return {item_id: str(item.get("name") or item_id) for item in rows(path) if (item_id := str(item.get("id") or "")) in wanted}

def main() -> None:
    parser = argparse.ArgumentParser(description="Package an Artist-first WOVEN browser asset.")
    parser.add_argument("--suffix", default="sample_1000_releases")
    suffix = parser.parse_args().suffix
    order = list(rows(DATA / f"artist_dimension_order_{suffix}.jsonl"))
    vectors = list(rows(DATA / f"artist_year_vectors_{suffix}.jsonl"))
    relations = list(rows(DATA / f"artist_work_relations_{suffix}.jsonl"))
    tree = list(rows(DATA / f"artist_lod_tree_{suffix}.jsonl"))
    manifest = json.loads((DATA / f"artist_lod_tree_{suffix}.jsonl.manifest.json").read_text(encoding="utf-8"))
    artist_ids, work_ids = {str(row["artist_id"]) for row in order}, {str(row["work_id"]) for row in relations}
    artist_names, work_names = names(CLASSII / "artists.jsonl", artist_ids), names(CLASSII / "works.jsonl", work_ids)
    series, first_year, work_weight = defaultdict(list), {}, defaultdict(float)
    for row in vectors:
        artist = str(row["artist_id"])
        if artist not in artist_ids: continue
        works = []
        for entry in row["work_deltas"]:
            work = str(entry["work_id"]); first_year[artist, work] = min(first_year.get((artist, work), int(row["year"])), int(row["year"])); work_weight[work] += float(entry["delta_weight"]); works.append([work, entry["delta_weight"]])
        series[artist].append({"year": row["year"], "delta": row["delta_total_weight"], "cumulative": row["cumulative_total_weight"], "activeWorks": row["active_work_count"], "works": works})
    works = [{"position": i, "id": work, "name": work_names.get(work, work), "weight": round(weight, 6)} for i, (work, weight) in enumerate(sorted(work_weight.items(), key=lambda item: (-item[1], work_names.get(item[0], item[0]), item[0])))]
    by_work = defaultdict(list)
    for row in relations: by_work[str(row["work_id"])].append({"artist": str(row["artist_id"]), "weight": row["total_weight"]})
    pairs = {}
    for work, credits in by_work.items():
        for left, right in combinations(sorted(credits, key=lambda item: item["artist"]), 2):
            key = left["artist"], right["artist"]; value = pairs.setdefault(key, {"weight": 0., "shared": 0, "first": None}); value["weight"] += min(float(left["weight"]), float(right["weight"])); value["shared"] += 1
            years = [first_year.get((artist, work)) for artist in key]
            if all(year is not None for year in years): value["first"] = max(years) if value["first"] is None else min(value["first"], max(years))
    payload = {"version": "woven-artist-first-v1", "datasetScope": suffix, "snapshotId": manifest["snapshot_id"], "years": sorted({int(row["year"]) for row in vectors}), "artists": [{"position": row["position"], "id": row["artist_id"], "name": artist_names.get(str(row["artist_id"]), str(row["artist_id"])), "weight": row["total_weight"], "series": sorted(series.get(str(row["artist_id"]), []), key=lambda item: item["year"])} for row in order], "works": works, "artistRelations": [{"source": source, "target": target, "weight": round(value["weight"], 6), "sharedWorks": value["shared"], "firstYear": value["first"]} for (source, target), value in sorted(pairs.items())], "lod": {**{key: manifest[key] for key in ("artist_count", "work_count", "component_count", "tree_node_count", "root_node_id")}, "tree": [{"id": node["node_id"], "kind": node["node_kind"], "artist": node["artist_id"], "children": node["children"], "leaves": node["leaf_count"], "dominantArtists": node["dominant_artist_ids"]} for node in tree]}}
    OUTPUT.parent.mkdir(parents=True, exist_ok=True); OUTPUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(json.dumps({"output": str(OUTPUT), "artists": len(order), "works": len(works), "artist_pairs": len(pairs)}))

if __name__ == "__main__": main()

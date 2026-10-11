#!/usr/bin/env python3
"""Export static OGP pages and previews for the bounded WOVEN artwork catalogue.

The interactive view is a static SPA, so changing meta tags in the browser is
not sufficient for social crawlers. This exporter prerenders selected artwork
routes. Its card graphic is derived from the same Artist and Work vector data as
the canvas; it deliberately does not require a browser, GPU, or screen capture.
"""
from __future__ import annotations

import argparse
import html
import json
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import quote


ROOT = Path(__file__).resolve().parents[1]
SAMPLE = ROOT / "public" / "data" / "woven-sample.json"
CATALOG = ROOT / "public" / "data" / "artworks" / "catalog.json"
INDEX = ROOT / "index.html"

WIDTH, HEIGHT = 1200, 630
PLOT = (52, 165, 1096, 392)


def esc(value: object) -> str:
    return html.escape(str(value), quote=True)


def route(entry: dict[str, object], year: int) -> str:
    return "/artists/{}/{}".format(quote(str(entry["slug"])), year)


def replace_head(index: str, title: str, description: str, canonical: str, image: str) -> str:
    index = re.sub(r"<title>.*?</title>", f"<title>{esc(title)}</title>", index, count=1, flags=re.S)
    tags = "\n    ".join((
        f'<link rel="canonical" href="{esc(canonical)}" />',
        f'<meta name="description" content="{esc(description)}" />',
        '<meta property="og:type" content="website" />',
        '<meta property="og:site_name" content="WOVEN" />',
        f'<meta property="og:title" content="{esc(title)}" />',
        f'<meta property="og:description" content="{esc(description)}" />',
        f'<meta property="og:url" content="{esc(canonical)}" />',
        f'<meta property="og:image" content="{esc(image)}" />',
        '<meta property="og:image:width" content="1200" />',
        '<meta property="og:image:height" content="630" />',
        '<meta name="twitter:card" content="summary_large_image" />',
        f'<meta name="twitter:title" content="{esc(title)}" />',
        f'<meta name="twitter:description" content="{esc(description)}" />',
        f'<meta name="twitter:image" content="{esc(image)}" />',
    ))
    # Remove generic OGP tags from the shell so that crawlers receive one
    # unambiguous value for each property.
    index = re.sub(r"\s*<meta (?:name|property)=\"(?:description|og:[^\"]+|twitter:[^\"]+)\"[^>]* />", "", index)
    return index.replace("</head>", f"    {tags}\n  </head>", 1)


def selected_points(artist: dict[str, object], work_index: dict[str, int], year: int) -> list[tuple[int, float]]:
    points: dict[str, float] = {}
    for row in artist.get("series") or []:
        if int(row["year"]) > year:
            continue
        for work_id, weight in row.get("works") or []:
            points[work_id] = points.get(work_id, 0.0) + float(weight)
    return [(work_index[work_id], weight) for work_id, weight in points.items() if work_id in work_index]


def preview_svg(entry: dict[str, object], artist: dict[str, object], work_index: dict[str, int], artist_count: int, work_count: int, year: int) -> str:
    px, py, pw, ph = PLOT
    x = px + pw * int(artist["position"]) / max(1, artist_count - 1)
    points = selected_points(artist, work_index, year)
    max_weight = max((weight for _, weight in points), default=1.0)
    dots = []
    # The muted warp threads preserve the sense of the overall canvas while
    # the highlighted column and its vector endpoints retain the selected work.
    for i in range(0, artist_count, max(1, artist_count // 64)):
        thread_x = px + pw * i / max(1, artist_count - 1)
        dots.append(f'<line x1="{thread_x:.2f}" y1="{py}" x2="{thread_x:.2f}" y2="{py + ph}" stroke="#E2D5C5" stroke-opacity=".10" stroke-width="1"/>')
    for work, weight in points:
        y = py + ph * work / max(1, work_count - 1)
        radius = 1.8 + min(6.2, (weight / max_weight) ** .45 * 6.2)
        dots.append(f'<circle cx="{x:.2f}" cy="{y:.2f}" r="{radius + 9:.2f}" fill="#F99848" fill-opacity=".11"/>')
        dots.append(f'<circle cx="{x:.2f}" cy="{y:.2f}" r="{radius:.2f}" fill="#F2EE82" fill-opacity=".94"/>')
    display_name = str(entry.get("displayName") or entry.get("name"))
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{WIDTH}" height="{HEIGHT}" viewBox="0 0 {WIDTH} {HEIGHT}">
<rect width="100%" height="100%" fill="#000000"/>
<rect x="32" y="30" width="1136" height="570" fill="none" stroke="#44433f" stroke-width="1"/>
<text x="52" y="78" fill="#E2D5C5" font-family="Arial, Helvetica, sans-serif" font-size="20" letter-spacing="5">WOVEN</text>
<text x="52" y="122" fill="#F2EE82" font-family="Arial, Helvetica, sans-serif" font-size="32">{esc(display_name)} · {year}</text>
<line x1="{x:.2f}" y1="{py}" x2="{x:.2f}" y2="{py + ph}" stroke="#F99848" stroke-opacity=".26" stroke-width="18"/>
<line x1="{x:.2f}" y1="{py}" x2="{x:.2f}" y2="{py + ph}" stroke="#F2EE82" stroke-opacity=".92" stroke-width="2"/>
{''.join(dots)}
<text x="52" y="584" fill="#9D9D9A" font-family="Arial, Helvetica, sans-serif" font-size="13" letter-spacing="2">ARTIST RELATION TEMPORAL FIELD · CLASSII</text>
</svg>'''


def rasterize(svg: str, destination: Path) -> None:
    if not shutil.which("magick"):
        raise RuntimeError("ImageMagick `magick` is required to create OGP PNGs.")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", suffix=".svg", encoding="utf-8", delete=False) as source:
        source.write(svg)
        temporary = Path(source.name)
    try:
        completed = subprocess.run(
            ["magick", str(temporary), "-strip", "-quality", "90", str(destination)],
            capture_output=True,
            text=True,
        )
        if completed.returncode:
            raise RuntimeError(f"ImageMagick failed for {destination}: {completed.stderr.strip()}")
    finally:
        temporary.unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="Build static OGP pages for WOVEN artworks.")
    parser.add_argument("--site-url", required=True, help="Published site origin, e.g. https://woven.example")
    parser.add_argument("--years", choices=("default", "active"), default="default", help="default: one current card per Artist; active: every Artist vector-acquisition year")
    parser.add_argument("--limit", type=int, help="Optional number of catalog Artists to export; useful for preview QA.")
    parser.add_argument("--sample", type=Path, default=SAMPLE)
    parser.add_argument("--catalog", type=Path, default=CATALOG)
    parser.add_argument("--output-root", type=Path, default=ROOT)
    args = parser.parse_args()

    site_url = args.site_url.rstrip("/")
    if not site_url.startswith(("https://", "http://")):
        parser.error("--site-url must begin with http:// or https://")
    source = json.loads(args.sample.read_text(encoding="utf-8"))
    catalog = json.loads(args.catalog.read_text(encoding="utf-8"))["artists"]
    shell = INDEX.read_text(encoding="utf-8")
    artists = {artist["id"]: artist for artist in source["artists"]}
    work_index = {work["id"]: index for index, work in enumerate(source["works"])}
    generated = 0
    for entry in catalog[:args.limit]:
        artist = artists.get(entry["classiiId"])
        if not artist:
            raise RuntimeError(f"catalog Artist is missing from sample: {entry['classiiId']}")
        years = [int(entry["defaultYear"])] if args.years == "default" else sorted({int(row["year"]) for row in artist.get("series") or []} | {int(entry["defaultYear"])})
        for year in years:
            path = route(entry, year)
            title = f"WOVEN — {entry.get('displayName') or entry.get('name')} · {year}"
            description = f"{entry.get('displayName') or entry.get('name')} · {year}, a WOVEN artist relation temporal field from the Classii cultural graph."
            image_path = f"/public/og/artworks/{entry['classiiId']}/{year}.png"
            canonical = f"{site_url}{path}"
            rasterize(preview_svg(entry, artist, work_index, len(source["artists"]), len(source["works"]), year), args.output_root / image_path.lstrip("/"))
            page = replace_head(shell, title, description, canonical, f"{site_url}{image_path}")
            page_file = args.output_root / path.lstrip("/") / "index.html"
            page_file.parent.mkdir(parents=True, exist_ok=True)
            page_file.write_text(page, encoding="utf-8")
            generated += 1
    print(json.dumps({"pages": generated, "years": args.years, "siteUrl": site_url}, ensure_ascii=False))


if __name__ == "__main__":
    main()

#!/usr/bin/env bash
set -euo pipefail

# Requires: `npx wrangler login` and the `woven-data` R2 bucket configured in
# wrangler.jsonc. Generated data stays outside Git and is uploaded by key.
root=$(cd "$(dirname "$0")/.." && pwd)
data="$root/public/data"
bucket=${WOVEN_R2_BUCKET:-woven-data}

npx wrangler r2 object put "$bucket/woven-sample.json" --file="$data/woven-sample.json" --content-type="application/json"
for file in "$data"/woven-tiles/manifest.json "$data"/woven-tiles/overview_artist.bin "$data"/woven-tiles/overview_work.bin "$data"/woven-tiles/overview-wide_artist.bin "$data"/woven-tiles/overview-wide_work.bin; do
  npx wrangler r2 object put "$bucket/woven-tiles/$(basename "$file")" --file="$file" --content-type="application/octet-stream"
done

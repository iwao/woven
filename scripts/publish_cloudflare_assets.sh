#!/usr/bin/env bash
set -euo pipefail

# Requires: `npx wrangler login` and the `woven-data` R2 bucket configured in
# wrangler.jsonc. Generated data stays outside Git and is uploaded by key.
root=$(cd "$(dirname "$0")/.." && pwd)
data="$root/public/data"
bucket=${WOVEN_R2_BUCKET:-woven-data}
parts_dir=$(mktemp -d)
trap 'rm -rf "$parts_dir"' EXIT

# The browser transparently expands this single Brotli object. This avoids
# downloading the 193MB JSON ledger uncompressed before the UI can initialise.
brotli --quality=11 --stdout "$data/woven-sample.json" > "$parts_dir/woven-sample.json.br"
npx wrangler r2 object put "$bucket/woven-sample.json" --remote --file="$parts_dir/woven-sample.json.br" --content-type="application/json" --content-encoding="br"
npx wrangler r2 object put "$bucket/woven-tiles/manifest.json" --remote --file="$data/woven-tiles/manifest.json" --content-type="application/json"
for file in "$data"/woven-tiles/overview_artist.bin "$data"/woven-tiles/overview_work.bin "$data"/woven-tiles/overview-wide_artist.bin "$data"/woven-tiles/overview-wide_work.bin; do
  npx wrangler r2 object put "$bucket/woven-tiles/$(basename "$file")" --remote --file="$file" --content-type="application/octet-stream"
done

#!/usr/bin/env bash
set -euo pipefail

# Requires: `npx wrangler login` and the `woven-data` R2 bucket configured in
# wrangler.jsonc. Generated data stays outside Git and is uploaded by key.
root=$(cd "$(dirname "$0")/.." && pwd)
data="$root/public/data"
bucket=${WOVEN_R2_BUCKET:-woven-data}
BROTLI_QUALITY=${WOVEN_BROTLI_QUALITY:-6}
parts_dir=$(mktemp -d)
trap 'rm -rf "$parts_dir"' EXIT

# Browsers transparently expand these Brotli objects. This avoids downloading
# the 193MB JSON ledger and binary tile matrices uncompressed before the UI
# can initialise.
brotli --quality="$BROTLI_QUALITY" --stdout "$data/woven-sample.json" > "$parts_dir/woven-sample.json.br"
npx wrangler r2 object put "$bucket/woven-sample.json" --remote --file="$parts_dir/woven-sample.json.br" --content-type="application/json" --content-encoding="br"
npx wrangler r2 object put "$bucket/woven-tiles/manifest.json" --remote --file="$data/woven-tiles/manifest.json" --content-type="application/json"
for file in "$data"/woven-tiles/overview_artist.bin "$data"/woven-tiles/overview_work.bin "$data"/woven-tiles/overview-wide_artist.bin "$data"/woven-tiles/overview-wide_work.bin; do
  compressed="$parts_dir/$(basename "$file").br"
  brotli --quality="$BROTLI_QUALITY" --stdout "$file" > "$compressed"
  npx wrangler r2 object put "$bucket/woven-tiles/$(basename "$file")" --remote --file="$compressed" --content-type="application/octet-stream" --content-encoding="br"
done

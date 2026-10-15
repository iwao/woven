#!/usr/bin/env bash
set -euo pipefail

# Requires: `npx wrangler login` and the `woven-data` R2 bucket configured in
# wrangler.jsonc. Generated data stays outside Git and is uploaded by key.
root=$(cd "$(dirname "$0")/.." && pwd)
data="$root/public/data"
bucket=${WOVEN_R2_BUCKET:-woven-data}
# Tile generation is infrequent, while these assets are downloaded repeatedly.
# Prefer the smallest static objects; override for a quicker local iteration.
BROTLI_QUALITY=${WOVEN_BROTLI_QUALITY:-11}
parts_dir=$(mktemp -d)
trap 'rm -rf "$parts_dir"' EXIT

# Browsers transparently expand these Brotli objects. The initial runtime
# index is small; Artist detail and binary tiles are loaded only as needed.
npx wrangler r2 object put "$bucket/woven-tiles/manifest.json" --remote --file="$data/woven-tiles/manifest.json" --content-type="application/json"
runtime="$data/woven-runtime"
brotli --quality="$BROTLI_QUALITY" --stdout "$runtime/index.json" > "$parts_dir/runtime-index.json.br"
npx wrangler r2 object put "$bucket/woven-runtime/index.json" --remote --file="$parts_dir/runtime-index.json.br" --content-type="application/json" --content-encoding="br"
for file in "$runtime"/artists/*.json; do
  compressed="$parts_dir/runtime-$(basename "$file").br"
  brotli --quality="$BROTLI_QUALITY" --stdout "$file" > "$compressed"
  npx wrangler r2 object put "$bucket/woven-runtime/artists/$(basename "$file")" --remote --file="$compressed" --content-type="application/json" --content-encoding="br"
done
for file in "$data"/woven-tiles/overview-portrait_artist.bin "$data"/woven-tiles/overview-portrait_work.bin "$data"/woven-tiles/overview_artist.bin "$data"/woven-tiles/overview_work.bin "$data"/woven-tiles/overview-wide_artist.bin "$data"/woven-tiles/overview-wide_work.bin "$data"/woven-tiles/overview-ultra_artist.bin "$data"/woven-tiles/overview-ultra_work.bin; do
  compressed="$parts_dir/$(basename "$file").br"
  brotli --quality="$BROTLI_QUALITY" --stdout "$file" > "$compressed"
  npx wrangler r2 object put "$bucket/woven-tiles/$(basename "$file")" --remote --file="$compressed" --content-type="application/octet-stream" --content-encoding="br"
done

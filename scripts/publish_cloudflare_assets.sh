#!/usr/bin/env bash
set -euo pipefail

# Requires: `npx wrangler login` and the `woven-data` R2 bucket configured in
# wrangler.jsonc. Generated data stays outside Git and is uploaded by key.
root=$(cd "$(dirname "$0")/.." && pwd)
data="$root/public/data"
bucket=${WOVEN_R2_BUCKET:-woven-data}
parts_dir=$(mktemp -d)
trap 'rm -rf "$parts_dir"' EXIT

# Wrangler's direct object upload is intentionally kept below its large-object
# threshold. The Worker concatenates these immutable byte ranges when the app
# requests woven-sample.json, so the browser keeps its existing contract.
split -b 24m -a 3 "$data/woven-sample.json" "$parts_dir/part-"
parts=()
for file in "$parts_dir"/part-*; do
  key="woven-sample/$(basename "$file")"
  npx wrangler r2 object put "$bucket/$key" --remote --file="$file" --content-type="application/octet-stream"
  parts+=("$key")
done
printf '{"parts":[' > "$parts_dir/parts.json"
for index in "${!parts[@]}"; do
  (( index )) && printf ',' >> "$parts_dir/parts.json"
  printf '"%s"' "${parts[index]}" >> "$parts_dir/parts.json"
done
printf ']}' >> "$parts_dir/parts.json"
npx wrangler r2 object put "$bucket/woven-sample/parts.json" --remote --file="$parts_dir/parts.json" --content-type="application/json"
npx wrangler r2 object put "$bucket/woven-tiles/manifest.json" --remote --file="$data/woven-tiles/manifest.json" --content-type="application/json"
for file in "$data"/woven-tiles/overview_artist.bin "$data"/woven-tiles/overview_work.bin "$data"/woven-tiles/overview-wide_artist.bin "$data"/woven-tiles/overview-wide_work.bin; do
  npx wrangler r2 object put "$bucket/woven-tiles/$(basename "$file")" --remote --file="$file" --content-type="application/octet-stream"
done

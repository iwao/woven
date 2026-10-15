#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$root/src/wasm"
PATH="/opt/homebrew/opt/rustup/bin:$PATH" rustup run stable rustc \
  --target wasm32-unknown-unknown --crate-type cdylib -C opt-level=3 -C panic=abort \
  -C link-arg=--export-memory -C link-arg=--export=__heap_base \
  -o "$root/src/wasm/woven-aggregate.wasm" "$root/wasm/woven_aggregate.rs"

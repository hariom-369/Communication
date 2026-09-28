#!/usr/bin/env bash
# Builds the crypto core for the web worker: Rust → wasm32 → wasm-bindgen ES module in pkg/.
# The wasm-bindgen CLI version must equal the crate's pinned wasm-bindgen version.
set -euo pipefail
cd "$(dirname "$0")/.."
expected="$(grep -E '^wasm-bindgen = ' Cargo.toml | sed -E 's/.*"=([0-9.]+)".*/\1/')"
actual="$(wasm-bindgen --version | awk '{print $2}')"
if [[ "$expected" != "$actual" ]]; then
  echo "wasm-bindgen CLI $actual does not match crate version $expected" >&2
  echo "install with: cargo install wasm-bindgen-cli --version $expected --locked" >&2
  exit 1
fi
cargo build --locked --release --target wasm32-unknown-unknown
wasm-bindgen --target web --out-dir pkg --out-name crypto_core \
  target/wasm32-unknown-unknown/release/tessera_crypto_core.wasm
ls -l pkg/crypto_core_bg.wasm

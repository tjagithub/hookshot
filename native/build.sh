#!/usr/bin/env bash
# Builds native/build/: hsparse.node (Node-API), libhsparse.dylib (bun:ffi), hsparse.wasm (fallback).
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p build
flags=(-trimpath -ldflags='-s -w')

go build "${flags[@]}" -buildmode=c-shared -o build/libhsparse.dylib .
go build "${flags[@]}" -buildmode=c-archive -o build/libhsparse.a .
GOOS=js GOARCH=wasm go build "${flags[@]}" -o build/hsparse.wasm .
cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" build/wasm_exec.js

node_inc="$(dirname "$(readlink -f "$(command -v node)")")/../include/node"
cc -O2 -shared -undefined dynamic_lookup -I"$node_inc" -Ibuild napi/addon.c build/libhsparse.a \
  -framework CoreFoundation -framework Security -lresolv -o build/hsparse.node
ls -l build/hsparse.node build/libhsparse.dylib build/hsparse.wasm

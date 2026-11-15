#!/usr/bin/env bash
# Builds build/hsparse-<platform>-<arch>.node and hsparse.wasm. HS_ARCH=x64 cross-builds on macOS.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p build
# No vcs stamp: otherwise every commit changes hsparse.wasm and the CI "matches git" check always warns.
flags=(-trimpath -buildvcs=false -ldflags='-s -w')

case "$(uname -s)" in
  Darwin) platform=darwin ;;
  Linux) platform=linux ;;
  *) echo "build.sh: unsupported OS $(uname -s); hookshot uses the WASM parser there" >&2; exit 1 ;;
esac
case "${HS_ARCH:-$(uname -m)}" in
  arm64 | aarch64) arch=arm64 goarch=arm64 ;;
  x86_64 | amd64 | x64) arch=x64 goarch=amd64 ;;
  *) echo "build.sh: unsupported arch ${HS_ARCH:-$(uname -m)}" >&2; exit 1 ;;
esac

headers=../node_modules/node-api-headers/include
[[ -f $headers/node_api.h ]] || { echo "build.sh: run pnpm install first (needs node-api-headers)" >&2; exit 1; }

out="build/hsparse-$platform-$arch.node"
if [[ $platform == darwin ]]; then
  cc=(cc -arch "$([[ $arch == x64 ]] && echo x86_64 || echo arm64)")
  link=(-undefined dynamic_lookup -framework CoreFoundation -framework Security -lresolv)
else
  cc=(cc)
  link=(-lpthread)
fi

# The archive and its header (libhsparse.h, included by napi/addon.c) are intermediate, gitignored files.
CGO_ENABLED=1 GOARCH=$goarch CC="${cc[*]}" go build "${flags[@]}" -buildmode=c-archive -o build/libhsparse.a .
"${cc[@]}" -O2 -shared -fPIC -I"$headers" -Ibuild napi/addon.c build/libhsparse.a "${link[@]}" -o "$out"

if [[ ${HS_WASM:-1} == 1 ]]; then
  GOOS=js GOARCH=wasm go build "${flags[@]}" -o build/hsparse.wasm .
  cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" build/wasm_exec.js
fi
# HS_FFI=1: the bun:ffi experiment (native/ffi.ts) needs a c-shared library.
if [[ ${HS_FFI:-0} == 1 ]]; then
  go build "${flags[@]}" -buildmode=c-shared -o build/libhsparse.dylib .
fi
ls -l "$out" build/hsparse.wasm

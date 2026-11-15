# Parser backends

The parser is mvdan/sh v3.14.1, compiled from Go in two forms:

- **Native Node-API addon** `native/build/hsparse-<platform>-<arch>.node`. This is the fast one (cold start about 12 ms). The npm package includes it. In a git clone, `hookshot fetch-parser` gets it from the GitHub release that matches the package version and checks its SHA-256. It is built for darwin-arm64, darwin-x64, linux-arm64 and linux-x64.
- **WASM fallback** `native/build/hsparse.wasm`, tracked in git, so a fresh clone parses straight away (on Windows too).

`parserStatus()` says which backend loaded, and why the others did not. To build them yourself, see [CONTRIBUTING.md](../CONTRIBUTING.md).

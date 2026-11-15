# hookshot

Declarative Claude Code hooks. Rules run on a parsed shell tree (mvdan/sh in Go, loaded as a Node-API addon, WASM fallback).

## Setup and checks

- `pnpm install`, then `native/build.sh` (needs Go and `node-api-headers`). It writes `native/build/hsparse-<platform>-<arch>.node` and `hsparse.wasm`. `HS_ARCH=x64` cross-builds on Apple silicon; `HS_FFI=1` adds the bun:ffi experiment.
- `pnpm typecheck`, `pnpm test`, `pnpm coverage` (keep `src/` lines at 90% or more). `FC_RUNS=400` for deeper property runs.
- Only `hsparse.wasm` and `wasm_exec.js` are tracked in `native/build/`. Commit `hsparse.wasm` again after a rebuild, or CI warns.

## Rules of the design

- Never fail open. Anything hookshot cannot decide is an `Unknown{why}` (see `UnknownWhy` in `src/extract.ts`), which the policy turns into ask by default. A new feature that can't decide adds a `why` and a test, not a pass.
- A hook process that exits non-zero (other than 2) lets the tool call through in Claude Code. So `hookshot run` and `respond()` always exit 0 and print an ask on any error.
- Rules stay pure; `hooks()` does all I/O (state store) before and after the rules run.

## Gotchas

- mvdan's typed JSON omits empty fields (`Lit.Value` for `''`); offsets are UTF-8 bytes, not string indices.
- mvdan normalises zsh `>!` to `>|`.
- Deno throws on `process.env` without `--allow-env` and on `os.homedir()` without `--allow-sys`. Use `homeDir()` from `src/context.ts`, not `homedir()`. A CLI test runs under deno to catch this.
- Tests stub `jouet` on PATH (`test/support/guard.ts`); don't depend on tools of the dev machine. In CI (`CI` set), `test/backends.test.ts` fails instead of skipping when the addon, shfmt, bun or deno is missing.
- Release workflow: no build caches (zizmor cache-poisoning), actions pinned by SHA. `setup-node` caches on its own when `packageManager` is set, so it needs `package-manager-cache: false`.
- `hookshot fetch-parser` downloads from release `v<package.json version>`: bump the version before tagging.
- `test/cases.ts` is shared with the bash-guard reference. Port-only behaviour (pipe and path rules) goes in its own test file, such as `test/guardrails.paths.test.ts`.

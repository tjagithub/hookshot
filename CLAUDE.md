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
- Tests make temp dirs with `tempDirs()` from `test/support/tmp.ts`, which removes them after the file; don't call `mkdtempSync` directly.
- Tests stub `jouet` on PATH (`test/support/guard.ts`); don't depend on tools of the dev machine. In CI (`CI` set), `test/backends.test.ts` fails instead of skipping when the addon, shfmt, bun or deno is missing.
- Release workflow: no build caches (zizmor cache-poisoning), actions pinned by SHA. `setup-node` caches on its own when `packageManager` is set, so it needs `package-manager-cache: false`.
- npm: `@tjakit/hookshot`, published by the `npm` job of `.github/workflows/publish.yml` (trusted publishing, OIDC). The npmjs.com trusted publisher names that file: renaming the workflow breaks publishing until the config there is changed too. The tarball is `dist/` (built by `tsconfig.build.json`) plus the parsers; `test/pack.test.ts` installs it offline. Paths to `native/build` and `bin` go through `src/root.ts`, which knows both layouts.
- Release: `pnpm release X.Y.Z` (`scripts/release.sh`; `--dry-run` only checks). It checks main, the tag and the tests, bumps, commits and tags, then prints the two pushes for the user to run (main first, then the tag by name; plain `git push` sends no tags). `hookshot fetch-parser` downloads from release `v<package.json version>`. The release job waits for all four builds; darwin-x64 (Intel runner) is the slowest.
- Config files: `src/config/schema.ts` is the single source of the hookshot.toml format; the validator reads it, and `pnpm schema` writes `schema/hookshot.schema.json` (`test/schema.test.ts` fails when it is stale). A new schema keyword needs support in `src/config/validate.ts`, which throws on unknown keywords. smol-toml tables have a null prototype; TOML dates are `TomlDate` objects.
- `docs/expansions.md` and `test/expansions.test.ts` have the same rows. A new expansion or wrapper behaviour adds a row to both.
- `test/cases.ts` is shared with the bash-guard reference. Port-only behaviour (pipe and path rules) goes in its own test file, such as `test/guardrails.paths.test.ts`.

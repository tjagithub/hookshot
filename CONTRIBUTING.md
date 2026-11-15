# Contributing

```sh
pnpm install
native/build.sh          # needs Go and node-api-headers; HS_ARCH=x64 cross-builds on Apple silicon
pnpm typecheck
pnpm test                # FC_RUNS=400 for deeper property runs
pnpm coverage            # keep src/ lines at 90% or more
```

The repo's [CLAUDE.md](CLAUDE.md) has the design rules, the gotchas and the release steps. `examples/guardrails/` is a complete port of a real bash guard, with its case tables in `test/`.

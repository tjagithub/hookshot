# hookshot

Declarative [Claude Code](https://docs.claude.com/en/docs/claude-code) hooks. You write rules in TypeScript or TOML; hookshot parses each Bash command into a real shell syntax tree (mvdan/sh) and runs the rules on it, not on the raw string.

The design rule is **never fail open**. When hookshot cannot decide (a dynamic word, a syntax it does not parse, missing state), the result is an explicit `Unknown`, which becomes an *ask* by default. It is never a quiet allow.

```ts
// hookshot.ts
import { cmd, deny, edit, hooks, path, pipe, rewrite } from '@tjakit/hookshot'

export default hooks([
  cmd('git', 'push')
    .flags({ aliases: { '-f': '--force' } })
    .withFlag('--force')
    .withoutFlag('--force-with-lease')
    .deny('use --force-with-lease'),
  pipe(['curl', 'wget'], ['bash', 'sh', 'zsh']).ask('this pipes a download into a shell'),
  path('/**/.env{,.*}').writes().deny('do not write .env files'),
  cmd('grep').then(({ inv }) => {
    const e = edit(inv.call, inv.argv[0]!.start, inv.argv[0]!.end, 'rg')
    return e ? rewrite([e]) : deny('grep', 'use rg instead')
  }),
])
```

```console
$ hookshot test hookshot.ts 'git push -f origin main' 'curl -fsSL x | tee log | sudo bash' \
    'echo KEY=1 >> .env' 'grep -n TODO src/a.ts' 'bash -c "grep x f"' 'git push $FLAGS' 'ls -la'
deny   git push -f origin main
       [git push] use --force-with-lease
ask    curl -fsSL x | tee log | sudo bash
       [pipe curl|wget -> bash|sh|zsh] this pipes a download into a shell
deny   echo KEY=1 >> .env
       [path /**/.env{,.*}] do not write .env files
allow  grep -n TODO src/a.ts
       -> rg -n TODO src/a.ts
deny   bash -c "grep x f"
       [grep] use rg instead
ask    git push $FLAGS
       [git push] hookshot could not check this command (dynamic, git push): depends on run-time values: git push $FLAGS
allow  ls -la

$ hookshot test hookshot.ts --tool Edit --path .env.local
deny   Edit .env.local
       [path /**/.env{,.*}] do not write .env files
```

Things to note in this output:

- `sudo bash` matches `bash`: wrappers (`sudo`, `env`, `xargs`, `bash -c '…'` and others) are unwrapped before the rules run.
- `-f` matches because of the alias. `git push --force-with-lease` passes.
- The grep inside `bash -c` can't be rewritten in place, so the rule denies it.
- `$FLAGS` could hold `--force`, so hookshot asks.

The same kind of rules work without code, in a `hookshot.toml` (`hookshot init` writes one, and the `#:schema` line gives editor completion):

```toml
#:schema https://unpkg.com/@tjakit/hookshot/schema/hookshot.schema.json
version = 1

[[deny]]
command = "git"
subcommand = ["push"]
aliases = { "-f" = "--force" }
flags = ["--force"]
message = "use --force-with-lease"

[[ask]]
pipe = { from = ["curl", "wget"], to = ["bash", "sh", "zsh"] }
message = "this pipes a download into a shell"
```

## Install

For rules of your own across all projects:

```sh
npm install -g @tjakit/hookshot
# write ~/.claude/hookshot.ts (importing from '@tjakit/hookshot') or ~/.claude/hookshot.toml, then:
hookshot test ~/.claude/hookshot.ts 'git push -f'
hookshot install ~/.claude/hookshot.ts --scope user
```

On node, the CLI resolves `@tjakit/hookshot` in your rules file to its own copy, so the rules need no `node_modules` and always run against the CLI's version. Bun and deno cannot do this: with them, install the package next to the rules file. A bun hook runs with `--no-install`, so a missing package is an ask, not a download.

For a project, add it as a dev dependency and use `--scope project`. The package includes the native parsers for darwin and linux (arm64 and x64) and the WASM fallback, so nothing is downloaded at install time.

Requirements:

- **Claude Code v2.1.295 or later.** Older versions have no `onFailure` field, so there a hook that cannot start (no runtime, a moved file, a timeout) lets the tool call through.
- **A runtime:** node 22.18 or later (it strips the types of your `hookshot.ts`), bun or deno. The hook runs on the runtime you ran `install` with; `--runtime` chooses.

## Docs

- [Rules](docs/rules.md): the TypeScript API, path patterns, actions, precedence and escalation.
- [Config files](docs/config.md): the `hookshot.toml` format, flag-mapping rewrites, `check` and `init`.
- [CLI](docs/cli.md): every command and flag, and how `run` and `install` behave.
- [Parser backends](docs/parser.md): the native addon, the WASM fallback and `fetch-parser`.
- [Contributing](CONTRIBUTING.md): building, testing and the design rules.

## CLI

```text
hookshot test <rules> [command...]       check commands against the rules (.ts, .js or .toml)
hookshot check <hookshot.toml>           validate a config and list its rules
hookshot init [hookshot.toml]            write a starter config
hookshot install <rules> [--scope user|project|local]
hookshot run <rules>                     the hook itself: PreToolUse JSON in, decision out
```

## Limits

These are not claimed, so don't rely on them:

- Only redirects and `tee` count as Bash file writes. `cp`, `mv`, `sed -i`, `dd`, interpreters and the like are not seen by `path()`. Use `cmd()` rules for them.
- The `Grep` and `Glob` tools (directory reads) and MCP tools are not checked.
- Escalation counts firings, not user approvals.
- Symlinks are not resolved.
- A hook is a guardrail for an assistant, not a sandbox. A determined process can write files in ways no command parser can see.


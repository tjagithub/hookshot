# hookshot

Declarative [Claude Code](https://docs.claude.com/en/docs/claude-code) hooks. You write rules in TypeScript; hookshot parses each Bash command into a real shell syntax tree (mvdan/sh) and runs the rules on it, not on the raw string.

The design rule is **never fail open**. When hookshot cannot decide (a dynamic word, a syntax it does not parse, missing state), the result is an explicit `Unknown`, which becomes an *ask* by default. It is never a quiet allow.

```ts
// hooks.ts
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
$ hookshot test hooks.ts 'git push -f origin main' 'curl -fsSL x | tee log | sudo bash' \
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

$ hookshot test hooks.ts --tool Edit --path .env.local
deny   Edit .env.local
       [path /**/.env{,.*}] do not write .env files
```

Things to note in this output:

- `sudo bash` matches `bash`: wrappers (`sudo`, `env`, `xargs`, `bash -c '…'` and others) are unwrapped before the rules run.
- `-f` matches because of the alias. `git push --force-with-lease` passes.
- The grep inside `bash -c` can't be rewritten in place, so the rule denies it.
- `$FLAGS` could hold `--force`, so hookshot asks.

## Install

Your rules file imports the package, so install it where that file can resolve it. A global install is not enough. For rules of your own across all projects:

```sh
mkdir -p ~/.claude/hookshot && cd ~/.claude/hookshot
npm init -y && npm install @tjakit/hookshot
# write hooks.ts here, then:
npx hookshot test hooks.ts 'git push -f'
npx hookshot install hooks.ts --scope user
```

For a project, add it as a dev dependency and use `--scope project`. The package includes the native parsers for darwin and linux (arm64 and x64) and the WASM fallback, so nothing is downloaded at install time.

Requirements:

- **Claude Code v2.1.295 or later.** Older versions have no `onFailure` field, so there a hook that cannot start (no runtime, a moved file, a timeout) lets the tool call through.
- **A runtime:** node 22.18 or later (it strips the types of your `hooks.ts`), bun or deno. The hook runs on bun when it is on `PATH`, else node; `--runtime` chooses.

## Rules

Every rule has a matcher and a terminal action (`deny`, `ask`, `note` or `then`). A rule with no action throws when it matches, which gives a `rule-error` Unknown.

| Rule | Matches |
| --- | --- |
| `cmd(names, ...subcommands)` | a simple command, after unwrapping. `names` is a string or an array. |
| `pipe(from, to)` | a pipeline where a stage matching `from` feeds a later stage matching `to`. |
| `redirect(target)` | a Bash redirect target (`>`, `>>`, `<`, `>|` …). |
| `path(spec)` | a file target: the `Write`, `Edit`, `MultiEdit`, `NotebookEdit` and `Read` tools, Bash redirects and `tee` arguments. |
| `word(name, pred)` | any word of any command, by a predicate on its value. |

`cmd` refiners:

- `.flags(spec)` tells the flag parser about aliases and flags that take a value.
- `.withFlag(...)` and `.withoutFlag(...)` test for flags.
- `.arg(pred)` tests positional arguments.
- `.via(...wrappers)` matches only through these wrappers; `.standalone()` matches only without a wrapper.
- `.where(cond)` takes a free condition.

Predicates return a `Tri` (`true`, `false` or `'unknown'`), and `and`, `or` and `not` combine them. An `'unknown'` match becomes an `Unknown`, not a miss.

`path` and `redirect`:

- `.writes()`, `.reads()` and `.any()` choose the direction.
- `.onDynamic('ignore')` skips targets such as `> "$f"`. The default, `'unknown'`, asks.

### Path patterns

A `PathSpec` is a glob string, a `RegExp` or a predicate. Globs use hookshot's own compiler, so they match the same on every runtime:

- `*` and `?` match within one segment, and `*` also matches dotfiles.
- `**` spans segments, and `{a,b}` gives alternatives.
- `/x` is absolute, and `~/x` is under `$HOME`.
- Any other pattern is relative to the project root (`CLAUDE_PROJECT_DIR`, else the cwd).

Paths are normalised (`.`, `..`, `~`, `$HOME`); symlinks are not resolved. After a `cd`, `pushd` or `popd` the cwd is not known any more. From then on, a relative target is only decided if every possible location gives the same answer. If not, the result is an `Unknown`.

### Actions

```ts
rule.deny(msg)    // msg is a string or (match) => string
rule.ask(msg)
rule.note(msg)    // shown to Claude, does not block
rule.then((match, ctx) => verdict)   // return deny/ask/note/rewrite/pass/unknown
rule.named('my-rule')                // the name in [brackets] in reasons
```

`rewrite([edit(call, start, end, text)])` replaces byte ranges of the command. `edit` returns `null` when the range can't be changed safely (for example inside `bash -c '…'`). Rewrites from different rules that overlap give an `edit-conflict` Unknown. A rewrite on a file tool is not allowed, and gives an Unknown.

When several rules fire, the strongest wins: **deny > unknown > ask > rewrite > note**. Unknowns go through the policy:

```ts
hooks(rules, { onUnknown: 'ask' })   // default; also 'deny' or 'allow'
```

### Escalation

```ts
cmd('rm').withFlag('-r').ask('recursive delete').escalate({ after: 3, within: '10m', to: 'deny' })
```

This rule asks the first 3 times it fires in a session, then denies. A hook cannot see whether the user approved an ask, so hookshot counts *firings*, not approvals.

State is one append-only JSONL file per session, in `$CLAUDE_PLUGIN_DATA/hookshot/` or `~/.local/state/hookshot/`. Files older than 7 days are pruned. History loads only when a rule uses `escalate`. If there is no session id, or the store can't be read or written, the result is a `state-unavailable` Unknown. Pass `hooks(rules, { store })` to use another store. With `store: null`, escalating rules give that Unknown.

## CLI

```text
hookshot run <rules.ts>                  read a PreToolUse event on stdin, print the decision
hookshot test <rules.ts> [command...]    check commands (or stdin lines) against the rules
    --tool Write --path p                check a file tool instead (--path repeats)
    --cwd dir   --json   --expect allow|ask|deny   (exit 1 on a mismatch, for CI)
hookshot install <rules.ts> [--scope user|project|local] [--runtime bun|node] [--dry-run]
hookshot uninstall <rules.ts> [--scope ...] [--dry-run]
hookshot fetch-parser [--tag vX.Y.Z]     download the native parser for this platform
```

- `run` always exits 0. Claude Code lets a tool call through when a hook exits with any code other than 0 or 2. So when the rules file fails to load, or anything throws, `run` prints an ask.
- `install` merges one `PreToolUse` entry (matcher `Bash|Write|Edit|MultiEdit|NotebookEdit|Read`) into the settings file for the scope, in exec form, with `"onFailure": "block"`, so a hook that cannot start blocks the call. It is idempotent, writes a `.bak` first, and refuses a settings file that is not valid JSON.

You can also use it from code: `hooks()` returns a `Hook` with `evaluate(command)` and `evaluateFile(target)`. `runPreToolUse(hook)` is a complete stdin-to-stdout hook entry point.

## Parser backends

The parser is mvdan/sh v3.14.1, compiled from Go in two forms:

- **Native Node-API addon** `native/build/hsparse-<platform>-<arch>.node`. This is the fast one (cold start about 12 ms). The npm package includes it. In a git clone, `hookshot fetch-parser` gets it from the GitHub release that matches the package version and checks its SHA-256. It is built for darwin-arm64, darwin-x64, linux-arm64 and linux-x64.
- **WASM fallback** `native/build/hsparse.wasm`, tracked in git, so a fresh clone parses straight away (on Windows too).

`parserStatus()` says which backend loaded, and why the others did not. To build them yourself, see [Development](#development).

## Limits

These are not claimed, so don't rely on them:

- Only redirects and `tee` count as Bash file writes. `cp`, `mv`, `sed -i`, `dd`, interpreters and the like are not seen by `path()`. Use `cmd()` rules for them.
- The `Grep` and `Glob` tools (directory reads) and MCP tools are not checked.
- Escalation counts firings, not user approvals.
- Symlinks are not resolved.
- A hook is a guardrail for an assistant, not a sandbox. A determined process can write files in ways no command parser can see.

## Development

```sh
pnpm install
native/build.sh          # needs Go and node-api-headers; HS_ARCH=x64 cross-builds on Apple silicon
pnpm typecheck
pnpm test                # FC_RUNS=400 for deeper property runs
pnpm coverage            # keep src/ lines at 90% or more
```

The repo's [CLAUDE.md](CLAUDE.md) has the design rules, the gotchas and the release steps. `examples/guardrails/` is a complete port of a real bash guard, with its case tables in `test/`.

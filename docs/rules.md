# Rules

The TypeScript API. For the same rules without code, see [config.md](config.md).

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
- `.onDynamic('ignore')` skips targets such as `> "$f"` or `> out*.log`. The default, `'unknown'`, asks.

## Path patterns

A `PathSpec` is a glob string, a `RegExp` or a predicate. Globs use hookshot's own compiler, so they match the same on every runtime:

- `*` and `?` match within one segment, and `*` also matches dotfiles.
- `**` spans segments, and `{a,b}` gives alternatives.
- `/x` is absolute, and `~/x` is under `$HOME`.
- Any other pattern is relative to the project root (`CLAUDE_PROJECT_DIR`, else the cwd).

Paths are normalised (`.`, `..`, `~`, `$HOME`); symlinks are not resolved. A Bash target with an unquoted glob (`*`, `?`, `[`, `@(…)`, zsh `(a|b)`) is only known at run time, because bash expands it to an existing file: `> .en?` writes `.env` when that exists. So it is dynamic, like `$f`. Braces give one target per alternative (`tee {.env,x}`). [expansions.md](expansions.md) lists every expansion. After a `cd`, `pushd` or `popd` the cwd is not known any more. From then on, a relative target is only decided if every possible location gives the same answer. If not, the result is an `Unknown`.

## Actions

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

## Escalation

```ts
cmd('rm').withFlag('-r').ask('recursive delete').escalate({ after: 3, within: '10m', to: 'deny' })
```

This rule asks the first 3 times it fires in a session, then denies. A hook cannot see whether the user approved an ask, so hookshot counts *firings*, not approvals.

State is one append-only JSONL file per session, in `$CLAUDE_PLUGIN_DATA/hookshot/` or `~/.local/state/hookshot/`. Files older than 7 days are pruned. History loads only when a rule uses `escalate`. If there is no session id, or the store can't be read or written, the result is a `state-unavailable` Unknown. Pass `hooks(rules, { store })` to use another store. With `store: null`, escalating rules give that Unknown.

## From code

You can also use it from code: `hooks()` returns a `Hook` with `evaluate(command)` and `evaluateFile(target)`. `runPreToolUse(hook)` is a complete stdin-to-stdout hook entry point.

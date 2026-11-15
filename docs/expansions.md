# Shell expansions

Rules see a command after hookshot has done what the shell will do to it, as far as that is known before it runs. This page lists each expansion and what hookshot makes of it. Every row is a case in `test/expansions.test.ts`, run against the [guardrails example](../examples/guardrails/hooks.ts) (deny `rm -r` on `~` or `/`, deny `.env` writes, rewrite grep to rg).

The rule is the same everywhere: a value known only at run time is *dynamic*. A rule that could match a dynamic word gives an `Unknown`, which asks by default. A rule that cannot match it is not affected, so `mkdir $d` does not ask because of an `rm` rule.

## Words

| Expansion | Example | hookshot |
| --- | --- | --- |
| Quotes, backslashes, line continuations | `\rm`, `r''m`, `"r"m`, `r\⏎m` | removed: all are `rm` |
| ANSI-C quotes | `$'\x72m'`, `rm -rf $'~'` | dynamic |
| Brace lists | `rm -rf {~,x}`, `{rm,-rf,~}`, `tee {.env,x}` | expanded: one argv word or target per alternative |
| Brace sequences | `f{1..3}` | dynamic |
| Quoted braces | `"{~,x}"` | literal |
| `~`, `~/x` | `rm -rf ~` | the word stays `~`; as a path it is `$HOME` |
| `~+`, `~-`, `~user`, zsh `~1` | `rm -rf ~-` | dynamic (`$PWD`, `$OLDPWD`, a directory); a `~+/x` path is under the cwd |
| Quoted tilde | `\~/x`, `"~"/x` | literal: a directory named `~` |
| Parameters | `$X`, `"${X}"` | dynamic; a leading `$HOME` in a path is expanded |
| Command and arithmetic substitution | `$(…)`, `` `…` ``, `$((…))` | dynamic; the command inside is checked too |
| Process substitution | `>(cat > .env)`, zsh `=(…)` | the command inside is checked; as a path it is dynamic |
| zsh `=cmd` | `=rm -rf ~` | the command is `rm`; as a path (`> =ls`) it is dynamic |

## File targets

Bash expands globs and braces in a redirect target, and `tee` gets its arguments expanded, so a target with an unquoted glob character is dynamic: `> .en?` writes `.env` when that exists.

| Expansion | Example | hookshot |
| --- | --- | --- |
| Globs | `> .en?`, `tee .en[v]` | dynamic |
| bash extglob, zsh alternation and qualifiers | `> .@(env)`, `> (.env\|x)`, `> .env(N)` | dynamic |
| zsh extendedglob characters | `> ^x`, `> backup~`, `> a#` | dynamic, as the user's zsh may set the option |
| Escaped or quoted globs | `> ".en?"`, `> .en\?` | literal |
| Redirect forms | `&>`, `>&`, `<>`, `2>`, `{fd}>`, `>\|`, zsh `>!`, `exec > f`, more than one `>` | each target is a write |

## Commands that run commands

| Form | Example | hookshot |
| --- | --- | --- |
| Wrappers | `sudo`, `env`, `command`, `builtin`, `exec`, `nohup`, `time`, `timeout`, `nice` … | unwrapped; `.via()` sees them |
| `env -S` | `env -S 'rm -rf ~'` | `Unknown` (`opaque-wrapper`) |
| Wrapper flags that run nothing | `sudo -e grep a` (edits the files), `command -v rm` | no command; a cluster such as `-exec` is `-e -x -e -c` |
| `eval`, functions | `eval 'rm -rf ~'`, `f(){ rm -rf ~; }` | checked |
| `find -exec` | `find ~ -exec rm -rf {} \;` | checked; `{}` is dynamic (the found path) |
| `xargs` | `find ~ \| xargs rm -rf` | checked, with one dynamic word for its input appended (also with `-I`) |
| `bash -c`, `sh -c`, `zsh -c` … | `bash -c 'rm -rf ~'` | the script is parsed and checked |
| Script on stdin from text | `bash <<< '…'`, `bash <<'E'` | the script is parsed and checked; text with `$x` in it is dynamic |
| Script on stdin from elsewhere | `x \| bash`, `bash < <(curl x)`, `source <(curl x)`, `source /dev/stdin` | `Unknown` (`stdin-script`) |
| A dynamic `-c` script | `bash -c "$(…)"` | `Unknown` (`dynamic`) |
| Other shells | `fish -c`, `pwsh -c` | `Unknown` (`opaque-shell`) |

## Not seen

These pass unless a `cmd()` rule names them:

- **Program files:** `bash setup.sh`, `bash < setup.sh` and `source ~/.zshrc`. hookshot does not read files.
- **Other languages:** `python3 -c '…'`, `perl -e '…'`, `node -e '…'`, and a script piped into one of them.
- **The user's shell setup:** aliases and functions from rc files, and options such as `extendedglob`. An alias defined in the command itself (`alias x=rm; x …`) does not take effect in `bash -c` or `zsh -c`, so it is not a gap.

## Rewrites

Brace alternatives share the span of the word they came from, so `edit()` returns `null` for a span that touches a brace word. A rewrite rule then takes its fallback: in the example, `grep -{n,r} x` is a deny, not a rewrite.

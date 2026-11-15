# Config files

Rules can also live in a `hookshot.toml`, with no TypeScript. `hookshot init` writes a starter file:

```toml
#:schema https://unpkg.com/@tjakit/hookshot/schema/hookshot.schema.json
version = 1
on_unknown = "ask"   # ask, deny or allow

[[rewrite]]                      # grep -> rg by a flag table; a flag it cannot map is refused
command = ["grep", "egrep"]
to = "rg"
message = "use rg (e.g. rg PATTERN [path])"
[rewrite.flags]
"-r" = ""                        # drop
"--ignore-case" = "-i"           # rename
"-e" = false                     # no equivalent: refuse
"-A" = { to = "-A", value = "number", form = "attached" }
"--exclude" = { to = "-g", value = "any", quote = "always", prefix = "!" }

[[deny]]
command = "rm"
aliases = { "-r" = "--recursive", "-R" = "--recursive" }
flags = ["--recursive"]
args = ["/", "~", "$HOME"]
message = "refusing recursive rm on '{arg}'"

[[ask]]
pipe = { from = ["curl", "wget"], to = ["sh", "bash"] }
message = "this pipes a download into a shell"

[[deny]]
path = "/**/.env{,.*}"
except = ["/**/*.example"]
message = "refusing to write {path}"
```

- `deny`, `ask` and `note` each take a `message` and exactly one matcher: `command` (with `subcommand`, `flags`, `without_flags`, `aliases`, `value_flags`, `args`, `via`, `standalone`), `pipe`, `path` (with `op`, `except`, `on_dynamic`) or `word` (`prefix`, `unquoted`). `name` and `escalate` work as in TypeScript.
- A `rewrite` maps the leading flags of a command by its table: `""` drops a flag, a string renames it, `false` has no equivalent, and a table maps a flag with a value. `unlisted` and `after_args` choose refuse (default) or keep. A command that cannot be edited in place is refused too: one inside a quoted `bash -c` script that would need quoting changes, or one with `{a,b}` braces, whose expanded words share one span (`grep -{n,r} x`). A refusal denies (or asks, with `refuse = "ask"`) with the message and the reason. `like = "<name>"` starts from the table of an earlier rewrite.
- The `#:schema` line gives completion, hovers and errors in editors that use [Taplo](https://taplo.tamasfe.dev) (Even Better TOML) or [Tombi](https://tombi-toml.github.io/tombi/).
- `run`, `test` and `install` take a `.toml` in place of a rules file. `hookshot check hookshot.toml` validates it and lists its rules. A config that fails to parse or validate is an error naming the key path (`deny[2].flags[0]: expected string`), and `run` turns that into an ask.
- What TOML cannot say, such as a rewrite that moves arguments, stays in TypeScript. Mix the two with `hooks([...configRules('./hookshot.toml'), myRule])`. [examples/guardrails-toml](../examples/guardrails-toml) is the guardrails example written this way.

The schema itself is [schema/hookshot.schema.json](../schema/hookshot.schema.json); every key there has a description.

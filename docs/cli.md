# CLI

```text
hookshot run <rules>                     read a PreToolUse event on stdin, print the decision
hookshot test <rules> [command...]       check commands (or stdin lines) against the rules
    --tool Write --path p                check a file tool instead (--path repeats)
    --cwd dir   --json   --expect allow|ask|deny   (exit 1 on a mismatch, for CI)
hookshot check <hookshot.toml>           validate a config and list its rules (exit 1 on errors)
hookshot init [hookshot.toml]            write a starter config (never overwrites)
hookshot install <rules> [--scope user|project|local] [--runtime bun|node] [--dry-run]
hookshot uninstall <rules> [--scope ...] [--dry-run]
hookshot fetch-parser [--tag vX.Y.Z]     download the native parser for this platform
```

- `<rules>` is a `.ts`/`.js` file that `export default`s `hooks([...])`, or a `hookshot.toml`.
- `run` always exits 0. Claude Code lets a tool call through when a hook exits with any code other than 0 or 2. So when the rules file fails to load, or anything throws, `run` prints an ask.
- `install` merges one `PreToolUse` entry (matcher `Bash|Write|Edit|MultiEdit|NotebookEdit|Read`) into the settings file for the scope, in exec form, with `"onFailure": "block"`, so a hook that cannot start blocks the call. It is idempotent, writes a `.bak` first, and refuses a settings file that is not valid JSON.

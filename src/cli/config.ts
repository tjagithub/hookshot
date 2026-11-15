import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ConfigInvalid, compileConfig, parseConfig } from '../config/load.ts'
import { schemaUrl } from '../config/schema.ts'
import type { Io } from './main.ts'
import { UsageError } from './main.ts'

export const template = `#:schema ${schemaUrl}
# hookshot rules. Check them with: hookshot check hookshot.toml
# Try a command with:              hookshot test hookshot.toml 'grep -rn foo src'
version = 1
on_unknown = "ask"   # what a call hookshot cannot decide gets: ask, deny or allow

# Rewrite one command into another by a flag table; anything it cannot map is refused with the message.
[[rewrite]]
command = ["grep", "egrep"]
to = "rg"
message = "use rg (e.g. rg PATTERN [path])"
note = "rg skips .gitignored and hidden files; add -uu for grep -r behaviour"
[rewrite.flags]
"-r" = ""                 # drop
"-n" = "-n"               # keep
"-i" = "-i"
"--ignore-case" = "-i"    # rename
"-A" = { to = "-A", value = "number", form = "attached" }
"--include" = { to = "-g", value = "any", quote = "always" }

[[deny]]
command = ["sed", "gsed"]
flags = ["-i", "--in-place"]
message = "sed -i differs between BSD and GNU; use the Edit tool or perl -pi -e"

[[ask]]
pipe = { from = ["curl", "wget"], to = ["sh", "bash", "zsh"] }
message = "this pipes a download into a shell"

[[deny]]
path = "/**/.env{,.*}"
except = ["**/*.{example,sample,template}"]
message = "refusing to write {path}; ask the user to edit secrets"
`

export function checkCommand(args: string[], io: Io): number {
  const [file, ...extra] = args
  if (!file || extra.length) throw new UsageError('check needs one config file')
  try {
    const cfg = parseConfig(readFileSync(resolve(io.cwd, file), 'utf8'), file)
    const { rules } = compileConfig(cfg)
    const kinds = [...(cfg.rewrite ?? []).map(() => 'rewrite'), ...(['deny', 'ask', 'note'] as const).flatMap((s) => (cfg[s] ?? []).map(() => s))]
    for (const [i, r] of rules.entries()) io.out(`${kinds[i]!.padEnd(8)}${r.name}\n`)
    io.out(`${file}: ${rules.length} rule${rules.length === 1 ? '' : 's'}, valid\n`)
    return 0
  } catch (e) {
    if (!(e instanceof ConfigInvalid)) throw e
    for (const x of e.errors) io.err(`${file}${x.path ? `: ${x.path}` : ''}: ${x.message}\n`)
    return 1
  }
}

export function initCommand(args: string[], io: Io): number {
  const [file = 'hookshot.toml', ...extra] = args
  if (extra.length) throw new UsageError('init takes at most one file')
  const abs = resolve(io.cwd, file)
  if (existsSync(abs)) {
    io.err(`hookshot: ${file} exists; not overwriting it\n`)
    return 1
  }
  writeFileSync(abs, template)
  io.out(`wrote ${file}; check it with: hookshot check ${file}\n`)
  return 0
}

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { asking, respond } from '../claude.ts'
import { homeDir } from '../context.ts'
import { loadConfig } from '../config/load.ts'
import type { Hook } from '../hook.ts'
import { pkgName } from '../root.ts'
import { install, uninstall } from './install.ts'
import { testCommand } from './test.ts'

/** Everything the CLI touches outside itself, so tests can run it in-process. */
export interface Io {
  out(s: string): void
  err(s: string): void
  stdin(): Promise<string>
  cwd: string
  home: string
  env: Readonly<Record<string, string | undefined>>
}

export const processIo = (): Io => ({
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  async stdin() {
    let raw = ''
    for await (const chunk of process.stdin) raw += chunk
    return raw
  },
  cwd: process.cwd(),
  get home() {
    return homeDir()
  },
  env: process.env,
})

export class UsageError extends Error {}


/** A rules file `export default`s a Hook (from hooks()); a .toml file is a config (see config/load.ts). */
export async function loadHook(file: string, io: Io): Promise<Hook> {
  const abs = resolve(io.cwd, file)
  if (!existsSync(abs)) throw new UsageError(`no such rules file: ${file}`)
  if (abs.endsWith('.toml')) return loadConfig(abs)
  const mod = (await import(pathToFileURL(abs).href).catch((e: unknown) => {
    // Only when the package is the specifier that failed: node's "imported from" path can contain it too.
    if (!new RegExp(`['"]${pkgName}['"/]`).test(String(e))) throw e
    const hint = 'install it next to the rules file, or run the hook on node (`hookshot install --runtime node`), which resolves it to this CLI'
    throw new Error(`${file} imports ${pkgName}, which this runtime cannot find: ${hint}`, { cause: e })
  })) as { default?: unknown }
  const h = mod.default as Partial<Hook> | undefined
  if (!h || typeof h.evaluate !== 'function' || typeof h.evaluateFile !== 'function') {
    throw new UsageError(`${file} must \`export default hooks([...])\``)
  }
  return h as Hook
}

const usage = `hookshot: declarative Claude Code hooks

  <rules> is a .ts/.js file that exports default hooks([...]), or a hookshot.toml config.

  hookshot run <rules>                     read PreToolUse JSON on stdin, print the decision
  hookshot test <rules> [command...]       show what the rules decide (commands from stdin if none)
      --tool <Write|Edit|Read|...> --path <file>   check a file tool call instead
      --cwd <dir>  --json  --expect <allow|ask|deny>  (exit 1 when a decision differs)
  hookshot check <hookshot.toml>           validate a config and list its rules (exit 1 on errors)
  hookshot init [hookshot.toml]            write a starter config (never overwrites)
  hookshot install <rules> [--scope user|project|local] [--runtime bun|node] [--dry-run]
  hookshot uninstall <rules> [--scope user|project|local] [--dry-run]
  hookshot fetch-parser                    download the prebuilt parser for this platform
`

// Claude Code lets the call through on most non-zero exits, so a broken rules file must ask instead.
async function runCommand(rest: string[], io: Io): Promise<number> {
  let hook: Hook
  try {
    if (!rest[0]) throw new UsageError('run needs a rules file')
    hook = await loadHook(rest[0], io)
  } catch (e) {
    const why = `hookshot could not load its rules, so it cannot vouch for this call: ${e instanceof Error ? e.message : String(e)}`
    io.out(`${JSON.stringify(asking(why))}\n`)
    return 0
  }
  io.out(await respond(hook, await io.stdin()))
  return 0
}

type Command = (rest: string[], io: Io) => number | Promise<number>

const commands = new Map<string, Command>([
  ['run', runCommand],
  ['test', testCommand],
  ['check', async (rest, io) => (await import('./config.ts')).checkCommand(rest, io)],
  ['init', async (rest, io) => (await import('./config.ts')).initCommand(rest, io)],
  ['install', install],
  ['uninstall', uninstall],
  ['fetch-parser', async (rest, io) => (await import('./fetch-parser.ts')).fetchParser(rest, io)],
])

const helpNames = new Set(['-h', '--help', 'help'])

/** Usage errors (ours and parseArgs') print the usage and exit 2; anything else is rethrown. */
function usageExit(e: unknown, io: Io): number {
  const parseError = (e as { code?: unknown }).code?.toString().startsWith('ERR_PARSE_ARGS')
  if (!(e instanceof UsageError) && !parseError) throw e
  if (!(e instanceof Error)) throw e
  io.err(`hookshot: ${e.message}\n\n${usage}`)
  return 2
}

export async function main(argv: string[], io: Io = processIo()): Promise<number> {
  const [cmd, ...rest] = argv
  try {
    if (cmd === undefined || helpNames.has(cmd)) {
      io.out(usage)
      return cmd === undefined ? 2 : 0
    }
    const command = commands.get(cmd)
    if (!command) throw new UsageError(`unknown command ${cmd}`)
    return await command(rest, io)
  } catch (e) {
    return usageExit(e, io)
  }
}

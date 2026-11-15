import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { fileTools } from '../claude.ts'
import { type Io, UsageError, onPath } from './main.ts'

export const matcher = ['Bash', ...Object.keys(fileTools)].join('|')
const scopes = ['user', 'project', 'local'] as const
type Scope = (typeof scopes)[number]

interface CommandHook {
  type: 'command'
  command: string
  args?: string[]
  onFailure?: 'continue' | 'block'
}
interface MatcherGroup {
  matcher?: string
  hooks?: CommandHook[]
}
interface Settings {
  hooks?: { PreToolUse?: MatcherGroup[]; [event: string]: unknown }
  [k: string]: unknown
}

export const binPath = () => fileURLToPath(new URL('../../bin/hookshot.ts', import.meta.url))

export function settingsPath(scope: Scope, io: Io): string {
  if (scope === 'user') return join(io.home, '.claude', 'settings.json')
  return join(io.cwd, '.claude', scope === 'project' ? 'settings.json' : 'settings.local.json')
}

/** Paths inside the project become `${CLAUDE_PROJECT_DIR}/…`, so a shared settings file works on other machines. */
function portable(abs: string, scope: Scope, io: Io): string {
  const rel = relative(io.cwd, abs)
  if (scope === 'user' || rel.startsWith('..') || rel.startsWith(sep)) return abs
  return `\${CLAUDE_PROJECT_DIR}/${rel.split(sep).join('/')}`
}

const isOurs = (h: CommandHook, rules: string) => h.args?.[1] === 'run' && /hookshot\.ts$/.test(h.args[0] ?? '') && h.args[2] === rules

function read(file: string): Settings {
  if (!existsSync(file)) return {}
  const text = readFileSync(file, 'utf8')
  try {
    const v = JSON.parse(text) as unknown
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Settings
  } catch {}
  throw new UsageError(`${file} is not a JSON object; fix it by hand first (it was not changed)`)
}

function write(file: string, s: Settings, io: Io) {
  mkdirSync(dirname(file), { recursive: true })
  const had = existsSync(file)
  if (had) copyFileSync(file, `${file}.bak`)
  writeFileSync(file, `${JSON.stringify(s, null, 2)}\n`)
  io.out(`wrote ${file}${had ? ` (previous version in ${file}.bak)` : ''}\n`)
}

function parse(args: string[], io: Io, extra: Record<string, { type: 'string' | 'boolean' }> = {}) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { scope: { type: 'string', default: 'user' }, 'dry-run': { type: 'boolean', default: false }, ...extra },
  })
  const scope = values.scope as Scope
  if (!scopes.includes(scope)) throw new UsageError(`--scope must be one of ${scopes.join(', ')}`)
  if (!positionals[0]) throw new UsageError('needs a rules file')
  const abs = resolve(io.cwd, positionals[0])
  if (!existsSync(abs)) throw new UsageError(`${positionals[0]} does not exist`)
  return { values: values as Record<string, unknown>, scope, file: settingsPath(scope, io), rules: portable(abs, scope, io) }
}

export function install(args: string[], io: Io): number {
  const { values, scope, file, rules } = parse(args, io, { runtime: { type: 'string' } })
  const runtime = (values.runtime as string | undefined) ?? (onPath('bun', io.env) ? 'bun' : 'node')
  if (runtime !== 'bun' && runtime !== 'node') throw new UsageError('--runtime must be bun or node')
  const s = read(file)
  const groups = (s.hooks ??= {}).PreToolUse ??= []
  if (groups.some((g) => g.hooks?.some((h) => isOurs(h, rules)))) {
    io.out(`already installed in ${file}\n`)
    return 0
  }
  // `run` always exits 0; onFailure covers what it can't: a missing runtime, a moved file, a timeout.
  const hook: CommandHook = { type: 'command', command: runtime, args: [portable(binPath(), scope, io), 'run', rules], onFailure: 'block' }
  const entry: MatcherGroup = { matcher, hooks: [hook] }
  groups.push(entry)
  io.out(`${values['dry-run'] ? 'would add' : 'adding'} to ${file} hooks.PreToolUse:\n${JSON.stringify(entry, null, 2)}\n`)
  if (!values['dry-run']) write(file, s, io)
  return 0
}

export function uninstall(args: string[], io: Io): number {
  const { values, file, rules } = parse(args, io)
  const s = read(file)
  const groups = s.hooks?.PreToolUse ?? []
  let removed = 0
  const kept = groups.flatMap((g) => {
    const hooks = (g.hooks ?? []).filter((h) => !isOurs(h, rules))
    removed += (g.hooks?.length ?? 0) - hooks.length
    return hooks.length || !g.hooks?.length ? [{ ...g, hooks }] : []
  })
  if (!removed) {
    io.out(`not installed in ${file}\n`)
    return 0
  }
  if (s.hooks) {
    if (kept.length) s.hooks.PreToolUse = kept
    else delete s.hooks.PreToolUse
    if (!Object.keys(s.hooks).length) delete s.hooks
  }
  io.out(`${values['dry-run'] ? 'would remove' : 'removing'} ${removed} hookshot hook(s) from ${file}\n`)
  if (!values['dry-run']) write(file, s, io)
  return 0
}

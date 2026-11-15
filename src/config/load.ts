// hookshot.toml: parse (smol-toml), validate against schema.ts, then compile to the rule builders.
import { readFileSync } from 'node:fs'
import { TomlError, parse } from 'smol-toml'
import type { Context } from '../context.ts'
import type { Tri } from '../flags.ts'
import { compileGlob, globMatches } from '../glob.ts'
import { type Hook, type HookOptions, hooks } from '../hook.ts'
import { type CmdMatch, type CmdRule, cmd } from '../rules/cmd.ts'
import { type PathMatch, path } from '../rules/path.ts'
import { pipe } from '../rules/pipe.ts'
import type { Rule, Terminal } from '../rules/rule.ts'
import { word } from '../rules/word.ts'
import { duration } from '../state.ts'
import { type FlagEntry, type FlagTable, mapFlags } from '../translate/flag-map.ts'
import { type Verdict, ask, deny, edit, note, pass, rewrite } from '../verdict.ts'
import { type WordValue, couldEqual, display } from '../word.ts'
import { schema } from './schema.ts'
import { type ConfigError, validate } from './validate.ts'

type Names = string | string[]
interface Escalate {
  after: number
  within?: string
  to: 'ask' | 'deny'
  key?: string
}
interface ActionItem {
  name?: string
  message: string
  escalate?: Escalate
  command?: Names
  subcommand?: string[]
  flags?: string[]
  without_flags?: string[]
  aliases?: Record<string, string>
  value_flags?: string[]
  args?: string[]
  via?: string[]
  standalone?: boolean
  pipe?: { from: Names; to: Names }
  path?: string
  op?: 'write' | 'read' | 'any'
  except?: string[]
  on_dynamic?: 'ask' | 'ignore'
  word?: { prefix: string; unquoted?: boolean }
}
interface RewriteItem {
  name?: string
  command: Names
  to: string
  flags?: Record<string, FlagEntry>
  like?: string
  add?: string[]
  unlisted?: 'refuse' | 'keep'
  after_args?: 'refuse' | 'keep'
  refuse?: 'deny' | 'ask'
  message: string
  note?: string
  via?: string[]
  standalone?: boolean
  escalate?: Escalate
}
export interface Config {
  version: 1
  on_unknown?: 'ask' | 'deny' | 'allow'
  rewrite?: RewriteItem[]
  deny?: ActionItem[]
  ask?: ActionItem[]
  note?: ActionItem[]
}

export class ConfigInvalid extends Error {
  readonly errors: readonly ConfigError[]
  constructor(file: string, errors: ConfigError[]) {
    super(`${file}: ${errors.map((e) => (e.path ? `${e.path}: ${e.message}` : e.message)).join('; ')}`)
    this.name = 'ConfigInvalid'
    this.errors = errors
  }
}

const anywhere = { root: '/r', home: '/h' }
const sections = ['deny', 'ask', 'note'] as const

// What the schema cannot say: globs compile, durations parse, flag keys are one flag each.
function semantic(cfg: Config): ConfigError[] {
  const out: ConfigError[] = []
  const tryIt = (at: string, f: () => unknown) => {
    try {
      f()
    } catch (e) {
      out.push({ path: at, message: e instanceof Error ? e.message : String(e) })
    }
  }
  const oneFlag = (at: string, f: string) => {
    if (!/^(-[^-]|--[^=]+)$/.test(f)) out.push({ path: at, message: `${JSON.stringify(f)} is not one flag (-x or --name)` })
  }
  const esc = (at: string, e?: Escalate) => e?.within !== undefined && tryIt(`${at}.escalate.within`, () => duration(e.within!))
  for (const s of sections) {
    for (const [i, r] of (cfg[s] ?? []).entries()) {
      const at = `${s}[${i}]`
      esc(at, r.escalate)
      if (r.path !== undefined) tryIt(`${at}.path`, () => compileGlob(r.path!, anywhere))
      for (const [j, g] of (r.except ?? []).entries()) tryIt(`${at}.except[${j}]`, () => compileGlob(g, anywhere))
      for (const [j, f] of (r.value_flags ?? []).entries()) oneFlag(`${at}.value_flags[${j}]`, f)
      for (const k of Object.keys(r.aliases ?? {})) oneFlag(`${at}.aliases[${JSON.stringify(k)}]`, k)
    }
  }
  const named = new Set<string>()
  for (const [i, r] of (cfg.rewrite ?? []).entries()) {
    esc(`rewrite[${i}]`, r.escalate)
    if (r.like !== undefined && !named.has(r.like)) out.push({ path: `rewrite[${i}].like`, message: `no earlier rewrite named ${JSON.stringify(r.like)}` })
    if (r.name) named.add(r.name)
    for (const k of Object.keys(r.flags ?? {})) oneFlag(`rewrite[${i}].flags[${JSON.stringify(k)}]`, k)
  }
  return out
}

/** Parse and validate TOML text; throws ConfigInvalid with every error found. */
export function parseConfig(text: string, file = 'hookshot.toml'): Config {
  let raw: unknown
  try {
    raw = parse(text)
  } catch (e) {
    if (e instanceof TomlError) throw new ConfigInvalid(file, [{ path: '', message: `line ${e.line}, column ${e.column}: ${e.message.split('\n')[0]}` }])
    throw e
  }
  const errors = validate(raw, schema)
  if (errors.length) throw new ConfigInvalid(file, errors)
  const cfg = raw as Config
  const more = semantic(cfg)
  if (more.length) throw new ConfigInvalid(file, more)
  return cfg
}

const list = (n: Names) => (typeof n === 'string' ? [n] : n)
const fill = (m: string, vars: Record<string, string>) => m.replace(/\{(path|arg)\}/g, (all, k: string) => vars[k] ?? all)

function flagSpec(r: ActionItem) {
  const vf = r.value_flags ?? []
  return {
    ...(r.aliases ? { aliases: r.aliases } : {}),
    valueShort: vf.filter((f) => !f.startsWith('--')).map((f) => f.slice(1)).join(''),
    valueLong: vf.filter((f) => f.startsWith('--')),
  }
}

function commandRule(r: ActionItem): { rule: CmdRule; arg?: (m: CmdMatch) => string } {
  const rule = cmd(list(r.command!), ...(r.subcommand ?? [])).flags(flagSpec(r))
  if (r.flags) rule.withFlag(...r.flags)
  if (r.without_flags) rule.withoutFlag(...r.without_flags)
  if (r.via) rule.via(...r.via)
  if (r.standalone) rule.standalone()
  if (!r.args) return { rule }
  const want = r.args
  const hit = (w: WordValue): Tri => want.includes(display(w)) || (w.kind === 'dynamic' && couldEqual(w, want) ? 'unknown' : false)
  rule.arg(hit)
  const arg = (m: CmdMatch) => {
    const w = m.flags.positionals.find((p) => hit(p) === true) ?? m.flags.positionals.find((p) => hit(p) === 'unknown')
    return w ? display(w) : ''
  }
  return { rule, arg }
}

function pathRule(r: ActionItem): Terminal<PathMatch> {
  const rule = path(r.path!)
  if (r.op === 'read') rule.reads()
  else if (r.op === 'any') rule.any()
  if (r.on_dynamic === 'ignore') rule.onDynamic('ignore')
  return rule
}

type Vars<T> = (m: T, ctx: Context) => Record<string, string> | null

// The message, with {path}/{arg} filled in; vars returns null to let a match through (path except).
function finish<T>(rule: Terminal<T>, s: (typeof sections)[number], r: ActionItem, vars: Vars<T> = () => ({})): Rule {
  const verdict = { deny, ask, note }[s]
  if (r.name) rule.named(r.name)
  if (r.escalate) rule.escalate(r.escalate)
  return rule.then((m, ctx) => {
    const v = vars(m, ctx)
    return v ? verdict(rule.name, fill(r.message, v)) : pass()
  })
}

function actionRule(s: (typeof sections)[number], r: ActionItem): Rule {
  if (r.command !== undefined) {
    const { rule, arg } = commandRule(r)
    return finish(rule, s, r, arg ? (m) => ({ arg: arg(m) }) : undefined)
  }
  if (r.pipe) return finish(pipe(list(r.pipe.from), list(r.pipe.to)), s, r)
  if (r.word) {
    const { prefix, unquoted = true } = r.word
    return finish(word(`word ${prefix}`, (w) => (!unquoted || w.startsUnquoted) && display(w).startsWith(prefix)), s, r)
  }
  const except = r.except ?? []
  return finish(pathRule(r), s, r, (m, ctx) => {
    const t = m.target.path
    return t.kind === 'known' && except.some((g) => globMatches(compileGlob(g, ctx), t.abs)) ? null : { path: m.path }
  })
}

// like = "name" inherits from an earlier rewrite; parseConfig has checked that it exists.
function withLike(r: RewriteItem, earlier: ReadonlyMap<string, RewriteItem>): RewriteItem {
  const base = r.like === undefined ? undefined : earlier.get(r.like)
  if (!base) return r
  return { unlisted: base.unlisted, after_args: base.after_args, ...r, flags: { ...base.flags, ...r.flags } } as RewriteItem
}

function rewriteRule(r: RewriteItem): Rule {
  const table: FlagTable = {
    target: r.to,
    flags: r.flags ?? {},
    unlisted: r.unlisted ?? 'refuse',
    afterArgs: r.after_args ?? 'refuse',
    ...(r.add ? { add: r.add } : {}),
  }
  const rule = cmd(list(r.command)).named(r.name ?? `${list(r.command).join('|')} -> ${r.to}`)
  if (r.via) rule.via(...r.via)
  if (r.standalone) rule.standalone()
  if (r.escalate) rule.escalate(r.escalate)
  const refuse = (why: string): Verdict => (r.refuse === 'ask' ? ask : deny)(rule.name, `${r.message} (${why})`)
  return rule.then(({ inv }) => {
    const m = mapFlags(inv.argv, table)
    if (!m.ok) return refuse(m.why)
    const { argv, call } = inv
    const more = m.rest < argv.length
    const end = more ? argv[m.rest]!.start : argv.at(-1)!.end
    const e = edit(call, argv[0]!.start, end, `${[r.to, ...m.out].join(' ')}${more ? ' ' : ''}`)
    if (!e) return refuse(call.origin.kind === 'opaque' ? "inside a double-quoted or eval'd command" : 'inside a quoted command, needs quoting changes')
    return rewrite([{ ...e, rule: rule.name }], r.note ? [{ rule: rule.name, message: r.note }] : [])
  })
}

/** Rules and hook options from a parsed config, in file order: rewrite, deny, ask, note. */
export function compileConfig(cfg: Config): { rules: Rule[]; options: HookOptions } {
  const earlier = new Map<string, RewriteItem>()
  const rewrites = (cfg.rewrite ?? []).map((r) => {
    const full = withLike(r, earlier)
    if (r.name) earlier.set(r.name, full)
    return rewriteRule(full)
  })
  const rules = [...rewrites, ...sections.flatMap((s) => (cfg[s] ?? []).map((r) => actionRule(s, r)))]
  return { rules, options: cfg.on_unknown ? { onUnknown: cfg.on_unknown } : {} }
}

/** The rules of a hookshot.toml, to mix into hooks([...configRules(file), myRule]). */
export const configRules = (file: string): Rule[] => compileConfig(parseConfig(readFileSync(file, 'utf8'), file)).rules

/** A hook from a hookshot.toml; extra options override the file's. */
export function loadConfig(file: string, options: HookOptions = {}): Hook {
  const c = compileConfig(parseConfig(readFileSync(file, 'utf8'), file))
  return hooks(c.rules, { ...c.options, ...options })
}

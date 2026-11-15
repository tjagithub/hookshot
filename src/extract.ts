import type { BinaryCmd, CallExpr, Command, IfClause, Redirect, Stmt } from './ast.ts'
import { isNode, unhandled } from './ast.ts'
import { type Parsed, parse as defaultParse } from './parse.ts'
import { type WordValue, display, expandArgv, wordValue } from './word.ts'
import { commandName, findExecs, opaqueShells, parsedShells, shellScriptWord, shellStdin, stdinFiles, unwrap } from './wrappers.ts'

/** Where a script's text lives in the original command, which decides if it can be edited in place. */
export type Origin = { kind: 'top' } | { kind: 'single-quoted'; base: number } | { kind: 'opaque' }

export type UnknownWhy =
  | 'unparsed' | 'budget' | 'unsupported-syntax' | 'dynamic' | 'opaque-wrapper' | 'opaque-shell'
  | 'parser-unavailable' | 'rule-error' | 'edit-conflict' | 'state-unavailable' | 'stdin-script'
export interface Unknown {
  why: UnknownWhy
  detail: string
}

export type RedirectKind = 'write' | 'read' | 'input' | 'dup' | 'unknown'
export interface RedirectInfo {
  op: string
  kind: RedirectKind
  fd?: string
  target?: WordValue
  /** The text of a here-document (<<, <<-). For <<< the text is the target. */
  body?: WordValue
  script: number
  origin: Origin
}

export interface Call {
  id: number
  /** 0 for the command itself, then one number per nested script (`bash -c`, `eval`). */
  script: number
  words: WordValue[]
  /** NAME=value words before the command, as in `FOO=1 cmd`. */
  assigns: number
  origin: Origin
  /** Byte offset of this script in the original command; null when the origin is opaque. */
  base: number | null
  background: boolean
  negated: boolean
  redirects: RedirectInfo[]
  inSubstitution: boolean
  /** Top level, reached only through `;`, `&&`, `||`; not piped, redirected, captured, backgrounded or negated. */
  standalone: boolean
  pipeline?: { id: number; stage: number }
}

export interface Invocation {
  call: Call
  /** Words of the command that actually runs, after wrappers are stripped. */
  argv: WordValue[]
  /** Basename of argv[0]; undefined when it is not known before run time. */
  name?: string
  via: string[]
}

export interface Pipeline {
  id: number
  stages: Invocation[][]
}

export interface Extraction {
  command: string
  calls: Call[]
  invocations: Invocation[]
  pipelines: Pipeline[]
  redirects: RedirectInfo[]
  unknowns: Unknown[]
  scripts: number
}

export interface ExtractOptions {
  /** Most scripts to parse: the command plus nested `bash -c` / `eval` strings. Default 16. */
  maxScripts?: number
  parse?: (text: string) => Promise<Parsed | null>
}

const writeOps = new Set(['>', '>>', '>|', '&>', '&>>', '<>'])
const inputOps = new Set(['<<', '<<-', '<<<'])

export function classifyRedirect(op: string, target?: WordValue): RedirectKind {
  if (writeOps.has(op)) return 'write'
  if (op === '<') return 'read'
  if (inputOps.has(op)) return 'input'
  if (op === '>&' || op === '<&') {
    if (target?.kind === 'literal' && /^(\d+|-)$/.test(target.text)) return 'dup'
    return op === '>&' ? 'write' : 'read'
  }
  return 'unknown'
}

interface Ctx {
  script: number
  origin: Origin
  base: number | null
  inSubst: boolean
  stages: Invocation[][]
  pipeline?: { id: number; stage: number }
  via: string[]
  /** Where commands here read stdin from, when it is not inherited from the hook. */
  stdin?: Stdin
}

/** A statement's stdin: literal or dynamic text (<<, <<<), a file (<), a pipe, or something else (<&3). */
export type Stdin =
  | { kind: 'text'; word: WordValue }
  | { kind: 'file'; word: WordValue }
  | { kind: 'pipe' }
  | { kind: 'other'; op: string }

// The last redirect of fd 0 wins, as in the shell.
function stdinOf(redirects: readonly RedirectInfo[]): Stdin | undefined {
  let out: Stdin | undefined
  for (const r of redirects) {
    if (r.fd !== undefined && r.fd !== '0') continue
    if (r.op === '<<<' && r.target) out = { kind: 'text', word: r.target }
    else if ((r.op === '<<' || r.op === '<<-') && r.body) out = { kind: 'text', word: r.body }
    else if ((r.op === '<' || r.op === '<>') && r.target) out = { kind: 'file', word: r.target }
    else if (r.op === '<&' || r.op === '<<' || r.op === '<<-') out = { kind: 'other', op: r.op }
  }
  return out
}

const truncate = (s: string) => (s.length > 60 ? `${s.slice(0, 57)}...` : s)

export async function extract(command: string, opts: ExtractOptions = {}): Promise<Extraction> {
  const maxScripts = opts.maxScripts ?? 16
  const parseFn = opts.parse ?? defaultParse
  const out: Extraction = { command, calls: [], invocations: [], pipelines: [], redirects: [], unknowns: [], scripts: 0 }
  let pipelineIds = 0

  const unknown = (why: UnknownWhy, detail: string) => out.unknowns.push({ why, detail })

  async function parseScript(text: string): Promise<Parsed | null | 'unavailable'> {
    try {
      return await parseFn(text)
    } catch (e) {
      unknown('parser-unavailable', e instanceof Error ? e.message : String(e))
      return 'unavailable'
    }
  }

  // Walks any subtree that is not a statement list, entering only $(...) and <(...) bodies.
  async function scan(v: unknown, ctx: Ctx): Promise<void> {
    if (Array.isArray(v)) {
      for (const x of v) await scan(x, ctx)
    } else if (isNode(v)) {
      if (v.Type === 'CmdSubst' || v.Type === 'ProcSubst') {
        await walkStmts((v as { Stmts?: Stmt[] }).Stmts ?? [], { ...ctx, inSubst: true }, false)
        return
      }
      for (const [k, x] of Object.entries(v)) if (k !== 'Pos' && k !== 'End') await scan(x, ctx)
    }
  }

  async function nested(word: WordValue | string, how: string, ctx: Ctx, quotedWord?: WordValue) {
    if (out.scripts >= maxScripts) return unknown('budget', `more than ${maxScripts} scripts; ${how} not checked`)
    if (typeof word !== 'string' && word.kind === 'dynamic') return unknown('dynamic', `${how} ${word.hint}`)
    const text = typeof word === 'string' ? word : word.text
    const q = quotedWord ?? (typeof word === 'string' ? undefined : word)
    const sgl = q?.quoting === 'single' && q.word.Parts[0]?.Type === 'SglQuoted' && !q.word.Parts[0]?.Dollar
    const editable = sgl && ctx.base !== null && q !== undefined
    const origin: Origin = editable ? { kind: 'single-quoted', base: ctx.base! + q.start + 1 } : { kind: 'opaque' }
    const script = out.scripts++
    const parsed = await parseScript(text)
    if (parsed === 'unavailable') return
    if (!parsed) return unknown('unparsed', `${how} ${truncate(text)}`)
    const base = origin.kind === 'single-quoted' ? origin.base : null
    await walkStmts(parsed.file.Stmts ?? [], { ...ctx, script, origin, base, via: [...ctx.via, how] }, false)
  }

  async function invoke(argv: WordValue[], call: Call, via: string[], ctx: Ctx) {
    const u = unwrap(argv)
    const chain = [...via, ...u.via]
    if (u.kind === 'none') return
    if (u.kind === 'unknown') return unknown(u.why, u.detail)
    const name = commandName(u.argv[0])
    const inv: Invocation = name === undefined ? { call, argv: u.argv, via: chain } : { call, argv: u.argv, name, via: chain }
    out.invocations.push(inv)
    for (const stage of ctx.stages) stage.push(inv)

    if (name === 'find') for (const sub of findExecs(u.argv)) await invoke(sub, call, [...chain, 'find -exec'], ctx)
    const script = shellScriptWord(u.argv)
    if (name && script && parsedShells.has(name)) await nested(script, `${name} -c`, { ...ctx, via: chain })
    if (name && script && opaqueShells.has(name)) unknown('opaque-shell', `${name} -c is not bash or zsh`)
    const shell = name !== undefined && (parsedShells.has(name) || opaqueShells.has(name))
    if (shell && !script) await stdinScript(name, parsedShells.has(name), shellStdin(u.argv), { ...ctx, via: chain })
    if (name === 'source' || name === '.') await sourced(name, u.argv[1], { ...ctx, via: chain })
    if (name === 'eval') {
      const args = u.argv.slice(1)
      const dyn = args.find((w) => w.kind === 'dynamic')
      if (dyn) unknown('dynamic', `eval ${dyn.kind === 'dynamic' ? dyn.hint : ''}`)
      else await nested(args.map((w) => (w.kind === 'literal' ? w.text : '')).join(' '), 'eval', { ...ctx, via: chain })
    }
  }

  // A shell (or source) reading its script from stdin: literal text is parsed like -c; a pipe or a run-time file is unknown.
  // A literal file (bash < x.sh) is like bash x.sh: a program file, which hookshot does not read.
  async function stdinScript(name: string, parsed: boolean, reads: boolean | 'unknown', ctx: Ctx) {
    const src = ctx.stdin
    if (!src || reads === false) return
    if (src.kind === 'file' && src.word.kind === 'literal') return
    if (reads === 'unknown') return unknown('dynamic', `${name} with run-time flags may read its script from stdin`)
    if (src.kind === 'text') return parsed ? nested(src.word, `${name} <<`, ctx) : unknown('opaque-shell', `${name} script on stdin is not bash or zsh`)
    const from = src.kind === 'pipe' ? 'a pipe' : src.kind === 'file' ? display(src.word) : src.op
    unknown('stdin-script', `${name} reads its script from ${from}, which hookshot cannot see`)
  }

  async function sourced(name: string, file: WordValue | undefined, ctx: Ctx) {
    if (file?.kind === 'literal') return stdinFiles.has(file.text) ? stdinScript(name, true, true, ctx) : undefined
    if (file?.segments.some((s) => typeof s !== 'string' && s.dynamic === '$(…)')) unknown('dynamic', `${name} ${file.hint}`)
  }

  async function walkCall(cmd: CallExpr, stmt: Omit<Call, 'id' | 'words' | 'assigns' | 'standalone'>, alone: boolean, ctx: Ctx) {
    await scan(cmd.Assigns, ctx)
    await scan(cmd.Args, ctx)
    const words = (cmd.Args ?? []).map(wordValue)
    if (!words.length) return
    const call: Call = { ...stmt, id: out.calls.length, words, assigns: cmd.Assigns?.length ?? 0, standalone: alone }
    out.calls.push(call)
    await invoke(expandArgv(words), call, ctx.via, ctx)
  }

  async function walkIf(c: IfClause, ctx: Ctx) {
    await walkStmts(c.Cond ?? [], ctx, false)
    await walkStmts(c.Then ?? [], ctx, false)
    if (c.Else) await walkIf(c.Else, ctx)
  }

  async function walkStmts(stmts: Stmt[], ctx: Ctx, standalone: boolean) {
    for (const s of stmts) await walkStmt(s, ctx, standalone)
  }

  async function walkStmt(s: Stmt, at: Ctx, standalone: boolean): Promise<void> {
    const background = Boolean(s.Background || s.Disown || s.Coprocess)
    const negated = Boolean(s.Negated)
    const redirects = (s.Redirs ?? []).map((r: Redirect): RedirectInfo => {
      const target = r.Word ? wordValue(r.Word) : undefined
      const info: RedirectInfo = { op: r.Op, kind: classifyRedirect(r.Op, target), script: at.script, origin: at.origin }
      if (target) info.target = target
      if (r.Hdoc) info.body = wordValue(r.Hdoc)
      if (r.N?.Value) info.fd = r.N.Value
      return info
    })
    const own = stdinOf(redirects)
    const ctx: Ctx = own ? { ...at, stdin: own } : at
    out.redirects.push(...redirects)
    await scan(s.Redirs, ctx)
    const alone = standalone && !background && !negated && !redirects.length && !ctx.inSubst && ctx.origin.kind === 'top'
    const cmd = s.Cmd
    if (!cmd) return
    const stmt = { script: ctx.script, origin: ctx.origin, base: ctx.base, background, negated, redirects, inSubstitution: ctx.inSubst }
    const withPipe = ctx.pipeline ? { ...stmt, pipeline: ctx.pipeline } : stmt

    switch (cmd.Type) {
      case 'CallExpr':
        return walkCall(cmd, withPipe, alone, ctx)
      case 'BinaryCmd':
        return walkBinary(s, cmd, alone, ctx)
      case 'Subshell':
      case 'Block':
        return walkStmts(cmd.Stmts ?? [], ctx, false)
      case 'WhileClause':
        return walkStmts([...(cmd.Cond ?? []), ...(cmd.Do ?? [])], ctx, false)
      case 'IfClause':
        return walkIf(cmd, ctx)
      case 'ForClause':
        await scan(cmd.Loop, ctx)
        return walkStmts(cmd.Do ?? [], ctx, false)
      case 'CaseClause':
        await scan(cmd.Word, ctx)
        for (const item of cmd.Items ?? []) {
          await scan(item.Patterns, ctx)
          await walkStmts(item.Stmts ?? [], ctx, false)
        }
        return
      case 'FuncDecl':
        return cmd.Body ? walkStmt(cmd.Body, ctx, false) : undefined
      case 'TimeClause':
      case 'CoprocClause':
        return cmd.Stmt ? walkStmt(cmd.Stmt, ctx, false) : undefined
      case 'DeclClause':
      case 'ArithmCmd':
      case 'LetClause':
      case 'TestClause':
        return scan(cmd, ctx)
      default:
        unknown('unsupported-syntax', `command type ${unhandled(cmd)}`)
    }
  }

  // && and || walk both sides; a pipe (| or |&) flattens into one pipeline of ordered stages.
  async function walkBinary(s: Stmt, b: BinaryCmd, alone: boolean, ctx: Ctx) {
    if (b.Op === '&&' || b.Op === '||') {
      await walkStmt(b.X, ctx, alone)
      return walkStmt(b.Y, ctx, alone)
    }
    if (b.Op !== '|' && b.Op !== '|&') return void unknown('unsupported-syntax', `operator ${b.Op}`)
    const isPipe = (c: Command | null | undefined): c is BinaryCmd => c?.Type === 'BinaryCmd' && (c.Op === '|' || c.Op === '|&')
    const flat = (x: Stmt): Stmt[] => (!x.Redirs?.length && isPipe(x.Cmd) ? [...flat(x.Cmd.X), ...flat(x.Cmd.Y)] : [x])
    const pipeline: Pipeline = { id: pipelineIds++, stages: [] }
    out.pipelines.push(pipeline)
    for (const [i, stage] of flat(s).entries()) {
      const collected: Invocation[] = []
      pipeline.stages.push(collected)
      const stdin: Pick<Ctx, 'stdin'> = i > 0 ? { stdin: { kind: 'pipe' } } : {}
      await walkStmt(stage, { ...ctx, ...stdin, stages: [...ctx.stages, collected], pipeline: { id: pipeline.id, stage: i } }, false)
    }
  }

  out.scripts = 1
  const parsed = await parseScript(command)
  if (parsed === 'unavailable') return out
  if (!parsed) {
    unknown('unparsed', truncate(command))
    return out
  }
  await walkStmts(parsed.file.Stmts ?? [], { script: 0, origin: { kind: 'top' }, base: 0, inSubst: false, stages: [], via: [] }, true)
  return out
}

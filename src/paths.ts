import { posix } from 'node:path'
import type { Context } from './context.ts'
import type { Call, Extraction, Invocation } from './extract.ts'
import { parseFlags } from './flags.ts'
import { type WordValue, braceExpansion, display, unescapeBare, zshEquals } from './word.ts'

export type FileOp = 'write' | 'read'

export type PathValue =
  | { kind: 'known'; abs: string; shown: string }
  /** Relative to a directory hookshot cannot know, e.g. after `cd`. */
  | { kind: 'relative'; rel: string; shown: string }
  | { kind: 'dynamic'; shown: string }

export type FileSource = 'tool' | 'redirect' | 'tee'

/** A file a tool call reads or writes. */
export interface FileTarget {
  op: FileOp
  path: PathValue
  source: FileSource
  /** The Claude Code tool for source 'tool'. */
  tool?: string
  call?: Call
}

/** A redirect whose operator hookshot does not know: it may write anywhere. */
export interface UnclassifiedRedirect {
  op: string
}

/** Commands that change the working directory; after one, relative paths have an unknown base. */
export const dirChangers: ReadonlySet<string> = new Set(['cd', 'pushd', 'popd'])

/** Commands whose positional arguments are files they write. Others (cp, mv, sed -i) are not claimed. */
export const fileWriters: ReadonlySet<string> = new Set(['tee'])

export function resolvePath(raw: string, ctx: Context, { cwdKnown = true, tilde = true } = {}): PathValue {
  if (tilde && (raw === '~' || raw.startsWith('~/'))) return known(ctx.home + raw.slice(1), raw)
  if (tilde && (raw === '~+' || raw.startsWith('~+/'))) return { ...resolvePath(`.${raw.slice(2)}`, ctx, { cwdKnown }), shown: raw }
  if (tilde && raw.startsWith('~')) return { kind: 'dynamic', shown: raw } // ~user, ~- ($OLDPWD)
  if (raw.startsWith('/')) return known(raw, raw)
  if (cwdKnown) return known(posix.resolve(ctx.cwd, raw), raw)
  return { kind: 'relative', rel: posix.normalize(raw), shown: raw }
}
const known = (abs: string, shown: string): PathValue => ({ kind: 'known', abs: posix.normalize(abs), shown })

/** A word as a path. `$HOME` at the start is expanded (the hook runs as the same user); other holes, globs and zsh =cmd are dynamic. */
export function wordPath(w: WordValue, ctx: Context, cwdKnown = true): PathValue {
  if (w.glob || zshEquals(w)) return { kind: 'dynamic', shown: display(w) }
  const lead = w.word.Parts?.[0]
  const tilde = lead?.Type === 'Lit' && (lead.Value ?? '').startsWith('~')
  if (w.kind === 'literal') return resolvePath(w.text, ctx, { cwdKnown, tilde })
  const [first, ...rest] = w.segments
  const tail = rest.every((s) => typeof s === 'string') ? rest.join('') : undefined
  if (typeof first === 'object' && tail !== undefined) {
    if (first.dynamic === '$HOME') return resolvePath(ctx.home + tail, ctx, { cwdKnown })
    if (first.dynamic === '$PWD') return { ...resolvePath(`.${tail}`, ctx, { cwdKnown, tilde: false }), shown: w.hint }
  }
  return { kind: 'dynamic', shown: w.hint }
}

/** A Bash target word as paths: one per brace alternative (`tee {a,b}` writes both), each tilde-expanded like bash. */
export function wordPaths(w: WordValue, ctx: Context, cwdKnown = true): PathValue[] {
  const braces = braceExpansion(w)
  if (braces === undefined) return [wordPath(w, ctx, cwdKnown)]
  if (braces === 'dynamic' || w.glob) return [{ kind: 'dynamic', shown: display(w) }]
  return braces.map((raw) => (/^=[^=]/.test(raw) ? { kind: 'dynamic', shown: raw } : resolvePath(unescapeBare(raw), ctx, { cwdKnown, tilde: raw.startsWith('~') })))
}

/** Files a Bash command reads or writes, through redirects and the fileWriters table. */
export function bashTargets(x: Extraction, ctx: Context): { targets: FileTarget[]; unclassified: UnclassifiedRedirect[] } {
  const cwdKnown = !x.invocations.some((i) => i.name === undefined || dirChangers.has(i.name))
  const targets: FileTarget[] = []
  const unclassified: UnclassifiedRedirect[] = []
  // x.redirects, not call.redirects: `{ a; } > f` and `while …; done > f` belong to no call.
  for (const r of x.redirects) {
    if (r.kind === 'unknown') unclassified.push({ op: r.op })
    else if ((r.kind === 'write' || r.kind === 'read') && r.target) {
      for (const path of wordPaths(r.target, ctx, cwdKnown)) targets.push({ op: r.kind, path, source: 'redirect' })
    }
  }
  for (const inv of x.invocations) targets.push(...writerTargets(inv, ctx, cwdKnown))
  return { targets, unclassified }
}

/** Positionals of a fileWriters command (tee) as write targets; none for other commands. */
function writerTargets(inv: Invocation, ctx: Context, cwdKnown: boolean): FileTarget[] {
  if (inv.name === undefined || !fileWriters.has(inv.name)) return []
  return parseFlags(inv.argv).positionals.flatMap((w) => wordPaths(w, ctx, cwdKnown).map((path): FileTarget => ({ op: 'write', path, source: 'tee', call: inv.call })))
}

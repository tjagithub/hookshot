import { posix } from 'node:path'
import type { Context } from './context.ts'
import type { Call, Extraction } from './extract.ts'
import { parseFlags } from './flags.ts'
import { type WordValue, display } from './word.ts'

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
  if (tilde && raw.startsWith('~')) return { kind: 'dynamic', shown: raw } // ~user
  if (raw.startsWith('/')) return known(raw, raw)
  if (cwdKnown) return known(posix.resolve(ctx.cwd, raw), raw)
  return { kind: 'relative', rel: posix.normalize(raw), shown: raw }
}
const known = (abs: string, shown: string): PathValue => ({ kind: 'known', abs: posix.normalize(abs), shown })

/** A word as a path. `$HOME` at the start is expanded (the hook runs as the same user); other holes and globs are dynamic. */
export function wordPath(w: WordValue, ctx: Context, cwdKnown = true): PathValue {
  if (w.glob) return { kind: 'dynamic', shown: display(w) }
  if (w.kind === 'literal') return resolvePath(w.text, ctx, { cwdKnown, tilde: w.startsUnquoted })
  const [first, ...rest] = w.segments
  if (typeof first === 'object' && first.dynamic === '$HOME' && rest.every((s) => typeof s === 'string')) {
    return resolvePath(ctx.home + rest.join(''), ctx, { cwdKnown })
  }
  return { kind: 'dynamic', shown: w.hint }
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
      targets.push({ op: r.kind, path: wordPath(r.target, ctx, cwdKnown), source: 'redirect' })
    }
  }
  for (const inv of x.invocations) {
    if (inv.name === undefined || !fileWriters.has(inv.name)) continue
    for (const w of parseFlags(inv.argv).positionals) {
      targets.push({ op: 'write', path: wordPath(w, ctx, cwdKnown), source: 'tee', call: inv.call })
    }
  }
  return { targets, unclassified }
}

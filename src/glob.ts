import type { Tri } from './flags.ts'

/** One path segment of a glob: `**`, or a regex for a single segment. */
export type GlobSeg = '**' | RegExp

// `*` and `?` stay in one segment, `**` spans any number, `{a,b}` nests. `*` matches dotfiles,
// so a deny rule on `*.env` cannot miss `.env`. Same behaviour on every runtime.
export interface Glob {
  source: string
  /** One absolute segment list per brace alternative. */
  alternatives: GlobSeg[][]
}

const maxAlternatives = 64

export function expandBraces(p: string): string[] {
  let depth = 0
  let open = -1
  for (let i = 0; i < p.length; i++) {
    const c = p[i]
    if (c === '\\') i++
    else if (c === '{' && depth++ === 0) open = i
    else if (c === '}' && depth > 0 && --depth === 0) {
      const parts = splitAlternatives(p.slice(open + 1, i))
      if (parts.length === 1) continue // `{x}` is literal, as in bash
      const head = p.slice(0, open)
      const out = parts.flatMap((m) => expandBraces(head + m + p.slice(i + 1)))
      if (out.length > maxAlternatives) throw new Error(`glob ${p} expands to more than ${maxAlternatives} patterns`)
      return out
    }
  }
  return [p]
}

/** Splits a brace body at top-level commas, skipping escaped characters and nested braces. */
function splitAlternatives(body: string): string[] {
  const parts: string[] = []
  let d = 0
  let from = 0
  for (let j = 0; j < body.length; j++) {
    const b = body[j]
    if (b === '\\') j++
    else if (b === '{') d++
    else if (b === '}') d--
    else if (b === ',' && d === 0) {
      parts.push(body.slice(from, j))
      from = j + 1
    }
  }
  parts.push(body.slice(from))
  return parts
}

const escape = (c: string) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function segment(s: string): GlobSeg {
  if (s === '**') return '**'
  let re = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (c === '\\' && i + 1 < s.length) re += escape(s[++i]!)
    else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += escape(c)
  }
  return new RegExp(`^${re}$`, 's')
}

/** `/x` is absolute, `~/x` is under `home`, anything else is under `root` (the project). */
export function compileGlob(pattern: string, where: { root: string; home: string }): Glob {
  const alternatives = expandBraces(pattern).map((p) => {
    const abs = p.startsWith('/') ? p : p === '~' || p.startsWith('~/') ? where.home + p.slice(1) : `${where.root}/${p}`
    return abs.split('/').filter((s) => s !== '' && s !== '.').map(segment)
  })
  return { source: pattern, alternatives }
}

/** Whether path segments match glob segments exactly; backtracks to the last `**`. */
export function matchSegs(glob: readonly GlobSeg[], segs: readonly string[]): boolean {
  let g = 0
  let s = 0
  let starG = -1
  let starS = 0
  while (s < segs.length) {
    const gs = glob[g]
    if (gs === '**') {
      starG = g++
      starS = s
    } else if (gs?.test(segs[s]!)) {
      g++
      s++
    } else if (starG >= 0) {
      g = starG + 1
      s = ++starS
    } else return false
  }
  while (glob[g] === '**') g++
  return g === glob.length
}

export const pathSegs = (abs: string) => abs.split('/').filter(Boolean)

export function globMatches(glob: Glob, abs: string): boolean {
  const segs = pathSegs(abs)
  return glob.alternatives.some((a) => matchSegs(a, segs))
}

/** A relative path under an unknown directory (after `cd`): true if every directory matches, false if none can. */
export function globMatchesUnder(glob: Glob, rel: string): Tri {
  const segs = pathSegs(rel)
  let could = false
  for (const a of glob.alternatives) {
    if (a[0] === '**' && matchSegs(a.slice(1), segs)) return true
    if (a.some((_, k) => matchSegs(a.slice(k), segs))) could = true
  }
  return could ? 'unknown' : false
}

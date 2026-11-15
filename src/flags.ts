import type { WordValue } from './word.ts'

/** true, false, or 'unknown' when it depends on a word only known at run time. */
export type Tri = boolean | 'unknown'
export const and = (...xs: Tri[]): Tri => (xs.includes(false) ? false : xs.includes('unknown') ? 'unknown' : true)
export const or = (...xs: Tri[]): Tri => (xs.includes(true) ? true : xs.includes('unknown') ? 'unknown' : false)
export const not = (x: Tri): Tri => (x === 'unknown' ? x : !x)

export interface FlagSpec {
  /** Flag spellings mapped to one name, e.g. { '-r': '--recursive', '-R': '--recursive' }. */
  aliases?: Readonly<Record<string, string>>
  /** Short flags (letters) that take a value: in the same word (`-ofile`) or the next. */
  valueShort?: string
  /** Long flags that take the next word as value when written without `=`. */
  valueLong?: readonly string[]
}

export interface Flag {
  /** Canonical name: the alias target, else the flag as written (`-r`, `--force`). */
  name: string
  value?: WordValue | string
  word: WordValue
}

export interface ParsedFlags {
  flags: Flag[]
  /** Words that are, or may be, arguments rather than flags (dynamic words in maybeFlags appear here too). */
  positionals: WordValue[]
  /** Dynamic words that could turn out to be flags at run time. */
  maybeFlags: WordValue[]
}

// Assumption: a dynamic word may be a flag when its text starts with '-', or when it is unquoted and
// starts with a substitution (`$opts` can split into several words). Quoted "$x" is not.
function mayBeFlag(w: WordValue): boolean {
  if (w.kind !== 'dynamic') return false
  const first = w.segments[0]
  if (typeof first === 'string') return first.startsWith('-')
  return w.quoting === 'none' || (w.quoting === 'mixed' && w.word.Parts[0]?.Type !== 'DblQuoted')
}

interface Walk {
  argv: WordValue[]
  spec?: FlagSpec
  out: ParsedFlags
  i: number
  ended: boolean
}

const canon = (spec: FlagSpec | undefined, n: string) => spec?.aliases?.[n] ?? n

function push(walk: Walk, name: string, word: WordValue, value?: WordValue | string): void {
  walk.out.flags.push(value === undefined ? { name, word } : { name, value, word })
}

/** Takes the next word as a value when there is one. */
function nextValue(walk: Walk): WordValue | undefined {
  const next = walk.argv[walk.i + 1]
  if (next) walk.i++
  return next
}

function longFlag(walk: Walk, w: WordValue, t: string): void {
  const eq = t.indexOf('=')
  if (eq !== -1) return push(walk, canon(walk.spec, t.slice(0, eq)), w, t.slice(eq + 1))
  const value = walk.spec?.valueLong?.includes(t) ? nextValue(walk) : undefined
  push(walk, canon(walk.spec, t), w, value)
}

/** Splits `-abc` letter by letter; the first letter that takes a value ends the cluster. */
function shortCluster(walk: Walk, w: WordValue, t: string, spec: FlagSpec): void {
  const chars = [...t.slice(1)]
  for (const [k, c] of chars.entries()) {
    const name = canon(spec, `-${c}`)
    if (!spec.valueShort?.includes(c)) {
      push(walk, name, w)
      continue
    }
    push(walk, name, w, chars.slice(k + 1).join('') || nextValue(walk))
    return
  }
}

function literalStep(walk: Walk, w: WordValue, t: string): void {
  if (t === '--') walk.ended = true
  else if (t.startsWith('--') && t.length > 2) longFlag(walk, w, t)
  else if (t.startsWith('-') && t.length > 1) {
    if (walk.spec) shortCluster(walk, w, t, walk.spec)
    else push(walk, t, w)
  } else walk.out.positionals.push(w)
}

function wordStep(walk: Walk, w: WordValue): void {
  if (!walk.ended && w.kind === 'literal') return literalStep(walk, w, w.text)
  if (!walk.ended && mayBeFlag(w)) walk.out.maybeFlags.push(w) // could be either, so it is also a positional
  walk.out.positionals.push(w)
}

/** Flags of argv[1..], GNU style (flags may follow positionals, `--` ends them). Clusters split only with a spec. */
export function parseFlags(argv: WordValue[], spec?: FlagSpec): ParsedFlags {
  const walk: Walk = { argv, spec, out: { flags: [], positionals: [], maybeFlags: [] }, i: 1, ended: false }
  for (; walk.i < argv.length; walk.i++) wordStep(walk, argv[walk.i]!)
  return walk.out
}

/** Whether any of `names` is set: true when written, 'unknown' when a dynamic word could be it. */
export function hasFlag(p: ParsedFlags, ...names: string[]): Tri {
  if (p.flags.some((f) => names.includes(f.name))) return true
  return p.maybeFlags.length ? 'unknown' : false
}

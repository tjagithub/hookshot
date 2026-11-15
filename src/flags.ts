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

/** Flags of argv[1..], GNU style (flags may follow positionals, `--` ends them). Clusters split only with a spec. */
export function parseFlags(argv: WordValue[], spec?: FlagSpec): ParsedFlags {
  const out: ParsedFlags = { flags: [], positionals: [], maybeFlags: [] }
  const canon = (n: string) => spec?.aliases?.[n] ?? n
  let ended = false
  for (let i = 1; i < argv.length; i++) {
    const w = argv[i]!
    if (ended || w.kind !== 'literal') {
      if (!ended && mayBeFlag(w)) out.maybeFlags.push(w) // could be either, so it is also a positional
      out.positionals.push(w)
      continue
    }
    const t = w.text
    if (t === '--') {
      ended = true
    } else if (t.startsWith('--') && t.length > 2) {
      const eq = t.indexOf('=')
      const name = eq === -1 ? t : t.slice(0, eq)
      if (eq !== -1) out.flags.push({ name: canon(name), value: t.slice(eq + 1), word: w })
      else if (spec?.valueLong?.includes(name) && argv[i + 1]) out.flags.push({ name: canon(name), value: argv[++i]!, word: w })
      else out.flags.push({ name: canon(name), word: w })
    } else if (t.startsWith('-') && t.length > 1) {
      if (!spec) {
        out.flags.push({ name: t, word: w })
        continue
      }
      const chars = [...t.slice(1)]
      for (const [k, c] of chars.entries()) {
        const name = canon(`-${c}`)
        if (!spec.valueShort?.includes(c)) {
          out.flags.push({ name, word: w })
          continue
        }
        const rest = chars.slice(k + 1).join('')
        if (rest) out.flags.push({ name, value: rest, word: w })
        else if (argv[i + 1]) out.flags.push({ name, value: argv[++i]!, word: w })
        else out.flags.push({ name, word: w })
        break
      }
    } else {
      out.positionals.push(w)
    }
  }
  return out
}

/** Whether any of `names` is set: true when written, 'unknown' when a dynamic word could be it. */
export function hasFlag(p: ParsedFlags, ...names: string[]): Tri {
  if (p.flags.some((f) => names.includes(f.name))) return true
  return p.maybeFlags.length ? 'unknown' : false
}

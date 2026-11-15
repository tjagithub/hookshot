import type { WordValue } from '../word.ts'

/** How one flag maps: '' drops it, a string renames it, false has no equivalent, an object takes a value. */
export type FlagEntry = string | false | ValueFlag

export interface ValueFlag {
  to: string
  /** What the value may be: a whole number, anything, or one of a list. */
  value: 'number' | 'any' | readonly string[]
  /** How the value is written after `to`: -A3 (attached), -g x (separate) or --color=x (equals). */
  form?: 'attached' | 'separate' | 'equals'
  /** auto quotes a value only when the shell would read it differently; always quotes every value. */
  quote?: 'auto' | 'always'
  /** Text put before the value, e.g. '!' to turn an include glob into an exclude. */
  prefix?: string
  /** The flag may come without a value (long flags only: --color or --color=never). */
  optional?: boolean
}

export interface FlagTable {
  /** The target command, used in reasons ("no rg equivalent for -e"). */
  target: string
  /** Keys are flags as written: '-r' (short, may be clustered: -rn) or '--recursive'. */
  flags: Readonly<Record<string, FlagEntry>>
  /** A flag not in the table: refuse (default) or keep it as written. */
  unlisted?: 'refuse' | 'keep'
  /** A flag after the first argument, which this mapper does not read: refuse (default) or keep. */
  afterArgs?: 'refuse' | 'keep'
  /** Flags put before the mapped ones, e.g. fgrep -> rg -F. */
  add?: readonly string[]
}

export type FlagMapping =
  | { ok: true; out: string[]; /** argv index of the first word after the flags. */ rest: number }
  | { ok: false; why: string }

export const shQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`
const plain = /^[\w@%+=:,./-]+$/

function render(e: ValueFlag, v: string): string {
  const text = (e.prefix ?? '') + v
  const q = e.quote === 'always' || !plain.test(text) ? shQuote(text) : text
  const form = e.form ?? 'separate'
  return form === 'attached' ? `${e.to}${q}` : form === 'equals' ? `${e.to}=${q}` : `${e.to} ${q}`
}

function checkValue(flag: string, e: ValueFlag, v: string): string | undefined {
  if (e.value === 'number') return /^\d+$/.test(v) ? undefined : `${flag} needs a number`
  if (typeof e.value === 'string') return undefined
  return e.value.includes(v) ? undefined : `${flag} must be one of ${e.value.join(', ')}`
}

const needs = (flag: string, e: ValueFlag) => `${flag} needs ${e.value === 'number' ? 'a number' : 'a value'}`

// One walk over argv: out collects mapped flags, i is the word being read. Steps return a reason to refuse.
interface Walk {
  argv: readonly WordValue[]
  table: FlagTable
  out: string[]
  i: number
}

function plainFlag(w: Walk, f: string, e: FlagEntry | undefined): string | undefined {
  if (e === undefined && w.table.unlisted === 'keep') w.out.push(f)
  else if (e === undefined || e === false) return `no ${w.table.target} equivalent for ${f}`
  else if (typeof e === 'string' && e) w.out.push(e)
  return undefined
}

// The value from the next word, which must be literal.
function nextValue(w: Walk, flag: string, e: ValueFlag): string | { why: string } {
  const next = w.argv[w.i + 1]
  if (next?.kind !== 'literal') return { why: needs(flag, e) }
  w.i++
  return next.text
}

function valued(w: Walk, flag: string, e: ValueFlag, v: string | { why: string }): string | undefined {
  if (typeof v !== 'string') return v.why
  const bad = checkValue(flag, e, v)
  if (!bad) w.out.push(render(e, v))
  return bad
}

function longFlag(w: Walk, f: string): string | undefined {
  const eq = f.indexOf('=')
  const name = eq === -1 ? f : f.slice(0, eq)
  const e = w.table.flags[name]
  if (e === undefined && w.table.unlisted === 'keep') return plainFlag(w, f, e)
  if (typeof e !== 'object') return eq !== -1 && typeof e === 'string' ? `${name} takes no value` : plainFlag(w, name, e)
  if (eq !== -1) return valued(w, name, e, f.slice(eq + 1))
  if (!e.optional) return valued(w, name, e, nextValue(w, name, e))
  w.out.push(e.to)
  return undefined
}

// -abc: each letter is a flag, until one takes a value (the rest of the word, or the next word).
function shortCluster(w: Walk, f: string): string | undefined {
  const cs = [...f.slice(1)]
  for (const [k, c] of cs.entries()) {
    const flag = `-${c}`
    const e = w.table.flags[flag]
    if (typeof e !== 'object') {
      const why = plainFlag(w, flag, e)
      if (why) return why
      continue
    }
    const rest = cs.slice(k + 1).join('')
    return valued(w, flag, e, rest || nextValue(w, flag, e))
  }
  return undefined
}

/** Map the leading flags of argv (argv[0] is the command) by table; refuse rather than guess. */
export function mapFlags(argv: readonly WordValue[], table: FlagTable): FlagMapping {
  const w: Walk = { argv, table, out: [...(table.add ?? [])], i: 1 }
  let ended = false
  for (; w.i < argv.length; w.i++) {
    const word = argv[w.i]!
    if (word.kind !== 'literal' || !/^-./.test(word.text)) break
    if (word.text === '--') {
      w.out.push('--')
      ended = true
      w.i++
      break
    }
    const why = word.text.startsWith('--') ? longFlag(w, word.text) : shortCluster(w, word.text)
    if (why) return { ok: false, why }
  }
  const flagLater = argv.slice(w.i + 1).some((x) => x.kind === 'literal' && /^-./.test(x.text))
  if (!ended && table.afterArgs !== 'keep' && flagLater) return { ok: false, why: 'a flag after an argument' }
  return { ok: true, out: w.out, rest: w.i }
}

import type { DblQuoted, Lit, Word, WordPart } from './ast.ts'
import { unhandled } from './ast.ts'
import { expandBraces } from './glob.ts'

export type Quoting = 'none' | 'single' | 'double' | 'mixed'

/** A piece of a word known only at run time: $VAR, $(...), $((...)), $'...' and the like. */
export interface Hole {
  dynamic: string
}
export type Segment = string | Hole

interface Base {
  word: Word
  quoting: Quoting
  /** First part is unquoted text, e.g. `--force` but not `"--force"`. */
  startsUnquoted: boolean
  /** Unquoted * ? [ (, or zsh extendedglob ^ # and a non-leading ~: the shell may expand it to file names. */
  glob: boolean
  start: number
  end: number
}
export interface Literal extends Base {
  kind: 'literal'
  text: string
}
export interface Dynamic extends Base {
  kind: 'dynamic'
  segments: Segment[]
  /** Holes rendered as `$NAME` or `$(…)`, e.g. `$HOME/x`. */
  hint: string
}
export type WordValue = Literal | Dynamic

// Unquoted: a backslash quotes the next character; backslash-newline is a line continuation.
export const unescapeBare = (s: string) => s.replace(/\\(\n|.)/gs, (_, c: string) => (c === '\n' ? '' : c))
// In double quotes only $ ` " \ and newline are special after a backslash.
const unescapeDouble = (s: string) => s.replace(/\\([$`"\\\n])/g, (_, c: string) => (c === '\n' ? '' : c))

function holeOf(p: Exclude<WordPart, Lit | DblQuoted>): Hole {
  switch (p.Type) {
    case 'ParamExp':
      return { dynamic: `$${p.Param?.Value ?? ''}` }
    case 'CmdSubst':
    case 'ProcSubst':
      return { dynamic: '$(…)' }
    case 'ArithmExp':
      return { dynamic: '$((…))' }
    case 'SglQuoted':
      return { dynamic: "$'…'" }
    case 'ExtGlob':
    case 'BraceExp':
      return { dynamic: `<${p.Type}>` }
    default:
      return { dynamic: `<${unhandled(p)}>` }
  }
}

function segmentsOf(parts: WordPart[], inDouble: boolean): Segment[] {
  const out: Segment[] = []
  for (const p of parts) {
    if (p.Type === 'Lit') out.push((inDouble ? unescapeDouble : unescapeBare)(p.Value ?? ''))
    else if (p.Type === 'SglQuoted' && !p.Dollar) out.push(p.Value ?? '')
    else if (p.Type === 'DblQuoted') out.push(...segmentsOf(p.Parts ?? [], true))
    else out.push(holeOf(p))
  }
  return out
}

// Glob characters in unquoted raw text, skipping backslash-escaped ones (\*). ( covers bash extglob @(…) and
// zsh (a|b) and qualifiers (N); zsh options a user may set (extendedglob) make ^ # ~ globs too.
function hasGlob(parts: WordPart[]): boolean {
  const raw = parts.map((p) => (p.Type === 'Lit' ? (p.Value ?? '') : '\0')).join('')
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!
    if (c === '\\') i++
    else if ('*?[(^#'.includes(c) || (c === '~' && i > 0)) return true
  }
  return false
}

/** zsh `=name` (unquoted): the path of command name, e.g. =rm is /bin/rm. */
export const zshEquals = (w: WordValue) => {
  const first = w.word.Parts?.[0]
  return first?.Type === 'Lit' && /^=[^=]/.test(first.Value ?? '')
}

const sequence = /\{[^{}]*\.\.[^{}]*\}/

/**
 * What brace expansion makes of an unquoted word: undefined if it has none, the raw (still escaped) texts
 * when they are known, or 'dynamic' (mixed quoting, a {1..3} sequence, too many alternatives).
 */
export function braceExpansion(w: WordValue): string[] | 'dynamic' | undefined {
  const parts = w.word.Parts ?? []
  // Quoted parts stand in as x: {a,"b"} still expands, "{a,b}" does not.
  const shape = parts.map((p) => (p.Type === 'Lit' ? (p.Value ?? '') : 'x')).join('')
  let shaped: string[]
  try {
    shaped = expandBraces(shape)
  } catch {
    return 'dynamic'
  }
  if (shaped.length < 2 && !sequence.test(shape)) return undefined
  if (w.quoting !== 'none' || sequence.test(shape)) return 'dynamic'
  return shaped
}

function quotingOf(parts: WordPart[]): Quoting {
  if (parts.every((p) => p.Type === 'Lit')) return 'none'
  if (parts.length === 1 && parts[0]?.Type === 'SglQuoted') return 'single'
  if (parts.length === 1 && parts[0]?.Type === 'DblQuoted') return 'double'
  return 'mixed'
}

// A tilde-prefix other than ~ is a run-time value: ~+ is $PWD, ~- $OLDPWD, ~user and zsh ~1 a directory.
// Quoting any of it (~"x", \~x) keeps it literal.
function tildeHole(parts: WordPart[], segments: Segment[]): Segment[] {
  const first = parts[0]
  const m = first?.Type === 'Lit' ? /^~([^/\\]+)(\/|$)/.exec(first.Value ?? '') : null
  if (!m || (m[2] === '' && parts.length > 1) || typeof segments[0] !== 'string') return segments
  const name = m[1]!
  const hole = { dynamic: name === '+' ? '$PWD' : name === '-' ? '$OLDPWD' : `~${name}` }
  const rest = segments[0].slice(name.length + 1)
  return [hole, ...(rest ? [rest] : []), ...segments.slice(1)]
}

export function wordValue(word: Word): WordValue {
  const parts = word.Parts ?? []
  const segments = tildeHole(parts, segmentsOf(parts, false))
  const base: Base = {
    word,
    quoting: quotingOf(parts),
    startsUnquoted: parts[0]?.Type === 'Lit',
    glob: hasGlob(parts),
    start: word.Pos.Offset,
    end: word.End.Offset,
  }
  if (segments.every((s) => typeof s === 'string')) return { ...base, kind: 'literal', text: segments.join('') }
  const hint = segments.map((s) => (typeof s === 'string' ? s : s.dynamic)).join('')
  return { ...base, kind: 'dynamic', segments, hint }
}

const runTime = (w: WordValue, segments: Segment[]): Dynamic => {
  const hint = segments.map((s) => (typeof s === 'string' ? s : s.dynamic)).join('')
  const { word, quoting, startsUnquoted, glob, start, end } = w
  return { word, quoting, startsUnquoted, glob, start, end, kind: 'dynamic', segments, hint }
}

/** argv after brace expansion (`rm {~,x}` runs `rm ~ x`); alternatives share the span, so editing two conflicts. */
export function expandArgv(words: WordValue[]): WordValue[] {
  return words.flatMap((w) => {
    const alts = braceExpansion(w)
    if (alts === undefined) return [w]
    if (alts === 'dynamic') return [runTime(w, [{ dynamic: display(w) }])]
    return alts.map((raw) => wordValue({ ...w.word, Parts: [{ Type: 'Lit', Value: raw, Pos: w.word.Pos, End: w.word.End }] }))
  })
}

/** The words xargs appends from its input, as one run-time word after `last`. */
export const inputWord = (last: WordValue, label: string): Dynamic =>
  runTime({ ...last, word: { ...last.word, Parts: [] }, start: last.end, glob: false, startsUnquoted: false, quoting: 'none' }, [
    { dynamic: label },
  ])

/** `w` with each `token` in its literal text made a run-time hole, e.g. find's {} (the found path). */
export function withHole(w: WordValue, token: string, label: string): WordValue {
  if (w.kind !== 'literal' || !w.text.includes(token)) return w
  return runTime(w, w.text.split(token).flatMap((s, i) => (i ? [{ dynamic: label }, s] : [s])).filter((s) => s !== ''))
}

const escapeRe =(s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Whether the word could equal one of `candidates` at run time, treating each hole as any text. */
export function couldEqual(w: WordValue, candidates: Iterable<string>): boolean {
  if (w.kind === 'literal') return new Set(candidates).has(w.text)
  const re = new RegExp(`^${w.segments.map((s) => (typeof s === 'string' ? escapeRe(s) : '.*')).join('')}$`, 's')
  for (const c of candidates) if (re.test(c)) return true
  return false
}

/** The literal text, or the hint for a dynamic word. For messages, never for decisions. */
export const display = (w: WordValue) => (w.kind === 'literal' ? w.text : w.hint)

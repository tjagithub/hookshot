import type { DblQuoted, Lit, Word, WordPart } from './ast.ts'
import { unhandled } from './ast.ts'

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
const unescapeBare = (s: string) => s.replace(/\\(\n|.)/gs, (_, c: string) => (c === '\n' ? '' : c))
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

function quotingOf(parts: WordPart[]): Quoting {
  if (parts.every((p) => p.Type === 'Lit')) return 'none'
  if (parts.length === 1 && parts[0]?.Type === 'SglQuoted') return 'single'
  if (parts.length === 1 && parts[0]?.Type === 'DblQuoted') return 'double'
  return 'mixed'
}

export function wordValue(word: Word): WordValue {
  const parts = word.Parts ?? []
  const segments = segmentsOf(parts, false)
  const base: Base = {
    word,
    quoting: quotingOf(parts),
    startsUnquoted: parts[0]?.Type === 'Lit',
    start: word.Pos.Offset,
    end: word.End.Offset,
  }
  if (segments.every((s) => typeof s === 'string')) return { ...base, kind: 'literal', text: segments.join('') }
  const hint = segments.map((s) => (typeof s === 'string' ? s : s.dynamic)).join('')
  return { ...base, kind: 'dynamic', segments, hint }
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Whether the word could equal one of `candidates` at run time, treating each hole as any text. */
export function couldEqual(w: WordValue, candidates: Iterable<string>): boolean {
  if (w.kind === 'literal') return new Set(candidates).has(w.text)
  const re = new RegExp(`^${w.segments.map((s) => (typeof s === 'string' ? escapeRe(s) : '.*')).join('')}$`, 's')
  for (const c of candidates) if (re.test(c)) return true
  return false
}

/** The literal text, or the hint for a dynamic word. For messages, never for decisions. */
export const display = (w: WordValue) => (w.kind === 'literal' ? w.text : w.hint)

import type { Call, Unknown } from './extract.ts'

/** Replace bytes [start, end) of the original command with text. Offsets are UTF-8 bytes. */
export interface Edit {
  start: number
  end: number
  text: string
  rule?: string
}
export interface Reason {
  rule: string
  message: string
}
export type RuleUnknown = Unknown & { rule?: string }

/** What every rule said. combine() concatenates; resolve() applies precedence once, at the end. */
export interface Verdict {
  deny: Reason[]
  ask: Reason[]
  unknown: RuleUnknown[]
  edits: Edit[]
  notes: Reason[]
}

export const pass = (): Verdict => ({ deny: [], ask: [], unknown: [], edits: [], notes: [] })
export const deny = (rule: string, message: string): Verdict => ({ ...pass(), deny: [{ rule, message }] })
export const ask = (rule: string, message: string): Verdict => ({ ...pass(), ask: [{ rule, message }] })
export const note = (rule: string, message: string): Verdict => ({ ...pass(), notes: [{ rule, message }] })
export const unknown = (u: RuleUnknown): Verdict => ({ ...pass(), unknown: [u] })
export const rewrite = (edits: Edit[], notes: Reason[] = []): Verdict => ({ ...pass(), edits, notes })

export function combine(...vs: Verdict[]): Verdict {
  const out = pass()
  for (const v of vs) {
    out.deny.push(...v.deny)
    out.ask.push(...v.ask)
    out.unknown.push(...v.unknown)
    out.edits.push(...v.edits)
    out.notes.push(...v.notes)
  }
  return out
}

/** An edit of [start, end) in one call's script, or null when that text cannot be edited in place. */
export function edit(call: Call, start: number, end: number, text: string): Edit | null {
  if (call.base === null) return null
  if (call.origin.kind === 'single-quoted' && text.includes("'")) return null
  return { start: call.base + start, end: call.base + end, text }
}

export interface Policy {
  /** What an Unknown becomes. Default 'ask'. */
  onUnknown: 'ask' | 'deny' | 'allow'
}

export type Outcome =
  | { decision: 'deny'; reasons: Reason[] }
  | { decision: 'ask'; reasons: Reason[]; command?: string; notes: Reason[] }
  | { decision: 'allow'; command?: string; notes: Reason[] }

const sameEdit = (a: Edit, b: Edit) => a.start === b.start && a.end === b.end && a.text === b.text

/** Sorted, de-duplicated edits, or the pair that overlaps. Two inserts at one offset also conflict. */
export function orderEdits(edits: Edit[]): { ok: Edit[] } | { conflict: [Edit, Edit] } {
  const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end)
  const ok: Edit[] = []
  for (const e of sorted) {
    const prev = ok.at(-1)
    if (prev && sameEdit(prev, e)) continue
    if (prev && (e.start < prev.end || (e.start === prev.start && e.start === e.end))) return { conflict: [prev, e] }
    ok.push(e)
  }
  return { ok }
}

export function applyEdits(command: string, edits: Edit[]): string {
  const bytes = Buffer.from(command)
  let out = Buffer.alloc(0)
  let at = 0
  for (const e of edits) {
    if (e.start < at || e.end < e.start || e.end > bytes.length) throw new RangeError(`edit ${e.start}-${e.end} out of range`)
    out = Buffer.concat([out, bytes.subarray(at, e.start), Buffer.from(e.text)])
    at = e.end
  }
  return Buffer.concat([out, bytes.subarray(at)]).toString()
}

export const unknownMessage = (u: RuleUnknown) =>
  `hookshot could not check this command (${u.why}${u.rule ? `, ${u.rule}` : ''}): ${u.detail}`

export function resolve(v: Verdict, command: string, policy: Policy = { onUnknown: 'ask' }): Outcome {
  const unknowns = [...v.unknown]
  let edits: Edit[] = []
  const ordered = orderEdits(v.edits)
  if ('conflict' in ordered) {
    const [a, b] = ordered.conflict
    unknowns.push({ why: 'edit-conflict', detail: `rules ${a.rule ?? '?'} and ${b.rule ?? '?'} edit the same text` })
  } else edits = ordered.ok

  let next: string | undefined
  try {
    next = edits.length ? applyEdits(command, edits) : undefined
  } catch (e) {
    unknowns.push({ why: 'rule-error', detail: e instanceof Error ? e.message : String(e) })
  }

  const asUnknown = unknowns.map((u): Reason => ({ rule: u.rule ?? 'hookshot', message: unknownMessage(u) }))
  const denyReasons = [...v.deny, ...(policy.onUnknown === 'deny' ? asUnknown : [])]
  if (denyReasons.length) return { decision: 'deny', reasons: denyReasons }
  const notes = [...v.notes, ...(policy.onUnknown === 'allow' ? asUnknown : [])]
  const askReasons = [...v.ask, ...(policy.onUnknown === 'ask' ? asUnknown : [])]
  const changed = next !== undefined && next !== command ? { command: next } : {}
  if (askReasons.length) return { decision: 'ask', reasons: askReasons, notes, ...changed }
  return { decision: 'allow', notes, ...changed }
}

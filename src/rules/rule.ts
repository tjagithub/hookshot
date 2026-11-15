import type { Context } from '../context.ts'
import type { Extraction, Invocation } from '../extract.ts'
import type { Tri } from '../flags.ts'
import type { FileTarget } from '../paths.ts'
import { duration } from '../state.ts'
import { type Verdict, ask, combine, deny, note, pass, unknown } from '../verdict.ts'
import { describe } from '../wrappers.ts'

/** What a rule looks at: a parsed Bash command, or a file a tool (Write, Edit, Read) touches. */
export type Subject = { kind: 'bash'; x: Extraction } | { kind: 'file'; file: FileTarget }

export interface Rule {
  name: string
  check(s: Subject, ctx: Context): Verdict
}

/** A predicate over invocations, shared by cmd(), pipe() stages and custom rules. */
export interface Matcher {
  matches(inv: Invocation): Tri
}

export type Message<T> = string | ((subject: T) => string)
export type Action<T> = (subject: T, ctx: Context) => Verdict

/** The terminal step every rule builder shares: deny, ask, note or a custom verdict. */
export abstract class Terminal<T> implements Rule {
  protected action?: Action<T>
  abstract name: string

  named(name: string): this {
    this.name = name
    return this
  }
  deny(m: Message<T>): this {
    this.action = (s) => deny(this.name, typeof m === 'function' ? m(s) : m)
    return this
  }
  ask(m: Message<T>): this {
    this.action = (s) => ask(this.name, typeof m === 'function' ? m(s) : m)
    return this
  }
  note(m: Message<T>): this {
    this.action = (s) => note(this.name, typeof m === 'function' ? m(s) : m)
    return this
  }
  then(action: Action<T>): this {
    this.action = action
    return this
  }

  /** Subjects a builder does not handle pass. */
  check(s: Subject, ctx: Context): Verdict {
    return s.kind === 'bash' ? this.bash(s.x, ctx) : this.file(s.file, ctx)
  }
  protected bash(_x: Extraction, _ctx: Context): Verdict {
    return pass()
  }
  protected file(_f: FileTarget, _ctx: Context): Verdict {
    return pass()
  }

  private escalation?: { after: number; withinMs?: number; to: 'deny' | 'ask'; key?: string }

  // After `after` firings this session (within `within`), also ask or deny. A hook cannot
  // see whether the user approved an ask, so this counts firings, not refusals.
  escalate(o: { after: number; within?: string | number; to: 'deny' | 'ask'; key?: string }): this {
    if (!Number.isInteger(o.after) || o.after < 0) throw new Error(`escalate: after must be a whole number, got ${o.after}`)
    this.escalation = {
      after: o.after,
      to: o.to,
      ...(o.within !== undefined ? { withinMs: duration(o.within) } : {}),
      ...(o.key ? { key: o.key } : {}),
    }
    return this
  }
  get escalates(): boolean {
    return this.escalation !== undefined
  }

  protected act(subject: T, ctx: Context): Verdict {
    if (!this.action) throw new Error(`rule ${this.name} has no action (deny, ask, note or then)`)
    const v = this.action(subject, ctx)
    const e = this.escalation
    if (!e || isPass(v)) return v
    const h = ctx.history
    if (!h || 'unavailable' in h) {
      return combine(v, unknown({ why: 'state-unavailable', rule: this.name, detail: h?.unavailable ?? 'no session id' }))
    }
    const key = e.key ?? this.name
    const prior = h.count(key, e.withinMs)
    h.fire(key)
    if (prior < e.after) return v
    const msg = `fired ${prior + 1} times this session${e.withinMs ? ' recently' : ''}`
    return combine(v, e.to === 'deny' ? deny(this.name, msg) : ask(this.name, msg))
  }
}

const isPass = (v: Verdict) => !v.deny.length && !v.ask.length && !v.unknown.length && !v.edits.length && !v.notes.length

/** An Unknown verdict for a match that depends on run-time values. */
export const undecided = (rule: string, inv: Invocation): Verdict =>
  unknown({ why: 'dynamic', rule, detail: `depends on run-time values: ${describe(inv.argv)}` })

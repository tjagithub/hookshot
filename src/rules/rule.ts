import type { Extraction, Invocation } from '../extract.ts'
import type { Tri } from '../flags.ts'
import { type Verdict, ask, deny, note, unknown } from '../verdict.ts'
import { describe } from '../wrappers.ts'

export interface Rule {
  name: string
  check(x: Extraction): Verdict
}

/** A predicate over invocations, shared by cmd(), pipe() stages and custom rules. */
export interface Matcher {
  matches(inv: Invocation): Tri
}

export type Message<T> = string | ((subject: T) => string)
export type Action<T> = (subject: T, x: Extraction) => Verdict

/** The terminal step every rule builder shares: deny, ask, note or a custom verdict. */
export abstract class Terminal<T> {
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
  protected act(subject: T, x: Extraction): Verdict {
    if (!this.action) throw new Error(`rule ${this.name} has no action (deny, ask, note or then)`)
    return this.action(subject, x)
  }
}

/** An Unknown verdict for a match that depends on run-time values. */
export const undecided = (rule: string, inv: Invocation): Verdict =>
  unknown({ why: 'dynamic', rule, detail: `depends on run-time values: ${describe(inv.argv)}` })

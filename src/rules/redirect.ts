import type { Extraction, RedirectInfo, RedirectKind } from '../extract.ts'
import { type Verdict, combine, pass, unknown } from '../verdict.ts'
import type { Rule } from './rule.ts'
import { Terminal } from './rule.ts'

export type TargetSpec = RegExp | string | ((path: string) => boolean)

const test = (t: TargetSpec, path: string) =>
  typeof t === 'string' ? path === t : t instanceof RegExp ? t.test(path) : t(path)

/** A redirect whose target matches: `> .env`, `>> ~/.zshrc`. Writes by default; see reads() and any(). */
export class RedirectRule extends Terminal<RedirectInfo> implements Rule {
  name: string
  private kinds: ReadonlySet<RedirectKind> = new Set(['write'])
  private dynamic: 'unknown' | 'ignore' = 'unknown'

  private readonly target: TargetSpec

  constructor(target: TargetSpec) {
    super()
    this.target = target
    this.name = `redirect ${String(target)}`
  }

  writes(): this {
    this.kinds = new Set(['write'])
    return this
  }
  reads(): this {
    this.kinds = new Set(['read'])
    return this
  }
  any(): this {
    this.kinds = new Set(['write', 'read'])
    return this
  }
  /** A target such as "$out" could be anything. Default 'unknown' (the policy decides); 'ignore' skips it. */
  onDynamic(mode: 'unknown' | 'ignore'): this {
    this.dynamic = mode
    return this
  }

  check(x: Extraction): Verdict {
    const out: Verdict[] = []
    for (const r of x.redirects) {
      if (r.kind === 'unknown') {
        out.push(unknown({ why: 'unsupported-syntax', rule: this.name, detail: `redirect operator ${r.op}` }))
        continue
      }
      if (!this.kinds.has(r.kind) || !r.target) continue
      if (r.target.kind === 'literal') {
        if (test(this.target, r.target.text)) out.push(this.act(r, x))
      } else if (this.dynamic === 'unknown') {
        out.push(unknown({ why: 'dynamic', rule: this.name, detail: `redirect target ${r.target.hint}` }))
      }
    }
    return out.length ? combine(...out) : pass()
  }
}

export const redirect = (target: TargetSpec) => new RedirectRule(target)

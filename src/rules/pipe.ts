import type { Extraction, Invocation, Pipeline } from '../extract.ts'
import { type Tri, and, or } from '../flags.ts'
import type { Context } from '../context.ts'
import { type Verdict, combine, pass, unknown } from '../verdict.ts'
import { cmd } from './cmd.ts'
import { type Matcher, type Rule, Terminal } from './rule.ts'

export type StageSpec = string | readonly string[] | Matcher

export interface PipeMatch {
  pipeline: Pipeline
  from: Invocation
  to: Invocation
}

const toMatcher = (s: StageSpec): Matcher => (typeof s === 'string' || Array.isArray(s) ? cmd(s as string[]) : (s as Matcher))

/** `from` feeds `to` in one pipeline, at any distance: curl | tee | sudo bash. */
export class PipeRule extends Terminal<PipeMatch> implements Rule {
  name: string
  private readonly from: Matcher
  private readonly to: Matcher

  constructor(from: StageSpec, to: StageSpec) {
    super()
    this.from = toMatcher(from)
    this.to = toMatcher(to)
    const label = (s: StageSpec) => (typeof s === 'string' ? s : Array.isArray(s) ? s.join('|') : 'matcher')
    this.name = `pipe ${label(from)} -> ${label(to)}`
  }

  protected override bash(x: Extraction, ctx: Context): Verdict {
    const out: Verdict[] = []
    for (const pipeline of x.pipelines) {
      let found: PipeMatch | undefined
      let maybe: Tri = false
      for (const [i, left] of pipeline.stages.entries()) {
        for (const right of pipeline.stages.slice(i + 1)) {
          for (const a of left) {
            for (const b of right) {
              const t = and(this.from.matches(a), this.to.matches(b))
              if (t === true) found ??= { pipeline, from: a, to: b }
              maybe = or(maybe, t)
            }
          }
        }
      }
      if (found) out.push(this.act(found, ctx))
      else if (maybe === 'unknown') {
        out.push(unknown({ why: 'dynamic', rule: this.name, detail: 'a pipeline stage is only known at run time' }))
      }
    }
    return out.length ? combine(...out) : pass()
  }
}

export const pipe = (from: StageSpec, to: StageSpec) => new PipeRule(from, to)

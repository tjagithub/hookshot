import type { Extraction, Invocation } from '../extract.ts'
import { type FlagSpec, type ParsedFlags, type Tri, and, hasFlag, not, or, parseFlags } from '../flags.ts'
import type { Context } from '../context.ts'
import { type Verdict, combine, pass } from '../verdict.ts'
import type { WordValue } from '../word.ts'
import { type Matcher, type Rule, Terminal, undecided } from './rule.ts'

/** What a cmd() action receives: the invocation and its parsed flags. */
export interface CmdMatch {
  inv: Invocation
  flags: ParsedFlags
}

type Cond = (m: CmdMatch) => Tri

export class CmdRule extends Terminal<CmdMatch> implements Rule, Matcher {
  name: string
  private spec?: FlagSpec
  private readonly conds: Cond[] = []

  private readonly names: ReadonlySet<string>
  private readonly sub: readonly string[]

  constructor(names: ReadonlySet<string>, sub: readonly string[]) {
    super()
    this.names = names
    this.sub = sub
    this.name = [[...names].join('|'), ...sub].join(' ')
  }

  /** How to read this command's flags: aliases and which flags take a value. */
  flags(spec: FlagSpec): this {
    this.spec = spec
    return this
  }
  withFlag(...names: string[]): this {
    return this.where(({ flags }) => hasFlag(flags, ...names))
  }
  withoutFlag(...names: string[]): this {
    return this.where(({ flags }) => not(hasFlag(flags, ...names)))
  }
  /** Some positional argument satisfies pred. */
  arg(pred: (w: WordValue, index: number) => Tri): this {
    return this.where(({ flags }) => or(...flags.positionals.map((w, i) => pred(w, i))))
  }
  /** Run through one of these wrappers (`sudo`, `xargs`, `bash -c` ...). */
  via(...wrappers: string[]): this {
    return this.where(({ inv }) => inv.via.some((v) => wrappers.includes(v)))
  }
  /** Top level, not piped, captured, redirected, backgrounded, negated or wrapped. */
  standalone(): this {
    return this.where(({ inv }) => inv.call.standalone && inv.via.length === 0)
  }
  where(cond: Cond): this {
    this.conds.push(cond)
    return this
  }

  private matchOf(inv: Invocation): { tri: Tri; m: CmdMatch } {
    const flags = parseFlags(inv.argv, this.spec)
    const m = { inv, flags }
    const name: Tri = inv.name === undefined ? 'unknown' : this.names.has(inv.name)
    if (name === false) return { tri: false, m }
    const sub = this.sub.map((s, i): Tri => {
      const w = flags.positionals[i]
      if (!w) return false
      return w.kind === 'literal' ? w.text === s : 'unknown'
    })
    return { tri: and(name, ...sub, ...this.conds.map((c) => c(m))), m }
  }

  matches(inv: Invocation): Tri {
    return this.matchOf(inv).tri
  }

  protected override bash(x: Extraction, ctx: Context): Verdict {
    const out: Verdict[] = []
    for (const inv of x.invocations) {
      const { tri, m } = this.matchOf(inv)
      if (tri === true) out.push(this.act(m, ctx))
      else if (tri === 'unknown') out.push(undecided(this.name, inv))
    }
    return out.length ? combine(...out) : pass()
  }
}

/** A rule on commands named `names` (basename), optionally with subcommands: cmd('git', 'push'). */
export function cmd(names: string | readonly string[], ...subcommands: string[]): CmdRule {
  return new CmdRule(new Set(typeof names === 'string' ? [names] : names), subcommands)
}

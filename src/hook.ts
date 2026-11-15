import { type ExtractOptions, type Extraction, extract } from './extract.ts'
import type { Rule } from './rules/rule.ts'
import { type Outcome, type Policy, type Verdict, combine, resolve, unknown } from './verdict.ts'

export interface HookOptions extends ExtractOptions {
  /** What a command hookshot cannot decide becomes. Default 'ask'. */
  onUnknown?: Policy['onUnknown']
}

export interface Evaluation {
  outcome: Outcome
  verdict: Verdict
  extraction: Extraction
}

export interface Hook {
  readonly rules: readonly Rule[]
  readonly options: Readonly<HookOptions>
  evaluate(command: string): Promise<Evaluation>
}

/** Every rule sees every command; a rule that throws counts as Unknown, not as a pass. */
export function hooks(rules: readonly Rule[], options: HookOptions = {}): Hook {
  const policy: Policy = { onUnknown: options.onUnknown ?? 'ask' }
  return {
    rules,
    options,
    async evaluate(command) {
      const extraction = await extract(command, options)
      const fromExtraction = extraction.unknowns.map((u) => unknown(u))
      const fromRules = rules.map((r) => {
        try {
          return r.check(extraction)
        } catch (e) {
          return unknown({ why: 'rule-error', rule: r.name, detail: e instanceof Error ? e.message : String(e) })
        }
      })
      const verdict = combine(...fromExtraction, ...fromRules)
      return { outcome: resolve(verdict, command, policy), verdict, extraction }
    },
  }
}

import { type Context, context } from './context.ts'
import { type ExtractOptions, type Extraction, extract } from './extract.ts'
import type { FileTarget } from './paths.ts'
import { type Rule, type Subject, Terminal } from './rules/rule.ts'
import { type Store, fileStore } from './state.ts'
import { type Outcome, type Policy, type Verdict, combine, resolve, unknown } from './verdict.ts'

export interface HookOptions extends ExtractOptions {
  /** What a command hookshot cannot decide becomes. Default 'ask'. */
  onUnknown?: Policy['onUnknown']
  /** Where escalating rules keep counts. Default: a file store (see state.ts); null disables it. */
  store?: Store | null
}

export interface Evaluation {
  outcome: Outcome
  verdict: Verdict
  /** Present for Bash commands. */
  extraction?: Extraction
}

export interface Hook {
  readonly rules: readonly Rule[]
  readonly options: Readonly<HookOptions>
  evaluate(command: string, ctx?: Partial<Context>): Promise<Evaluation & { extraction: Extraction }>
  evaluateFile(file: FileTarget, ctx?: Partial<Context>): Promise<Evaluation>
}

/** Every rule sees every subject; a rule that throws counts as Unknown, not as a pass. */
export function hooks(rules: readonly Rule[], options: HookOptions = {}): Hook {
  const policy: Policy = { onUnknown: options.onUnknown ?? 'ask' }
  const escalating = rules.some((r) => r instanceof Terminal && r.escalates)
  let store: Store | null | undefined = options.store

  function prepare(over: Partial<Context> = {}): Context {
    const ctx = context(over)
    if (!escalating || ctx.history) return ctx
    store ??= options.store === null ? null : fileStore()
    if (!store) ctx.history = { unavailable: 'no state store' }
    else if (!ctx.sessionId) ctx.history = { unavailable: 'no session id' }
    else ctx.history = store.load(ctx.sessionId)
    return ctx
  }

  function run(s: Subject, ctx: Context): Verdict[] {
    const out = rules.map((r) => {
      try {
        return r.check(s, ctx)
      } catch (e) {
        return unknown({ why: 'rule-error', rule: r.name, detail: e instanceof Error ? e.message : String(e) })
      }
    })
    const h = ctx.history
    if (store && ctx.sessionId && h && 'pending' in h && h.pending.length) {
      try {
        store.save(ctx.sessionId, h.pending)
      } catch (e) {
        out.push(unknown({ why: 'state-unavailable', detail: `cannot save state: ${e instanceof Error ? e.message : String(e)}` }))
      }
    }
    return out
  }

  return {
    rules,
    options,
    async evaluate(command, over) {
      const extraction = await extract(command, options)
      const fromExtraction = extraction.unknowns.map((u) => unknown(u))
      const verdict = combine(...fromExtraction, ...run({ kind: 'bash', x: extraction }, prepare(over)))
      return { outcome: resolve(verdict, command, policy), verdict, extraction }
    },
    async evaluateFile(file, over) {
      const verdicts = run({ kind: 'file', file }, prepare(over)).map((v) =>
        v.edits.length ? unknown({ why: 'rule-error', rule: v.edits[0]?.rule, detail: 'a rewrite on a file tool' }) : v,
      )
      const verdict = combine(...verdicts)
      return { outcome: resolve(verdict, '', policy), verdict }
    },
  }
}

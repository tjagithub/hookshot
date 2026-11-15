import type { Call, Extraction } from '../extract.ts'
import type { Tri } from '../flags.ts'
import { type Verdict, combine, pass, unknown } from '../verdict.ts'
import type { WordValue } from '../word.ts'
import { type Rule, Terminal } from './rule.ts'

export interface WordMatch {
  word: WordValue
  call: Call
}

/** Any word of any command, wrappers included: e.g. an unquoted `--force` anywhere. */
export class WordRule extends Terminal<WordMatch> implements Rule {
  name: string
  private readonly pred: (w: WordValue, call: Call) => Tri

  constructor(name: string, pred: (w: WordValue, call: Call) => Tri) {
    super()
    this.name = name
    this.pred = pred
  }

  check(x: Extraction): Verdict {
    const out: Verdict[] = []
    for (const call of x.calls) {
      for (const w of call.words) {
        const t = this.pred(w, call)
        if (t === true) out.push(this.act({ word: w, call }, x))
        else if (t === 'unknown') out.push(unknown({ why: 'dynamic', rule: this.name, detail: `word ${w.kind === 'dynamic' ? w.hint : w.text}` }))
      }
    }
    return out.length ? combine(...out) : pass()
  }
}

export const word = (name: string, pred: (w: WordValue, call: Call) => Tri) => new WordRule(name, pred)

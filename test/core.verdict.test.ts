import { fc, test } from '@fast-check/vitest'
import { describe, expect } from 'vitest'
import { type Edit, type Policy, type Verdict, applyEdits, ask, combine, deny, note, orderEdits, pass, resolve, rewrite, unknown } from '../src/verdict.ts'

const verdict: fc.Arbitrary<Verdict> = fc.oneof(
  fc.constant(pass()),
  fc.constant(deny('r', 'no')),
  fc.constant(ask('r', 'sure?')),
  fc.constant(note('r', 'fyi')),
  fc.constant(unknown({ why: 'dynamic', detail: '$x' })),
  fc.nat({ max: 3 }).map((n) => rewrite([{ start: n, end: n + 1, text: 'X', rule: 'w' }])),
)
const policy = fc.constantFrom<Policy>({ onUnknown: 'ask' }, { onUnknown: 'deny' }, { onUnknown: 'allow' })
const cmd = 'abcdefgh'
const decision = (v: Verdict, p: Policy) => resolve(v, cmd, p).decision

describe('combine and resolve', () => {
  test.prop([verdict, verdict, policy])('order does not change the decision', (a, b, p) => {
    expect(decision(combine(a, b), p)).toBe(decision(combine(b, a), p))
  })
  test.prop([verdict, verdict, verdict, policy])('grouping does not change the outcome', (a, b, c, p) => {
    expect(resolve(combine(combine(a, b), c), cmd, p)).toEqual(resolve(combine(a, combine(b, c)), cmd, p))
  })
  test.prop([fc.array(verdict), policy])('deny wins over everything', (vs, p) => {
    expect(decision(combine(deny('r', 'no'), ...vs), p)).toBe('deny')
  })
  test.prop([fc.array(verdict), policy])('pass changes nothing', (vs, p) => {
    expect(resolve(combine(pass(), ...vs), cmd, p)).toEqual(resolve(combine(...vs), cmd, p))
  })

  test.each([
    ['ask', 'ask'],
    ['deny', 'deny'],
    ['allow', 'allow'],
  ] as const)('an Unknown under onUnknown=%s becomes %s', (onUnknown, want) => {
    const out = resolve(unknown({ why: 'unparsed', detail: 'x' }), cmd, { onUnknown })
    expect(out.decision).toBe(want)
    if (out.decision !== 'deny') expect(out.notes.length).toBe(onUnknown === 'allow' ? 1 : 0)
  })

  test('ask keeps the rewrite, so the user sees the new command', () => {
    expect(resolve(combine(ask('r', '?'), rewrite([{ start: 0, end: 1, text: 'Z' }])), cmd)).toEqual({
      decision: 'ask',
      reasons: [{ rule: 'r', message: '?' }],
      notes: [],
      command: 'Zbcdefgh',
    })
  })

  test('overlapping edits are an Unknown, not a guess', () => {
    const v = rewrite([{ start: 0, end: 3, text: 'x', rule: 'a' }, { start: 2, end: 4, text: 'y', rule: 'b' }])
    const out = resolve(v, cmd)
    expect(out.decision).toBe('ask')
    expect(out.decision === 'ask' && out.reasons[0]?.message).toMatch(/\(edit-conflict\): rules a and b/)
  })

  test('identical edits from two rules count once; two inserts at one offset conflict', () => {
    const e: Edit = { start: 1, end: 2, text: 'Q' }
    expect(orderEdits([e, { ...e }])).toEqual({ ok: [e] })
    expect('conflict' in orderEdits([{ start: 1, end: 1, text: 'a' }, { start: 1, end: 1, text: 'b' }])).toBe(true)
  })

  test('an out-of-range edit is an Unknown', () => {
    expect(resolve(rewrite([{ start: 5, end: 99, text: '' }]), cmd).decision).toBe('ask')
  })
})

describe('applyEdits', () => {
  const edits = (text: string) => {
    // Parser offsets fall on code point boundaries, so cuts do too.
    const bounds = [0, ...[...text].map((_, i, cs) => Buffer.byteLength(cs.slice(0, i + 1).join('')))]
    return fc
      .uniqueArray(fc.constantFrom(...bounds), { maxLength: 6 })
      .map((cuts) => cuts.sort((a, b) => a - b))
      .chain((cuts) =>
        fc.tuple(...cuts.map(() => fc.string({ maxLength: 3 }))).map((texts) =>
          cuts.flatMap((c, i): Edit[] => (i % 2 === 0 && cuts[i + 1] !== undefined ? [{ start: c, end: cuts[i + 1]!, text: texts[i]! }] : [])),
        ),
      )
  }
  const text = fc.string({ unit: 'grapheme', maxLength: 20 })

  test.prop([text.chain((t) => fc.tuple(fc.constant(t), edits(t)))])(
    'bytes outside the edited spans are unchanged, in order',
    ([t, es]) => {
      const out = Buffer.from(applyEdits(t, es))
      const src = Buffer.from(t)
      let at = 0
      let o = 0
      for (const e of es) {
        expect(out.subarray(o, o + (e.start - at))).toEqual(src.subarray(at, e.start))
        o += e.start - at + Buffer.byteLength(e.text)
        at = e.end
      }
      expect(out.subarray(o)).toEqual(src.subarray(at))
    },
  )
})

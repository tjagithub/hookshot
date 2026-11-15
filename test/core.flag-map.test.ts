import { fc, test as prop } from '@fast-check/vitest'
import { describe, expect, test } from 'vitest'
import type { Word } from '../src/ast.ts'
import { parse } from '../src/parse.ts'
import { type FlagTable, mapFlags } from '../src/translate/flag-map.ts'
import { type WordValue, wordValue } from '../src/word.ts'
import { numRuns } from './support/arbitraries.ts'

async function argv(src: string) {
  const p = await parse(src)
  return ((p?.file.Stmts?.[0]?.Cmd as { Args?: Word[] }).Args ?? []).map(wordValue)
}

const table: FlagTable = {
  target: 'new',
  flags: {
    '-d': '',
    '-k': '-k',
    '-r': '--renamed',
    '-x': false,
    '--long': '-L',
    '--drop': '',
    '-n': { to: '-N', value: 'number', form: 'attached' },
    '-g': { to: '-G', value: 'any', quote: 'always' },
    '--ex': { to: '-G', value: 'any', prefix: '!' },
    '--mode': { to: '--mode', value: ['a', 'b'], form: 'equals', optional: true },
  },
}

describe('mapFlags', () => {
  test.each([
    ['old -d -k x', [], ['-k'], 3],
    ['old -dkr x', [], ['-k', '--renamed'], 2],
    ['old --long x', [], ['-L'], 2],
    ['old -n3 -n 4 -kn5 x', [], ['-N3', '-N4', '-k', '-N5'], 5],
    ['old -g *.ts -gfoo', [], ["-G '*.ts'", "-G 'foo'"], 4],
    ['old --ex=a.b --ex "a b"', [], ["-G '!a.b'", "-G '!a b'"], 4],
    ['old --mode --mode=b x', [], ['--mode', '--mode=b'], 3],
    ['old -- -x', [], ['--'], 2],
    ['old "$p" x', [], [], 1],
    ['old -k', ['-F'], ['-F', '-k'], 2],
  ])('%s', async (src, add, out, rest) => {
    expect(mapFlags(await argv(src), { ...table, add })).toEqual({ ok: true, out, rest })
  })

  test.each([
    ['old -x', 'no new equivalent for -x'],
    ['old -z', 'no new equivalent for -z'],
    ['old --nope', 'no new equivalent for --nope'],
    ['old -n x', '-n needs a number'],
    ['old -n', '-n needs a number'],
    ['old -g', '-g needs a value'],
    ['old -g "$v"', '-g needs a value'],
    ['old --mode=c', '--mode must be one of a, b'],
    ['old --long=1', '--long takes no value'],
    ['old --drop=1', '--drop takes no value'],
    ['old x -k', 'a flag after an argument'],
  ])('%s refuses: %s', async (src, why) => {
    expect(mapFlags(await argv(src), table)).toEqual({ ok: false, why })
  })

  test('unlisted keep and afterArgs keep pass flags through as written', async () => {
    const keep: FlagTable = { ...table, unlisted: 'keep', afterArgs: 'keep' }
    expect(mapFlags(await argv('old -z --nope=1 -k x -k'), keep)).toEqual({ ok: true, out: ['-z', '--nope=1', '-k'], rest: 4 })
  })
})

const lit = (text: string): WordValue => ({ kind: 'literal', text, start: 0, end: text.length, quoting: 'none' }) as WordValue

// Any argv either maps or gives a reason; renames and drops of a known table are exact.
prop.prop([fc.array(fc.constantFrom('-d', '-k', '-r', '-x', '-z', '-dk', '--long', '-n', '7', 'pat', '--'), { maxLength: 6 })], {
  numRuns,
})('maps or refuses, never throws', (words) => {
  const r = mapFlags([lit('old'), ...words.map(lit)], table)
  if (!r.ok) {
    expect(r.why).toMatch(/equivalent|needs|after an argument/)
    return
  }
  expect(r.rest).toBeGreaterThanOrEqual(1)
  expect(r.rest).toBeLessThanOrEqual(words.length + 1)
  for (const o of r.out) expect(['-k', '--renamed', '-L', '--', '-N7']).toContain(o)
})

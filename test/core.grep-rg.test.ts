import { describe, expect, test } from 'vitest'
import type { Word } from '../src/ast.ts'
import { parse } from '../src/parse.ts'
import { grepToRg, shQuote } from '../src/translate/grep-rg.ts'
import { wordValue } from '../src/word.ts'

async function argv(src: string) {
  const p = await parse(src)
  return ((p?.file.Stmts?.[0]?.Cmd as { Args?: Word[] }).Args ?? []).map(wordValue)
}

describe('grepToRg', () => {
  test.each([
    ['grep -rn foo .', ['-n'], 2],
    ['grep -Rin foo', ['-i', '-n'], 2],
    ['fgrep -l x', ['-F', '-l'], 2],
    ['grep -A3 -B 2 -C1 x f', ['-A3', '-B2', '-C1'], 5],
    ['grep -nA 3 x', ['-n', '-A3'], 3],
    ['grep --include=*.ts --exclude-dir=node_modules x', ["-g '*.ts'", "-g '!node_modules'"], 3],
    ['grep --color=never --ignore-case x', ['--color=never', '-i'], 3],
    ['grep -- -x f', ['--'], 2],
    ['grep "$p" f', [], 1],
  ])('%s', async (src, rgFlags, rest) => {
    expect(grepToRg(await argv(src))).toEqual({ ok: true, rgFlags, rest })
  })

  test.each([
    ['grep -z x', 'no rg equivalent for -z'],
    ['grep -e x f', 'no rg equivalent for -e'],
    ['grep --null x', 'no rg equivalent for --null'],
    ['grep -Ax f', '-A needs a number'],
    ['grep -A $n f', '-A needs a number'],
    ['grep -m', '-m needs a number'],
    ['grep x f -i', 'a flag after an argument'],
  ])('%s fails: %s', async (src, why) => {
    expect(grepToRg(await argv(src))).toEqual({ ok: false, why })
  })

  test('shQuote survives single quotes', () => {
    expect(shQuote("it's")).toBe(`'it'\\''s'`)
  })
})

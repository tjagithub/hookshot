import { fc, test } from '@fast-check/vitest'
import { describe, expect } from 'vitest'
import type { Word } from '../src/ast.ts'
import { hasFlag, parseFlags } from '../src/flags.ts'
import { parse } from '../src/parse.ts'
import { couldEqual, display, wordValue } from '../src/word.ts'
import { unwrap } from '../src/wrappers.ts'

/** Words of the first command in `src`. */
async function words(src: string) {
  const p = await parse(src)
  const call = p?.file.Stmts?.[0]?.Cmd as { Args?: Word[] } | undefined
  return (call?.Args ?? []).map(wordValue)
}

describe('wordValue', () => {
  test.each([
    ['a\\ b', 'a b', 'none'],
    ['\\-\\-force', '--force', 'none'],
    ["'it''s'", 'its', 'mixed'],
    ['"a\\"b\\$c\\d"', 'a"b$c\\d', 'double'],
    ["''", '', 'single'],
    ['--"force"', '--force', 'mixed'],
  ])('%s is the literal %s (%s)', async (src, text, quoting) => {
    const [, w] = await words(`x ${src}`)
    expect(w).toMatchObject({ kind: 'literal', text, quoting })
  })

  test.each([
    ['$HOME/x', '$HOME/x'],
    ['"${HOME}"/', '$HOME/'],
    ['$(pwd)/a', '$(…)/a'],
    ["$'a\\nb'", "$'…'"],
    ['$((1+2))', '$((…))'],
  ])('%s is dynamic with hint %s', async (src, hint) => {
    const [, w] = await words(`x ${src}`)
    expect(w).toMatchObject({ kind: 'dynamic', hint })
  })

  test('couldEqual treats holes as any text', async () => {
    const [, a, b, c] = await words('x "$X" "$X/*" "$tmp/build"')
    expect(couldEqual(a!, ['/'])).toBe(true)
    expect(couldEqual(b!, ['/*'])).toBe(true)
    expect(couldEqual(c!, ['/', '/*', '~'])).toBe(false)
  })

  test.prop([fc.string({ maxLength: 20 }).filter((s) => !s.includes("'") && !s.includes('\0'))])(
    "'text' is always the literal text",
    async (s) => {
      const [, w] = await words(`x '${s}'`)
      expect(w).toMatchObject({ kind: 'literal', text: s, quoting: 'single', startsUnquoted: false })
      expect(display(w!)).toBe(s)
    },
  )
})

describe('unwrap', () => {
  test.each([
    ['sudo -u root grep a', 'run', 'grep a', ['sudo']],
    ['sudo -uroot env -i A=1 B=2 timeout -s KILL 5 nice -n 3 grep a', 'run', 'grep a', ['sudo', 'env', 'timeout', 'nice']],
    ['xargs -0 -I {} rm {}', 'run', 'rm {}', ['xargs']],
    ['repeat 3 rm -rf x', 'run', 'rm -rf x', ['repeat']],
    ['command grep a', 'run', 'grep a', ['command']],
    ['command -v grep', 'none', '', ['command']],
    ['sudo -l', 'none', '', ['sudo']],
    ['sudo', 'none', '', ['sudo']],
    ['env -S "rm -rf ~"', 'unknown', '', ['env']],
    ['/usr/bin/sudo -- grep a', 'run', 'grep a', ['sudo']],
  ])('%s', async (src, kind, rest, via) => {
    const u = unwrap(await words(src))
    expect(u.kind).toBe(kind)
    expect(u.via).toEqual(via)
    if (u.kind === 'run') expect(u.argv.map(display).join(' ')).toBe(rest)
  })
})

describe('parseFlags', () => {
  const rm = { aliases: { '-r': '--recursive', '-R': '--recursive', '-f': '--force' } }
  test.each([
    ['rm -rf x', rm, ['--recursive', '--force'], ['x']],
    ['rm x -R', rm, ['--recursive'], ['x']],
    ['rm -- -rf', rm, [], ['-rf']],
    ['find . -name x', undefined, ['-name'], ['.', 'x']],
    ['gcc -ofile a.c', { valueShort: 'o' }, ['-o'], ['a.c']],
    ['gcc -o file a.c', { valueShort: 'o' }, ['-o'], ['a.c']],
    ['curl --output f u', { valueLong: ['--output'] }, ['--output'], ['u']],
    ['curl --output=f u', undefined, ['--output'], ['u']],
  ])('%s', async (src, spec, flags, positionals) => {
    const p = parseFlags(await words(src), spec)
    expect(p.flags.map((f) => f.name)).toEqual(flags)
    expect(p.positionals.map(display)).toEqual(positionals)
  })

  test('dynamic words: unquoted or dash-led may be flags; quoted "$x" is not', async () => {
    expect(hasFlag(parseFlags(await words('rm $opts x'), rm), '--recursive')).toBe('unknown')
    expect(hasFlag(parseFlags(await words('rm -$o x'), rm), '--recursive')).toBe('unknown')
    expect(hasFlag(parseFlags(await words('rm "$x"'), rm), '--recursive')).toBe(false)
    expect(parseFlags(await words('rm $HOME/'), rm).positionals.map(display)).toEqual(['$HOME/'])
  })
})

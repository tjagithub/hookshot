import type { WordValue } from '../word.ts'
import { type FlagEntry, type FlagTable, mapFlags, shQuote } from './flag-map.ts'

export { shQuote }

const same = (fs: string) => Object.fromEntries([...fs].map((c): [string, FlagEntry] => [`-${c}`, `-${c}`]))
const context = (c: string): FlagEntry => ({ to: `-${c}`, value: 'number', form: 'attached' })
const glob = (prefix: string): FlagEntry => ({ to: '-g', value: 'any', form: 'separate', quote: 'always', prefix })
const color = (to: string): FlagEntry => ({ to, value: ['never', 'always', 'auto'], form: 'equals', optional: true })

// grep -> rg. In rg, -r is --replace, -h is --help and -L follows links, so those map elsewhere or drop.
export const grepRg: FlagTable = {
  target: 'rg',
  flags: {
    ...same('nilcvwoFHqxPab'),
    '-r': '', '-R': '', '-E': '', '-s': '--no-messages', '-h': '-I', '-L': '--files-without-match',
    '-A': context('A'), '-B': context('B'), '-C': context('C'), '-m': context('m'),
    '--recursive': '', '--extended-regexp': '', '--ignore-case': '-i', '--line-number': '-n', '--count': '-c',
    '--files-with-matches': '-l', '--files-without-match': '--files-without-match', '--invert-match': '-v',
    '--word-regexp': '-w', '--only-matching': '-o', '--fixed-strings': '-F', '--perl-regexp': '-P',
    '--quiet': '-q', '--silent': '-q', '--no-messages': '--no-messages', '--with-filename': '-H',
    '--no-filename': '-I', '--line-regexp': '-x',
    '--include': glob(''), '--exclude': glob('!'), '--exclude-dir': glob('!'),
    '--color': color('--color'), '--colour': color('--colour'),
  },
}
const fgrepRg: FlagTable = { ...grepRg, add: ['-F'] }

export type GrepTranslation =
  | { ok: true; rgFlags: string[]; /** argv index of the first word after the flags (pattern or `--` target). */ rest: number }
  | { ok: false; why: string }

/** Translate grep flags in argv to rg, only when every flag has an exact rg equivalent. */
export function grepToRg(argv: WordValue[]): GrepTranslation {
  const fgrep = argv[0]?.kind === 'literal' && argv[0].text.split('/').pop() === 'fgrep'
  const m = mapFlags(argv, fgrep ? fgrepRg : grepRg)
  return m.ok ? { ok: true, rgFlags: m.out, rest: m.rest } : m
}

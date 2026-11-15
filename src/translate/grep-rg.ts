import type { WordValue } from '../word.ts'

// grep flag -> rg flag ("" = drop). r is rg --replace, h is --help, L follows links: all differ in rg.
const short: Readonly<Record<string, string>> = {
  r: '', R: '', E: '', s: '--no-messages', h: '-I', L: '--files-without-match',
  ...Object.fromEntries([...'nilcvwoFHqxPab'].map((c) => [c, `-${c}`])),
}
const long: Readonly<Record<string, string>> = {
  '--recursive': '', '--extended-regexp': '', '--ignore-case': '-i', '--line-number': '-n', '--count': '-c',
  '--files-with-matches': '-l', '--files-without-match': '--files-without-match', '--invert-match': '-v',
  '--word-regexp': '-w', '--only-matching': '-o', '--fixed-strings': '-F', '--perl-regexp': '-P',
  '--quiet': '-q', '--silent': '-q', '--no-messages': '--no-messages', '--with-filename': '-H',
  '--no-filename': '-I', '--line-regexp': '-x',
}
const contextFlags = new Set(['A', 'B', 'C', 'm'])

export const shQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`

export type GrepTranslation =
  | { ok: true; rgFlags: string[]; /** argv index of the first word after the flags (pattern or `--` target). */ rest: number }
  | { ok: false; why: string }

/** Translate grep flags in argv to rg, only when every flag has an exact rg equivalent. */
export function grepToRg(argv: WordValue[]): GrepTranslation {
  const out: string[] = argv[0]?.kind === 'literal' && argv[0].text.split('/').pop() === 'fgrep' ? ['-F'] : []
  let i = 1
  for (; i < argv.length; i++) {
    const w = argv[i]!
    if (w.kind !== 'literal' || !/^-./.test(w.text)) break
    const f = w.text
    if (f === '--') {
      out.push('--')
      i++
      break
    }
    const glob = /^--(include|exclude|exclude-dir)=(.*)$/s.exec(f)
    if (glob) {
      out.push(`-g ${shQuote((glob[1] === 'include' ? '' : '!') + glob[2])}`)
      continue
    }
    if (/^--colou?r(=(never|always|auto))?$/.test(f)) {
      out.push(f)
      continue
    }
    if (f.startsWith('--')) {
      const r = long[f]
      if (r === undefined) return { ok: false, why: `no rg equivalent for ${f}` }
      if (r) out.push(r)
      continue
    }
    const cs = [...f.slice(1)]
    const k = cs.findIndex((c) => contextFlags.has(c))
    for (const c of k === -1 ? cs : cs.slice(0, k)) {
      const r = short[c]
      if (r === undefined) return { ok: false, why: `no rg equivalent for -${c}` }
      if (r) out.push(r)
    }
    if (k === -1) continue
    const v = cs.slice(k + 1).join('')
    if (v) {
      if (!/^\d+$/.test(v)) return { ok: false, why: `-${cs[k]} needs a number` }
      out.push(`-${cs[k]}${v}`)
    } else {
      const next = argv[i + 1]
      if (next?.kind !== 'literal' || !/^\d+$/.test(next.text)) return { ok: false, why: `-${cs[k]} needs a number` }
      out.push(`-${cs[k]}${next.text}`)
      i++
    }
  }
  if (!out.includes('--') && argv.slice(i + 1).some((w) => w.kind === 'literal' && /^-./.test(w.text))) {
    return { ok: false, why: 'a flag after the pattern' }
  }
  return { ok: true, rgFlags: out, rest: i }
}

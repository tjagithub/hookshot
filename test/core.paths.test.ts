import { fc, test } from '@fast-check/vitest'
import { describe, expect } from 'vitest'
import { handlePreToolUse } from '../src/claude.ts'
import type { Context } from '../src/context.ts'
import { type GlobSeg, compileGlob, expandBraces, globCouldEndWith, globMatches, globMatchesUnder, matchSegs } from '../src/glob.ts'
import { hooks } from '../src/hook.ts'
import { resolvePath } from '../src/paths.ts'
import { path } from '../src/rules/path.ts'
import type { Rule } from '../src/rules/rule.ts'
import { rewrite } from '../src/verdict.ts'
import { numRuns } from './support/arbitraries.ts'

const ctx: Context = { cwd: '/p/sub', root: '/p', home: '/h' }
const g = (p: string) => compileGlob(p, ctx)

describe('glob', () => {
  test.each([
    ['.env', '/p/.env', true],
    ['.env', '/p/sub/.env', false],
    ['**/.env*', '/p/sub/.env.local', true],
    ['**/.env*', '/p/.env', true],
    ['**/.env*', '/elsewhere/.env', false],
    ['/**/.env*', '/elsewhere/.env', true],
    ['*.ts', '/p/.hidden.ts', true],
    ['src/*.ts', '/p/src/a/b.ts', false],
    ['src/**/*.ts', '/p/src/a/b.ts', true],
    ['src/**', '/p/src', true],
    ['~/.ssh/**', '/h/.ssh/id_ed25519', true],
    ['~', '/h', true],
    ['/etc/{passwd,shadow}', '/etc/shadow', true],
    ['{a,b{c,d}}.txt', '/p/bd.txt', true],
    ['{x}.txt', '/p/{x}.txt', true],
    ['f?.txt', '/p/f1.txt', true],
    ['f?.txt', '/p/f12.txt', false],
    ['a\\*b', '/p/a*b', true],
    ['a\\*b', '/p/axb', false],
  ])('%s vs %s -> %s', (pat, abs, want) => {
    expect(globMatches(g(pat), abs)).toBe(want)
  })

  test.each([
    ['/**/.env{,.*}', 'fix.txt', false],
    ['/**/.env{,.*}', '.env.local', 'unknown'],
    ['src/**', 'a.ts', 'unknown'],
    ['{a,b}/*.md', 'x.md', 'unknown'],
    ['{a,b}/*.md', 'x.ts', false],
  ])('%s could end with %s -> %s', (pat, base, want) => {
    expect(globCouldEndWith(g(pat), base)).toBe(want)
  })

  const globSeg = fc.constantFrom('a', '.env', '.env.x', 'b.md', '*', '**', '*.md', '{a,.env}')
  test.prop([fc.array(globSeg, { minLength: 1, maxLength: 4 }), fc.array(fc.constantFrom('a', 'b', '.env'), { maxLength: 3 }), fc.constantFrom('a', '.env', '.env.x', 'b.md', 'x.ts')], { numRuns })(
    'a glob ruled out by the last segment never matches a path ending in it',
    (pat, dirs, base) => {
      const glob = g(`/${pat.join('/')}`)
      if (globCouldEndWith(glob, base) === false) expect(globMatches(glob, `/${[...dirs, base].join('/')}`)).toBe(false)
    },
  )

  test.each([
    ['/**/.env', '.env', true],
    ['**/.env', '.env', 'unknown'],
    ['/etc/*', 'passwd', 'unknown'],
    ['/etc/*', 'a/b', false],
    ['/etc/passwd', 'shadow', false],
  ])('%s under an unknown directory, %s -> %s', (pat, rel, want) => {
    expect(globMatchesUnder(g(pat), rel)).toBe(want)
  })

  test('brace expansion is bounded', () => {
    expect(expandBraces('{a,b}{c,d}')).toEqual(['ac', 'ad', 'bc', 'bd'])
    expect(() => expandBraces('{a,b}'.repeat(7))).toThrow(/more than 64/)
  })

  // A plain recursive matcher as the reference for the backtracking one.
  const ref = (gl: readonly GlobSeg[], s: readonly string[]): boolean => {
    if (!gl.length) return !s.length
    const [h, ...t] = gl
    if (h === '**') return ref(t, s) || (s.length > 0 && ref(gl, s.slice(1)))
    return s.length > 0 && h!.test(s[0]!) && ref(t, s.slice(1))
  }
  const seg = fc.constantFrom('a', 'b', 'ab', '.a')
  const gseg = fc.constantFrom<GlobSeg>('**', /^a$/, /^b$/, /^[^/]*$/, /^a[^/]*$/, /^\.[^/]*$/)
  test.prop([fc.array(gseg, { maxLength: 6 }), fc.array(seg, { maxLength: 6 })], { numRuns: numRuns * 10 })(
    'matchSegs agrees with a recursive matcher',
    (gl, s) => {
      expect(matchSegs(gl, s)).toBe(ref(gl, s))
    },
  )
})

describe('resolvePath', () => {
  test.each([
    ['x/../y', '/p/sub/y'],
    ['./a//b/', '/p/sub/a/b'],
    ['~/x', '/h/x'],
    ['/a/./b/../c', '/a/c'],
    ['../../../..', '/'],
  ])('%s -> %s', (raw, abs) => {
    expect(resolvePath(raw, ctx)).toMatchObject({ kind: 'known', abs })
  })
  test('~user and an unknown cwd are not guessed', () => {
    expect(resolvePath('~root/x', ctx).kind).toBe('dynamic')
    expect(resolvePath('a/../b', ctx, { cwdKnown: false })).toMatchObject({ kind: 'relative', rel: 'b' })
  })
  test.prop([fc.stringMatching(/^[a-z./~]{0,12}$/)])('normalising twice changes nothing', (raw) => {
    const once = resolvePath(raw, ctx)
    fc.pre(once.kind === 'known')
    expect(resolvePath(once.abs, ctx)).toMatchObject({ kind: 'known', abs: once.abs })
  })
})

describe('path()', () => {
  const env = path('/**/.env*').deny('no .env')
  const hook = hooks([env, path('~/.ssh/**').reads().ask('ssh keys')])
  const bash = async (c: string) => (await hook.evaluate(c, ctx)).outcome.decision
  const tool = async (tool_name: string, tool_input: Record<string, unknown>) =>
    (await handlePreToolUse(hook, { tool_name, tool_input, cwd: ctx.cwd }, ctx))?.hookSpecificOutput.permissionDecision

  test.each([
    ['echo A=1 > .env', 'deny'],
    ['{ echo a; } >> ../.env.local', 'deny'],
    ['while read l; do echo $l; done > /tmp/.env', 'deny'],
    ['echo a | tee -a out .env', 'deny'],
    ['echo a > "$HOME/.env"', 'deny'],
    ['echo a > ~/.env', 'deny'],
    ['echo a > "~/.env"', 'deny'], // a directory literally named ~, still a .env
    ['cat < ~/.ssh/id_rsa', 'ask'],
    ['echo a > out.txt', 'allow'],
    ['cp x .env', 'allow'], // not claimed: cp is not in fileWriters
    ['echo a > "$f"', 'ask'],
    ['cd sub && echo a > .env', 'deny'], // /**/ matches under any directory
    ['cd sub && echo a > out.txt', 'allow'],
    ['echo a >! .env', 'deny'], // zsh >! parses as >|
  ])('bash: %s -> %s', async (c, want) => {
    expect(await bash(c)).toBe(want)
  })

  test('an anchored pattern after cd is unknown', async () => {
    const h = hooks([path('.env').deny('no')])
    expect((await h.evaluate('cd /tmp && echo > .env', ctx)).outcome.decision).toBe('ask')
    expect((await h.evaluate('$GO && echo > .env', ctx)).outcome.decision).toBe('ask')
    expect((await h.evaluate('echo > ../.env', ctx)).outcome.decision).toBe('deny')
  })

  test.each([
    ['Write', { file_path: '/p/.env', content: 'x' }, 'deny'],
    ['Edit', { file_path: '.env.prod', old_string: 'a', new_string: 'b' }, 'deny'],
    ['NotebookEdit', { notebook_path: '/p/.env.ipynb' }, 'deny'],
    ['Read', { file_path: '/p/.env' }, undefined],
    ['Read', { file_path: '/h/.ssh/id_rsa' }, 'ask'],
    ['Write', { file_path: '/p/readme.md' }, undefined],
    ['Write', { content: 'x' }, 'ask'],
    ['Glob', { pattern: '**/.env' }, undefined],
  ])('%s %j -> %s', async (t, input, want) => {
    expect(await tool(t, input)).toBe(want)
  })

  test('a rewrite on a file tool is a rule error', async () => {
    const bad: Rule = { name: 'bad', check: (s) => (s.kind === 'file' ? rewrite([{ start: 0, end: 0, text: 'x', rule: 'bad' }]) : rewrite([])) }
    const out = await hooks([bad]).evaluateFile({ op: 'write', path: resolvePath('/x', ctx), source: 'tool', tool: 'Write' })
    expect(out.outcome).toMatchObject({ decision: 'ask', reasons: [{ message: expect.stringContaining('rule-error') }] })
  })

  test('RegExp and predicate specs see the absolute path', async () => {
    const h = hooks([path(/^\/p\/secret/).any().deny('secret'), path((p) => p.endsWith('.pem')).deny('pem')])
    expect((await h.evaluate('cat < ../sub/../secret.txt', ctx)).outcome.decision).toBe('deny')
    expect((await h.evaluate('echo > k.pem', ctx)).outcome.decision).toBe('deny')
    expect((await h.evaluate('cd x; echo > k.pem', ctx)).outcome.decision).toBe('ask')
  })
})

import { fc, test } from '@fast-check/vitest'
import { describe, expect } from 'vitest'
import { isNode } from '../src/ast.ts'
import { classifyRedirect, extract } from '../src/extract.ts'
import { parse } from '../src/parse.ts'
import { display } from '../src/word.ts'
import { numRuns, shellSoup } from './support/arbitraries.ts'

const names = async (src: string) => (await extract(src)).invocations.map((i) => i.name)
const argvs = async (src: string) => (await extract(src)).invocations.map((i) => i.argv.map(display).join(' '))

describe('extract: what runs', () => {
  test.each([
    ['a | b && c || d; e &', ['a', 'b', 'c', 'd', 'e']],
    // Substitutions are listed before their command: they run first.
    ['echo $(grep a f) <(rg b) `ls`', ['grep', 'rg', 'ls', 'echo']],
    ['x=$(id) y=1', ['id']],
    ['if a; then b; elif c; then d; else e; fi', ['a', 'b', 'c', 'd', 'e']],
    ['while a; do b; done; until c; do d; done', ['a', 'b', 'c', 'd']],
    ['for i in $(ls); do rm $i; done', ['ls', 'rm']],
    ['case $(x) in a) y;; *) z;; esac', ['x', 'y', 'z']],
    ['f() { g; }; (h); { i; }', ['g', 'h', 'i']],
    ['time sleep 1; [[ $(id) ]]; (( $(n) )); declare a=$(b)', ['sleep', 'id', 'n', 'b']],
    ['cat <<EOF\n$(whoami)\nEOF', ['whoami', 'cat']],
    ["bash -c 'a; b' && sh -c 'c'", ['bash', 'a', 'b', 'sh', 'c']],
    ['eval "rm -rf x"', ['eval', 'rm']],
    ['find . -name x -exec rm {} \\; -exec grep a {} +', ['find', 'rm', 'grep']],
    ['sudo xargs grep a', ['grep']],
    ['command -v grep', []],
  ])('%s', async (src, want) => {
    expect(await names(src)).toEqual(want)
  })

  test('via records the wrapper chain', async () => {
    const x = await extract("sudo bash -c 'xargs rm'")
    expect(x.invocations.map((i) => [i.name, i.via])).toEqual([
      ['bash', ['sudo']],
      ['rm', ['sudo', 'bash -c', 'xargs']],
    ])
  })

  test('origin: single quotes are editable at their byte offset; double quotes and eval are opaque', async () => {
    const x = await extract(`bash -c 'rg a'; bash -c "rg b"; eval 'rg c'`)
    const rg = x.invocations.filter((i) => i.name === 'rg').map((i) => i.call)
    expect(rg.map((c) => c.origin.kind)).toEqual(['single-quoted', 'opaque', 'opaque'])
    const y = await extract(`ü; bash -c 'rg a'`)
    const call = y.invocations.find((i) => i.name === 'rg')!.call
    expect(call.base).toBe(Buffer.byteLength("ü; bash -c '"))
    expect((await extract('bash -c "rg b"')).invocations.at(-1)!.call.origin.kind).toBe('opaque')
    expect((await extract("eval 'rg c'")).invocations.at(-1)!.call.origin.kind).toBe('opaque')
  })

  test('standalone: only plain top-level calls', async () => {
    const x = await extract('a && b || c; d | e; f > g; h & ! i; $(j); (k)')
    expect(x.invocations.filter((i) => i.call.standalone).map((i) => i.name)).toEqual(['a', 'b', 'c', undefined]) // $(j) runs j's output
  })

  test('pipelines flatten into ordered stages, wrappers stripped per stage', async () => {
    const x = await extract('curl -s x | tee log |& sudo bash')
    expect(x.pipelines).toHaveLength(1)
    expect(x.pipelines[0]!.stages.map((s) => s.map((i) => i.name))).toEqual([['curl'], ['tee'], ['bash']])
  })
})

describe('extract: what it cannot decide', () => {
  test.each([
    ['for f (a b) rm -rf ~', 'unparsed'],
    ["bash -c 'for f (a b) x'", 'unparsed'],
    ['bash -c "$CMD"', 'dynamic'],
    ['eval "$CMD"', 'dynamic'],
    ["fish -c 'rm -rf ~'", 'opaque-shell'],
    ['env -S "rm -rf ~"', 'opaque-wrapper'],
    [`${"bash -c 'true'; ".repeat(16)}bash -c 'x'`, 'budget'],
  ])('%s -> %s', async (src, why) => {
    expect((await extract(src)).unknowns.map((u) => u.why)).toContain(why)
  })

  test('the budget counts scripts, top level included', async () => {
    const x = await extract(`${"bash -c 'true'; ".repeat(3)}bash -c 'x'`, { maxScripts: 4 })
    expect(x.unknowns).toEqual([expect.objectContaining({ why: 'budget' })])
  })

  test('a parser that throws is reported, not treated as unparsed text', async () => {
    const x = await extract('ls', { parse: () => Promise.reject(new Error('gone')) })
    expect(x.unknowns).toEqual([{ why: 'parser-unavailable', detail: 'gone' }])
  })
})

describe('redirects', () => {
  test.each([
    ['>', 'f', 'write'], ['>>', 'f', 'write'], ['>|', 'f', 'write'], ['&>', 'f', 'write'], ['&>>', 'f', 'write'],
    ['<>', 'f', 'write'], ['<', 'f', 'read'], ['<<', 'EOF', 'input'], ['<<<', 's', 'input'],
    ['>&', '1', 'dup'], ['>&', '-', 'dup'], ['>&', 'file', 'write'], ['<&', '0', 'dup'], ['>!', 'f', 'unknown'],
  ])('%s %s is %s', (op, target, kind) => {
    const w = { kind: 'literal', text: target } as Parameters<typeof classifyRedirect>[1]
    expect(classifyRedirect(op, w)).toBe(kind)
  })

  test('targets and fds come from the tree', async () => {
    const x = await extract('echo a > .env 2>&1; cat < in')
    expect(x.redirects.map((r) => [r.op, r.kind, r.fd, r.target && display(r.target)])).toEqual([
      ['>', 'write', undefined, '.env'],
      ['>&', 'dup', '2', '1'],
      ['<', 'read', undefined, 'in'],
    ])
  })
})

function countCalls(v: unknown): number {
  if (Array.isArray(v)) return v.reduce((n, x) => n + countCalls(x), 0)
  if (!isNode(v)) return 0
  const self = v.Type === 'CallExpr' && Array.isArray(v.Args) && v.Args.length ? 1 : 0
  return self + Object.values(v).reduce<number>((n, x) => n + countCalls(x), 0)
}

test.prop([shellSoup], { numRuns: numRuns * 10 })('every CallExpr is extracted, or an Unknown says why not', async (src) => {
  const p = await parse(src)
  fc.pre(p !== null)
  const x = await extract(src)
  const top = x.calls.filter((c) => c.script === 0).length
  if (x.unknowns.some((u) => u.why === 'unsupported-syntax')) expect(top).toBeLessThanOrEqual(countCalls(p!.file))
  else expect(top).toBe(countCalls(p!.file))
})

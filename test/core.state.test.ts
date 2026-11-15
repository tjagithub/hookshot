import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { hooks } from '../src/hook.ts'
import { cmd } from '../src/rules/cmd.ts'
import { type Store, duration, fileStore } from '../src/state.ts'

const tmp = () => mkdtempSync(join(tmpdir(), 'hookshot-state-'))
const rmr = () => cmd('rm').flags({ aliases: { '-r': '--recursive' } }).withFlag('--recursive')

describe('escalate', () => {
  test('asks twice, then denies; sessions are separate', async () => {
    const h = hooks([rmr().ask('recursive rm').escalate({ after: 2, to: 'deny' })], { store: fileStore(tmp()) })
    const go = async (sessionId: string) => (await h.evaluate('rm -r build', { sessionId })).outcome
    expect((await go('s1')).decision).toBe('ask')
    expect((await go('s1')).decision).toBe('ask')
    expect(await go('s1')).toMatchObject({ decision: 'deny', reasons: [{ message: 'fired 3 times this session' }] })
    expect((await go('s2')).decision).toBe('ask')
  })

  test('within: only recent firings count', async () => {
    let t = 0
    const h = hooks([rmr().note('rm -r').escalate({ after: 1, within: '10m', to: 'ask' })], { store: fileStore(tmp(), { now: () => t }) })
    const go = async () => (await h.evaluate('rm -r x', { sessionId: 's' })).outcome.decision
    expect(await go()).toBe('allow')
    t += duration('11m')
    expect(await go()).toBe('allow')
    t += duration('1m')
    expect(await go()).toBe('ask')
  })

  test('two firings in one command count separately', async () => {
    const h = hooks([rmr().note('rm -r').escalate({ after: 1, to: 'deny' })], { store: fileStore(tmp()) })
    expect((await h.evaluate('rm -r a; rm -r b', { sessionId: 's' })).outcome.decision).toBe('deny')
  })

  test.each([
    ['no session id', {}],
    ['not a plain name', { sessionId: '../../etc' }],
  ])('%s: an escalating rule that fires is Unknown', async (detail, over) => {
    const h = hooks([rmr().note('rm -r').escalate({ after: 5, to: 'deny' })], { store: fileStore(tmp()) })
    const out = (await h.evaluate('rm -r x', over)).outcome
    expect(out).toMatchObject({ decision: 'ask', reasons: [{ message: expect.stringContaining(detail) }] })
    expect((await h.evaluate('rm x', over)).outcome.decision).toBe('allow')
  })

  test('a failed save is Unknown: otherwise the count would quietly stay low', async () => {
    const store: Store = { load: () => fileStore(tmp()).load('s'), save: () => { throw new Error('disk full') } }
    const out = (await hooks([rmr().note('x').escalate({ after: 9, to: 'deny' })], { store }).evaluate('rm -r a', { sessionId: 's' })).outcome
    expect(out).toMatchObject({ decision: 'ask', reasons: [{ message: expect.stringContaining('disk full') }] })
  })

  test('store: null disables it; rules without escalate never touch it', async () => {
    const off = hooks([rmr().note('x').escalate({ after: 0, to: 'deny' })], { store: null })
    expect((await off.evaluate('rm -r a', { sessionId: 's' })).outcome.decision).toBe('ask')
    const dir = tmp()
    await hooks([rmr().ask('x')], { store: fileStore(dir) }).evaluate('rm -r a', { sessionId: 's' })
    expect(readdirSync(dir)).toEqual([])
  })

  test('bad options throw when the rule is built', () => {
    expect(() => rmr().escalate({ after: -1, to: 'deny' })).toThrow(/whole number/)
    expect(() => rmr().escalate({ after: 1, within: '10 minutes', to: 'deny' })).toThrow(/bad duration/)
  })
})

describe('fileStore', () => {
  test('torn lines count as nothing; old sessions are pruned', () => {
    const dir = tmp()
    writeFileSync(join(dir, 's.jsonl'), '{"t":1,"key":"a"}\n{"t":2,"ke')
    writeFileSync(join(dir, 'old.jsonl'), '')
    const old = new Date(Date.now() - duration('8d'))
    utimesSync(join(dir, 'old.jsonl'), old, old)
    const h = fileStore(dir).load('s')
    expect('count' in h && h.count('a')).toBe(1)
    expect(readdirSync(dir)).toEqual(['s.jsonl'])
  })

  test('50 processes appending at once leave 50 whole lines', async () => {
    const dir = tmp()
    const state = fileURLToPath(new URL('../src/state.ts', import.meta.url))
    const script = `const { fileStore } = await import(${JSON.stringify(state)}); fileStore(${JSON.stringify(dir)}).save('s', [{ t: Number(process.argv.at(-1)), key: 'k'.repeat(300) }])`
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        new Promise<void>((ok, fail) => {
          spawn('bun', ['-e', script, String(i)]).on('exit', (c) => (c === 0 ? ok() : fail(new Error(`exit ${c}`))))
        }),
      ),
    )
    const lines = readFileSync(join(dir, 's.jsonl'), 'utf8').trimEnd().split('\n')
    expect(lines.map((l) => (JSON.parse(l) as { t: number }).t).sort((a, b) => a - b)).toEqual([...Array(50).keys()])
  })
})

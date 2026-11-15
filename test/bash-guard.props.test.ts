import { fc, test } from '@fast-check/vitest'
import { afterAll, describe, expect } from 'vitest'
import { parse } from '../src/parse.ts'
import { grepCommand, numRuns, quotedEcho, shellSoup } from './support/arbitraries.ts'
import { type Impl, available, hasShfmt, implName, runGuard, severity } from './support/guard.ts'

const opts = { numRuns }
const reference: Impl = { impl: 'reference', parser: 'shfmt' }
const port: Impl = { impl: 'port', backend: 'native' }

for (const impl of [reference, port]) {
  describe.skipIf(!available(impl))(`${implName(impl)} properties`, () => {
    test.prop([shellSoup], opts)('never errors; any output is a valid decision', async (cmd) => {
      const r = await runGuard(cmd, { impl })
      expect(r.decision, r.stderr).not.toBe('error')
      if (r.updated) expect(typeof r.updated.command).toBe('string')
    })

    test.prop([fc.oneof(shellSoup, grepCommand)], opts)('a rewrite is final, parses and keeps other fields', async (cmd) => {
      const r = await runGuard(cmd, { impl, toolInput: { description: 'd' } })
      fc.pre(r.updated !== undefined && r.decision === 'allow')
      const next = String(r.updated?.command)
      expect(r.updated?.description).toBe('d')
      expect(await parse(next)).not.toBeNull()
      const again = await runGuard(next, { impl })
      expect(again.decision, again.reason).toBe('allow')
      expect(again.updated).toBeUndefined()
    })

    test.prop([grepCommand], opts)('grep never runs: blocked, or rewritten with no grep left', async (cmd) => {
      const r = await runGuard(cmd, { impl })
      if (r.decision === 'deny') return
      expect(r.decision).toBe('allow')
      expect(r.updated?.command).toBeTypeOf('string')
      expect(String(r.updated?.command)).not.toMatch(/(^|[\s|&;/])[ef]?grep\s/)
    })

    test.prop([quotedEcho], opts)('single-quoted text is inert', async (cmd) => {
      const r = await runGuard(cmd, { impl })
      expect(r.decision).toBe('allow')
      expect(r.updated).toBeUndefined()
    })
  })
}

test.prop([fc.oneof(shellSoup, grepCommand)], opts)('shfmt and sh-syntax agree in bash-guard', async (cmd) => {
  fc.pre(hasShfmt)
  const [a, b] = await Promise.all([runGuard(cmd), runGuard(cmd, { impl: { impl: 'reference', parser: 'sh-syntax' } })])
  expect({ d: b.decision, u: b.updated }).toEqual({ d: a.decision, u: a.updated })
})

// The port may be stricter than bash-guard (it asks where bash-guard guessed), never looser.
describe.skipIf(!available(port) || !hasShfmt)('port against bash-guard', () => {
  const stricter: string[] = []
  afterAll(() => {
    if (stricter.length) console.info(`port stricter than bash-guard on ${stricter.length} inputs, e.g.\n  ${stricter.slice(0, 5).join('\n  ')}`)
  })

  test.prop([fc.oneof(shellSoup, grepCommand)], opts)('same decision and rewrite, or stricter', async (cmd) => {
    const [ref, got] = await Promise.all([runGuard(cmd, { impl: reference }), runGuard(cmd, { impl: port })])
    expect(got.decision).not.toBe('error')
    if (severity[got.decision] > severity[ref.decision]) {
      stricter.push(`${ref.decision} -> ${got.decision}: ${cmd}`)
      return
    }
    expect({ decision: got.decision, updated: got.updated }, `${cmd}\n${got.reason}`).toEqual({
      decision: ref.decision,
      updated: ref.updated,
    })
  })
})

import { describe, expect, test } from 'vitest'
import { allowed, blocked, jouetRewrites, knownGaps, rewrites, untouched } from './cases.ts'
import { available, implName, impls, runGuard } from './support/guard.ts'

// The TOML flags matcher reads a run-time word as maybe a flag ($F could be -i), so sed -i asks where the TS port's regex allows.
const tomlStricter = new Set(['cd x && sed -n 1,3p $F || echo no'])

for (const impl of impls) {
  describe.skipIf(!available(impl))(implName(impl), () => {
    const run = (cmd: string, extra: Parameters<typeof runGuard>[1] = {}) => runGuard(cmd, { impl, ...extra })

    const rewriting = [...rewrites, ...jouetRewrites].filter(([cmd]) => impl.impl !== 'toml' || !tomlStricter.has(cmd))
    test.concurrent.each(rewriting)('rewrites %s', async (cmd, want) => {
      const r = await run(cmd, { toolInput: { description: 'd' } })
      expect(r.decision, r.reason).toBe('allow')
      expect(r.updated).toEqual({ command: want, description: 'd' })
    })

    test.skipIf(impl.impl !== 'toml').concurrent.each([...tomlStricter])('asks for %s (stricter than the port)', async (cmd) => {
      expect((await run(cmd)).decision).toBe('ask')
    })

    test.concurrent.each(untouched)('leaves %s', async (cmd) => {
      const r = await run(cmd)
      expect(r.decision, r.reason).toBe('allow')
      expect(r.updated).toBeUndefined()
    })

    test.concurrent('leaves sed -n alone without jouet', async () => {
      const r = await run('sed -n 1,5p f', { jouet: false })
      expect(r.decision, r.reason).toBe('allow')
      expect(r.updated).toBeUndefined()
    })

    test.concurrent.each(blocked)('blocks %s', async (cmd) => {
      const r = await run(cmd)
      expect(r.decision).toBe('deny')
      if (impl.impl === 'reference') expect(r.stderr).toMatch(/^guardrails: blocked\./)
    })

    test.concurrent.each(allowed)('allows %s', async (cmd) => {
      const r = await run(cmd)
      expect(r.decision, r.reason).toBe('allow')
    })

    // bash-guard lets these through (test.fails); the port must stop them, by deny or ask.
    const gap = impl.impl === 'reference' ? test.fails : test
    gap.each(knownGaps)('known gap, must not allow: %s', async (_why, cmd) => {
      expect((await run(cmd)).decision).not.toBe('allow')
    })
  })
}

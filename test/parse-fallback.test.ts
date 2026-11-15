import { afterEach, describe, expect, test, vi } from 'vitest'

// Fresh copies of src/parse.ts with node:module (the addon loader) and node:fs (the wasm read) broken.
async function freshParse(opts: { native?: 'fail'; wasm?: 'fail'; env?: string } = {}) {
  vi.resetModules()
  const calls = { native: 0, wasm: 0 }
  vi.doMock('node:module', async (orig) => {
    const real = await orig<typeof import('node:module')>()
    return {
      ...real,
      createRequire: (url: string | URL) => {
        const req = real.createRequire(url)
        return (id: string) => {
          calls.native++
          if (opts.native === 'fail') throw new Error('no addon here')
          return req(id)
        }
      },
    }
  })
  vi.doMock('node:fs', async (orig) => {
    const real = await orig<typeof import('node:fs')>()
    return {
      ...real,
      readFileSync: (...args: Parameters<typeof real.readFileSync>) => {
        calls.wasm++
        if (opts.wasm === 'fail') throw new Error('no wasm here')
        return real.readFileSync(...args)
      },
    }
  })
  if (opts.env) vi.stubEnv('HOOKSHOT_PARSER', opts.env)
  return { mod: await import('../src/parse.ts'), calls }
}

afterEach(() => {
  vi.doUnmock('node:module')
  vi.doUnmock('node:fs')
  vi.unstubAllEnvs()
})

describe('backend selection', () => {
  test('falls back to wasm and keeps the native error', async () => {
    const { mod } = await freshParse({ native: 'fail' })
    expect((await mod.parse('echo hi'))?.dialect).toBe('zsh')
    expect(mod.parserStatus()).toMatchObject({
      active: 'wasm',
      native: { state: 'failed', error: { message: 'no addon here' } },
      wasm: { state: 'ready' },
    })
  })

  test('failed is final: no second load attempt', async () => {
    const { mod, calls } = await freshParse({ native: 'fail' })
    await mod.parse('a')
    await mod.parse('b')
    await expect(mod.parse('c', { backend: 'native' })).rejects.toThrow(mod.ParserUnavailable)
    expect(calls.native).toBe(1)
  })

  test('concurrent first calls share one load', async () => {
    const { mod, calls } = await freshParse({ native: 'fail' })
    await Promise.all([mod.parse('a'), mod.parse('b'), mod.parse('c')])
    expect(calls).toEqual({ native: 1, wasm: 1 })
  })

  test('no backend: ParserUnavailable with both causes', async () => {
    const { mod } = await freshParse({ native: 'fail', wasm: 'fail' })
    const err = await mod.parse('echo hi').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(mod.ParserUnavailable)
    const cause = (err as Error).cause as AggregateError
    expect(cause.errors.map((e: Error) => (e.cause as Error).message)).toEqual(['no addon here', 'no wasm here'])
  })

  test('HOOKSHOT_PARSER=wasm skips native entirely', async () => {
    const { mod, calls } = await freshParse({ env: 'wasm' })
    expect(await mod.activeBackend()).toBe('wasm')
    expect(calls.native).toBe(0)
    expect(mod.parserStatus().native.state).toBe('idle')
  })

  test('HOOKSHOT_PARSER=native does not fall back', async () => {
    const { mod } = await freshParse({ native: 'fail', env: 'native' })
    await expect(mod.parse('echo hi')).rejects.toThrow(mod.ParserUnavailable)
    expect(mod.parserStatus().wasm.state).toBe('idle')
  })
})

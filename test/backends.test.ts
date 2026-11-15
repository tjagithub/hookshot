import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import fc from 'fast-check'
import { beforeAll, describe, expect, test } from 'vitest'
import { nativeAsset, parse, type Backend } from '../src/parse.ts'
import { allowed, blocked, jouetRewrites, rewrites, untouched } from './cases.ts'
import { grepCommand, numRuns, shellSoup } from './support/arbitraries.ts'
import { hasShfmt, root } from './support/guard.ts'

const build = join(root, 'native/build')
const built = [nativeAsset(), 'hsparse.wasm'].every((f) => existsSync(join(build, f)))
const hasFfi = existsSync(join(build, 'libhsparse.dylib'))
const has = (bin: string) => spawnSync(bin, ['--version']).status === 0

// Locally a missing tool skips; in CI the same skip would hide a broken platform build.
test.runIf(Boolean(process.env.CI))('CI has the addon, shfmt, bun and deno', () => {
  expect({ built, hasShfmt, bun: has('bun'), deno: has('deno') }).toEqual({ built: true, hasShfmt: true, bun: true, deno: true })
})

const seed = Number(process.env.FC_SEED ?? 42)
const commands = [
  ...[...rewrites, ...jouetRewrites].map(([c]) => c),
  ...untouched, ...blocked, ...allowed,
  ...fc.sample(shellSoup, { numRuns: numRuns * 10, seed }),
  ...fc.sample(grepCommand, { numRuns: numRuns * 5, seed }),
  ...fc.sample(fc.string({ unit: 'grapheme', maxLength: 30 }), { numRuns: numRuns * 5, seed }),
]

// What bash-guard parses with: shfmt, zsh first, then bash.
function shfmt(cmd: string): unknown {
  for (const ln of ['zsh', 'bash']) {
    const r = spawnSync('shfmt', ['-ln', ln, '--to-json'], { input: cmd, encoding: 'utf8' })
    if (r.status === 0) return JSON.parse(r.stdout)
  }
  return null
}

function batch(bin: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const r = spawnSync(bin, args, {
    input: JSON.stringify(commands),
    encoding: 'utf8',
    maxBuffer: 1 << 30,
    env: { ...process.env, ...env },
  })
  expect(r.status, r.stderr).toBe(0)
  return JSON.parse(r.stdout) as {
    backend?: Backend
    status?: Record<Backend, { state: string; error?: string }>
    trees: unknown[]
  }
}

describe.skipIf(!built || !hasShfmt)('every backend and runtime matches shfmt --to-json', () => {
  let want: unknown[]
  beforeAll(() => {
    want = commands.map(shfmt)
  })
  const expectTrees = (trees: unknown[]) => commands.forEach((cmd, i) => expect(trees[i], cmd).toEqual(want[i]))

  test.each<Backend>(['native', 'wasm'])('%s, in node', async (backend) => {
    const trees = []
    for (const c of commands) trees.push((await parse(c, { backend }))?.file ?? null)
    expectTrees(trees)
  })

  const script = join(root, 'test/support/parse-batch.ts')
  const runtimes: Array<[string, string, string[], NodeJS.ProcessEnv, Backend]> = [
    ['bun', 'bun', [script], {}, 'native'],
    ['bun, wasm forced', 'bun', [script], { HOOKSHOT_PARSER: 'wasm' }, 'wasm'],
    ['deno --allow-ffi', 'deno', ['run', '--allow-read', '--allow-env', '--allow-ffi', script], {}, 'native'],
    ['deno without --allow-ffi falls back', 'deno', ['run', '--allow-read', script], {}, 'wasm'],
  ]
  test.each(runtimes)('%s', (_name, bin, args, env, backend) => {
    if (!has(bin)) return
    const out = batch(bin, args, env)
    expect(out.backend).toBe(backend)
    expect(out.status?.[backend].state).toBe('ready')
    if (bin === 'deno' && backend === 'wasm') {
      expect(out.status?.native).toMatchObject({ state: 'failed', error: expect.any(String) })
    }
    expectTrees(out.trees)
  })

  test.skipIf(!has('bun') || !hasFfi)('bun:ffi (experiment, HS_FFI=1 native/build.sh)', () => {
    const out = batch('bun', [join(root, 'native/ffi-batch.ts')])
    expectTrees(out.trees)
  })
})

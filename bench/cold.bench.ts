import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { bench, do_not_optimize, group, run, summary } from 'mitata'
import { parse } from '@questi0nm4rk/shell-ast'
import { parse as shParse, LangVariant } from 'sh-syntax'
import { parse as napiParse } from '../native/napi.ts'

// Run with node and with bun: cold start spawns both runtimes, warm parse measures the current one.
const isBun = 'bun' in process.versions
const entry = (file: string) => fileURLToPath(new URL(`entries/${file}`, import.meta.url))
const cmd = 'grep -rn foo src'
const exec = (bin: string, args: string[], input?: string, env?: NodeJS.ProcessEnv) => () => {
  const r = spawnSync(bin, args, { input, env: { ...process.env, ...env } })
  if (r.status !== 0) throw new Error(`${bin} ${args.join(' ')}: ${r.stderr}`)
}
const runtimes: Record<string, [string, string[]]> = {
  node: ['node', []],
  bun: ['bun', []],
  deno: ['deno', ['run', '--allow-read', '--allow-env', '--allow-ffi']],
}

if (!process.env.WARM_ONLY) {
  group('cold start, one parse', () => {
    summary(() => {
      for (const [rt, [bin, pre]] of Object.entries(runtimes)) {
        const on = (file: string, env?: NodeJS.ProcessEnv) => exec(bin, [...pre, entry(file), cmd], undefined, env)
        bench(`${rt}: empty script`, on('empty.mjs'))
        bench(`${rt}: sh-syntax (wasm)`, on('sh-syntax.mjs'))
        bench(`${rt}: hookshot native (napi)`, on('hookshot.ts', { HOOKSHOT_PARSER: 'native' }))
        bench(`${rt}: hookshot wasm`, on('hookshot.ts', { HOOKSHOT_PARSER: 'wasm' }))
        bench(`${rt}: guardrails port (native)`, on('guardrails.ts', { HOOKSHOT_PARSER: 'native' }))
      }
      bench('bun: go c-shared (bun:ffi)', exec('bun', [entry('ffi.ts'), cmd]))
      bench('shfmt --to-json', exec('shfmt', ['-ln', 'bash', '--to-json'], cmd))
    })
  })
}

const ffiParse = isBun ? (await import('../native/ffi.ts')).parse : undefined
await parse('warm')
group(`warm parse to a JS object, in ${isBun ? 'bun' : 'node'}`, () => {
  summary(() => {
    bench('sh-syntax (wasm)', async () => do_not_optimize(await shParse(cmd, { variant: LangVariant.LangBash })))
    bench('shell-ast (wasm)', async () => do_not_optimize(await parse(cmd, 'bash')))
    bench('go c-archive (napi)', () => do_not_optimize(JSON.parse(napiParse(cmd, 1) ?? 'null')))
    if (ffiParse) bench('go c-shared (bun:ffi)', () => do_not_optimize(JSON.parse(ffiParse(cmd, 1) ?? 'null')))
  })
})

await run()

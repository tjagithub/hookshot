import { spawnSync } from 'node:child_process'
import { readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, test } from 'vitest'
import { nativeAsset } from '../src/parse.ts'
import { root } from './support/guard.ts'
import { tempDirs } from './support/tmp.ts'

// Packs the real tarball and installs it offline into a scratch project, so node runs dist/ from
// node_modules, where it refuses to strip types.
const mk = tempDirs()
let proj = ''
let files: string[] = []

function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) {
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status}):\n${r.stdout}\n${r.stderr}`)
  return r.stdout
}

beforeAll(() => {
  const out = mk('hookshot-pack-')
  run('pnpm', ['pack', '--pack-destination', out], root)
  const tgz = join(out, readdirSync(out).find((f) => f.endsWith('.tgz'))!)
  // The one runtime dependency, packed from node_modules so the install stays offline.
  const deps = mk('hookshot-deps-')
  run('npm', ['pack', realpathSync(join(root, 'node_modules/smol-toml')), '--pack-destination', deps, '--ignore-scripts'], deps)
  const toml = join(deps, readdirSync(deps).find((f) => f.endsWith('.tgz'))!)
  files = run('tar', ['-tzf', tgz], out).trim().split('\n')
  proj = realpathSync(mk('hookshot-proj-'))
  writeFileSync(join(proj, 'package.json'), '{"type":"module","private":true}\n')
  run('npm', ['install', toml, tgz, '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], proj)
  writeFileSync(
    join(proj, 'rules.ts'),
    "import { cmd, hooks, parserStatus } from '@tjakit/hookshot'\nexport default hooks([cmd('rm').ask('rm')])\nexport const status = parserStatus\n",
  )
})

describe('the npm package', () => {
  test('ships dist and the parsers, not the sources or tests', () => {
    expect(files).toContain('package/dist/src/index.js')
    expect(files).toContain('package/dist/src/index.d.ts')
    expect(files).toContain('package/dist/bin/hookshot.js')
    expect(files).toContain('package/native/build/hsparse.wasm')
    expect(files).toContain('package/native/build/wasm_exec.js')
    expect(files).toContain('package/schema/hookshot.schema.json')
    expect(files.filter((f) => !/^package\/(dist\/|schema\/hookshot\.schema\.json$|native\/build\/hsparse|native\/build\/wasm_exec\.js$|package\.json$|README\.md$|LICENSE$)/.test(f))).toEqual([])
  })

  test('node runs the installed CLI on a rules file that imports the package', () => {
    const bin = join(proj, 'node_modules/@tjakit/hookshot/dist/bin/hookshot.js')
    const out = run('node', [bin, 'test', 'rules.ts', 'rm -rf x', 'ls'], proj)
    expect(out).toBe('ask    rm -rf x\n       [rm] rm\nallow  ls\n')
  })

  test('like a global install: rules elsewhere, with no node_modules, resolve to the installed CLI', () => {
    const elsewhere = mk('hookshot-rules-')
    writeFileSync(join(elsewhere, 'hooks.ts'), "import { cmd, hooks } from '@tjakit/hookshot'\nexport default hooks([cmd('rm').deny('no')])\n")
    const bin = join(proj, 'node_modules/@tjakit/hookshot/dist/bin/hookshot.js')
    expect(run('node', [bin, 'test', 'hooks.ts', 'rm x'], elsewhere)).toBe('deny   rm x\n       [rm] no\n')
  })

  test('a hookshot.toml from an unrelated directory runs on the installed CLI', () => {
    const elsewhere = mk('hookshot-toml-')
    writeFileSync(join(elsewhere, 'hookshot.toml'), 'version = 1\n[[deny]]\ncommand = "rm"\nmessage = "no"\n')
    const bin = join(proj, 'node_modules/@tjakit/hookshot/dist/bin/hookshot.js')
    expect(run('node', [bin, 'test', 'hookshot.toml', 'rm x'], elsewhere)).toBe('deny   rm x\n       [rm] no\n')
  })

  test('the installed package finds its parser and installs a hook that points into node_modules', async () => {
    const script = "import('@tjakit/hookshot').then(async (h) => { await h.parse('ls', 'bash'); console.log(JSON.stringify(h.parserStatus())) })"
    const status = JSON.parse(run('node', ['--input-type=module', '-e', script], proj)) as { active?: string; nativeFile?: string }
    const native = files.includes(`package/native/build/${nativeAsset()}`)
    expect(status.active).toBe(native ? 'native' : 'wasm')
    if (native) expect(status.nativeFile).toContain(join(proj, 'node_modules/@tjakit/hookshot/native/build/'))

    const bin = join(proj, 'node_modules/@tjakit/hookshot/dist/bin/hookshot.js')
    const out = run('node', [bin, 'install', 'rules.ts', '--dry-run', '--runtime', 'node'], proj, { ...process.env, HOME: proj })
    expect(out).toContain(JSON.stringify(bin))
  })
})

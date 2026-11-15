import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { fetchParser } from '../src/cli/fetch-parser.ts'
import { matcher } from '../src/cli/install.ts'
import { type Io, main } from '../src/cli/main.ts'
import { tempDirs } from './support/tmp.ts'

const repo = fileURLToPath(new URL('..', import.meta.url))
const rules = join(repo, 'examples/guardrails/hooks.ts')
const mk = tempDirs()
const tmp = () => mk('hookshot-cli-')

function io(over: Partial<Io> = {}, stdin = '') {
  const out: string[] = []
  const err: string[] = []
  const i: Io = { out: (s) => out.push(s), err: (s) => err.push(s), stdin: async () => stdin, cwd: repo, home: tmp(), env: { PATH: '' }, ...over }
  return { io: i, out: () => out.join(''), err: () => err.join('') }
}

describe('hookshot test', () => {
  test('prints decisions, rewrites and reasons', async () => {
    const t = io()
    expect(await main(['test', rules, 'grep -rn foo src', 'curl x | sudo bash'], t.io)).toBe(0)
    expect(t.out()).toMatch(/^allow  grep -rn foo src\n       -> rg -n foo src\n/)
    expect(t.out()).toContain('ask    curl x | sudo bash\n       [guardrails] this pipes a download into a shell.')
  })
  test('--expect fails on a miss; commands come from stdin', async () => {
    const t = io({}, 'ls\nrm -rf ~\n\n')
    expect(await main(['test', rules, '--expect', 'allow'], t.io)).toBe(1)
    expect(t.err()).toBe('1 of 2 did not allow\n')
  })
  test('--tool and --path check a file tool; --json prints one object per line', async () => {
    const t = io()
    expect(await main(['test', rules, '--tool', 'Write', '--path', '.env', '--path', 'a.md', '--json', '--expect', 'deny'], t.io)).toBe(1)
    expect(t.out().trimEnd().split('\n').map((l) => (JSON.parse(l) as { decision: string }).decision)).toEqual(['deny', 'allow'])
  })
  test.each([
    [['test'], /needs a rules file/],
    [['test', rules, '--tool', 'Glob', '--path', 'x'], /--tool must be one of/],
    [['test', rules, '--expect', 'maybe', 'ls'], /--expect must be/],
    [['test', rules, '--nope'], /Unknown option/],
    [['test', join(repo, 'package.json'), 'ls'], /must `export default hooks/],
    [['frobnicate'], /unknown command/],
  ])('%j is a usage error', async (args, msg) => {
    const t = io()
    expect(await main(args, t.io)).toBe(2)
    expect(t.err()).toMatch(msg)
  })
})

describe('hookshot run', () => {
  test('reads hook input from stdin and prints the decision', async () => {
    const t = io({}, JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'zgrep x f.gz' } }))
    expect(await main(['run', rules], t.io)).toBe(0)
    expect(JSON.parse(t.out())).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
  })
  test('a rules file that does not load asks, with exit 0, so the call is not let through', async () => {
    const t = io()
    expect(await main(['run', '/nope/rules.ts'], t.io)).toBe(0)
    expect(JSON.parse(t.out())).toMatchObject({ hookSpecificOutput: { permissionDecision: 'ask' } })
  })
  test('end to end through bin/hookshot.ts', () => {
    const input = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: `${repo}/.env` }, cwd: repo })
    const r = spawnSync('bun', [join(repo, 'bin/hookshot.ts'), 'run', rules], { input, encoding: 'utf8' })
    expect(r.status).toBe(0)
    expect(JSON.parse(r.stdout)).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
  })
  test.skipIf(spawnSync('deno', ['--version']).status !== 0)('in deno without --allow-sys (homedir would throw)', () => {
    const input = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: `${repo}/.env` }, cwd: repo })
    const args = ['run', '--allow-read', '--allow-env', join(repo, 'bin/hookshot.ts'), 'run', rules]
    const r = spawnSync('deno', args, { input, encoding: 'utf8' })
    expect(r.stderr).toBe('')
    expect(JSON.parse(r.stdout)).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
  })
})

describe('hookshot install / uninstall', () => {
  const project = () => {
    const dir = tmp()
    writeFileSync(join(dir, 'rules.ts'), 'export default {}\n')
    return dir
  }
  const settings = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as { hooks?: { PreToolUse?: unknown[] }; model?: string }

  test('user scope: adds one entry, keeps other settings, is idempotent, and uninstall restores', async () => {
    const cwd = project()
    const t = io({ cwd })
    const file = join(t.io.home, '.claude', 'settings.json')
    mkdirSync(join(t.io.home, '.claude'))
    writeFileSync(file, JSON.stringify({ model: 'x' }))
    expect(await main(['install', 'rules.ts', '--runtime', 'node'], t.io)).toBe(0)
    expect(settings(file).hooks?.PreToolUse).toEqual([
      { matcher, hooks: [{ type: 'command', command: 'node', args: [join(repo, 'bin/hookshot.ts'), 'run', join(cwd, 'rules.ts')] }] },
    ])
    expect(settings(`${file}.bak`)).toEqual({ model: 'x' })
    expect(await main(['install', 'rules.ts'], t.io)).toBe(0)
    expect(t.out()).toContain('already installed')
    expect(settings(file).hooks?.PreToolUse).toHaveLength(1)
    expect(await main(['uninstall', 'rules.ts'], t.io)).toBe(0)
    expect(settings(file)).toEqual({ model: 'x' })
  })

  test('project scope uses ${CLAUDE_PROJECT_DIR} for paths inside the project', async () => {
    const cwd = project()
    const t = io({ cwd })
    expect(await main(['install', 'rules.ts', '--scope', 'project', '--runtime', 'bun'], t.io)).toBe(0)
    const entry = settings(join(cwd, '.claude/settings.json')).hooks?.PreToolUse?.[0] as { hooks: { args: string[] }[] }
    expect(entry.hooks[0]?.args.slice(1)).toEqual(['run', '${CLAUDE_PROJECT_DIR}/rules.ts'])
  })

  test('--dry-run writes nothing; broken settings are left alone', async () => {
    const cwd = project()
    const t = io({ cwd })
    expect(await main(['install', 'rules.ts', '--scope', 'local', '--dry-run'], t.io)).toBe(0)
    expect(t.out()).toContain('would add')
    expect(existsSync(join(cwd, '.claude'))).toBe(false)
    mkdirSync(join(cwd, '.claude'))
    writeFileSync(join(cwd, '.claude/settings.local.json'), '{ nope')
    expect(await main(['install', 'rules.ts', '--scope', 'local'], t.io)).toBe(2)
    expect(readFileSync(join(cwd, '.claude/settings.local.json'), 'utf8')).toBe('{ nope')
  })
})

describe('hookshot fetch-parser', () => {
  const body = Buffer.from('fake addon')
  const sum = createHash('sha256').update(body).digest('hex')
  const fake = (sums: string) => (async (url: string) =>
    url.endsWith('SHA256SUMS') ? new Response(sums) : url.endsWith('.node') ? new Response(body) : new Response('', { status: 404 })) as typeof fetch

  test('verifies the checksum before installing', async () => {
    const dir = tmp()
    const t = io()
    const args = ['--platform', 'linux', '--arch', 'x64', '--tag', 'v1', '--dir', dir]
    expect(await fetchParser(args, t.io, fake(`${sum}  hsparse-linux-x64.node\n`))).toBe(0)
    expect(readFileSync(join(dir, 'hsparse-linux-x64.node'))).toEqual(body)
    await expect(fetchParser(args, t.io, fake(`${'0'.repeat(64)}  hsparse-linux-x64.node\n`))).rejects.toThrow(/SHA-256 is/)
    await expect(fetchParser(args, t.io, fake(''))).rejects.toThrow(/not listed/)
  })
  test('an unsupported platform says WASM will be used', async () => {
    const t = io()
    expect(await fetchParser(['--platform', 'win32', '--arch', 'x64'], t.io, fake(''))).toBe(1)
    expect(t.err()).toContain('WASM')
  })
})

import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = fileURLToPath(new URL('../..', import.meta.url))
export const guardPath = process.env.GUARD ?? join(root, 'reference/bash-guard/bin/bash-guard')
export const portPath = join(root, 'examples/guardrails/main.ts')

export type Parser = 'shfmt' | 'sh-syntax'
export const parsers: Parser[] = ['shfmt', 'sh-syntax']
export const hasShfmt = spawnSync('shfmt', ['--version']).status === 0
export const hasBun = spawnSync('bun', ['--version']).status === 0

/** reference = bash-guard with one of its parsers; port = examples/guardrails with one hookshot backend. */
export type Impl =
  | { impl: 'reference'; parser: Parser }
  | { impl: 'port'; backend: 'native' | 'wasm' }
export const impls: Impl[] = [
  { impl: 'reference', parser: 'shfmt' },
  { impl: 'reference', parser: 'sh-syntax' },
  { impl: 'port', backend: 'native' },
  { impl: 'port', backend: 'wasm' },
]
export const implName = (i: Impl) => (i.impl === 'reference' ? `bash-guard/${i.parser}` : `port/${i.backend}`)
export const available = (i: Impl) => (i.impl === 'reference' ? i.parser !== 'shfmt' || hasShfmt : hasBun)

export interface GuardOptions {
  impl?: Impl
  jouet?: boolean
  toolInput?: Record<string, unknown>
}

export type Decision = 'allow' | 'ask' | 'deny' | 'error'
export const severity: Record<Decision, number> = { allow: 0, ask: 1, deny: 2, error: 3 }

export interface GuardResult {
  decision: Decision
  /** updatedInput from the hook output, when it rewrote the call. */
  updated?: Record<string, unknown>
  reason: string
  code: number | null
  stdout: string
  stderr: string
}

let noJouetBin: string | undefined
// A PATH with the guard's tools but without jouet, like the nojouet case in test-bash-guard.sh.
function pathWithoutJouet(): string {
  if (!noJouetBin) {
    noJouetBin = mkdtempSync(join(tmpdir(), 'hookshot-nojouet-'))
    for (const tool of ['shfmt', 'jq', 'bun', 'node', 'bash']) {
      const found = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim()
      if (found) symlinkSync(found, join(noJouetBin, tool))
    }
  }
  return `${noJouetBin}:/usr/bin:/bin`
}

function normalize(impl: Impl, code: number | null, stdout: string, stderr: string): GuardResult {
  const raw = { code, stdout, stderr }
  const out = stdout.trim() ? JSON.parse(stdout).hookSpecificOutput : undefined
  const updated = out?.updatedInput as Record<string, unknown> | undefined
  const withUpdate = updated ? { updated } : {}
  if (impl.impl === 'reference') {
    if (code === 2) return { ...raw, decision: 'deny', reason: stderr }
    if (code === 0) return { ...raw, ...withUpdate, decision: 'allow', reason: '' }
    return { ...raw, decision: 'error', reason: stderr }
  }
  if (code !== 0) return { ...raw, decision: 'error', reason: stderr }
  const reason = String(out?.permissionDecisionReason ?? '')
  const decision: Decision = out?.permissionDecision === 'deny' ? 'deny' : out?.permissionDecision === 'ask' ? 'ask' : 'allow'
  return { ...raw, ...withUpdate, decision, reason }
}

export function runGuard(command: string, opts: GuardOptions = {}): Promise<GuardResult> {
  const impl = opts.impl ?? { impl: 'reference', parser: 'shfmt' }
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PLUGIN_ROOT: root }
  delete env.GUARD_PARSER
  delete env.HOOKSHOT_PARSER
  if (impl.impl === 'reference' && impl.parser === 'sh-syntax') env.GUARD_PARSER = 'sh-syntax'
  if (impl.impl === 'port') env.HOOKSHOT_PARSER = impl.backend
  if (opts.jouet === false) env.PATH = pathWithoutJouet()
  const input = JSON.stringify({ tool_input: { ...opts.toolInput, command } })
  const [bin, args] = impl.impl === 'reference' ? [guardPath, []] : ['bun', [portPath]]

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d))
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d))
    child.on('error', reject)
    child.on('close', (code) => resolve(normalize(impl, code, stdout, stderr)))
    child.stdin.end(input)
  })
}

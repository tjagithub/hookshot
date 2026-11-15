import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { fileTools } from '../claude.ts'
import { context } from '../context.ts'
import type { Hook } from '../hook.ts'
import { resolvePath } from '../paths.ts'
import type { Outcome } from '../verdict.ts'
import { visible } from '../visible.ts'
import { type Io, UsageError, loadHook } from './main.ts'

const decisions = ['allow', 'ask', 'deny'] as const
type Decision = (typeof decisions)[number]

function render(input: string, o: Outcome): string {
  const v = (s: string) => visible(s)
  const lines = [`${o.decision.padEnd(6)} ${visible(input, { keepLines: true })}`]
  if (o.decision !== 'deny' && o.command !== undefined) lines.push(`       -> ${visible(o.command, { keepLines: true })}`)
  if (o.decision !== 'allow') for (const r of o.reasons) lines.push(`       [${v(r.rule)}] ${v(r.message)}`)
  if (o.decision !== 'deny') for (const n of o.notes) lines.push(`       note [${v(n.rule)}] ${v(n.message)}`)
  return `${lines.join('\n')}\n`
}

type Result = { input: string; outcome: Outcome }
type Over = { cwd: string; home: string }

function parseTestArgs(args: string[]) {
  return parseArgs({
    args,
    allowPositionals: true,
    options: {
      tool: { type: 'string' },
      path: { type: 'string', multiple: true },
      cwd: { type: 'string' },
      json: { type: 'boolean', default: false },
      expect: { type: 'string' },
    },
  })
}

function parseExpect(raw: string | undefined): Decision | undefined {
  const expect = raw as Decision | undefined
  if (expect !== undefined && !decisions.includes(expect)) throw new UsageError(`--expect must be one of ${decisions.join(', ')}`)
  return expect
}

async function fileResults(hook: Hook, toolArg: string | undefined, paths: string[] | undefined, over: Over): Promise<Result[]> {
  const tool = toolArg ?? 'Write'
  const op = fileTools[tool]
  if (!op) throw new UsageError(`--tool must be one of ${Object.keys(fileTools).join(', ')}`)
  if (!paths?.length) throw new UsageError('--tool needs --path')
  const ctx = context(over)
  const results: Result[] = []
  for (const p of paths) {
    const file = { op, path: resolvePath(p, ctx), source: 'tool' as const, tool }
    results.push({ input: `${tool} ${p}`, outcome: (await hook.evaluateFile(file, over)).outcome })
  }
  return results
}

async function commandResults(hook: Hook, commands: string[], io: Io, over: Over): Promise<Result[]> {
  const inputs = commands.length ? commands : (await io.stdin()).split('\n').filter((l) => l.trim())
  if (!inputs.length) throw new UsageError('no commands given, on the command line or stdin')
  const results: Result[] = []
  for (const c of inputs) results.push({ input: c, outcome: (await hook.evaluate(c, over)).outcome })
  return results
}

/** Print the results; with an expected decision, report misses and return 1. */
function report(results: Result[], json: boolean, expect: Decision | undefined, io: Io): number {
  for (const r of results) io.out(json ? `${JSON.stringify({ input: r.input, ...r.outcome })}\n` : render(r.input, r.outcome))
  const misses = expect ? results.filter((r) => r.outcome.decision !== expect) : []
  if (misses.length) io.err(`${misses.length} of ${results.length} did not ${expect}\n`)
  return misses.length ? 1 : 0
}

/** `hookshot test rules.ts 'cmd' ...`: print each decision; with --expect, exit 1 when one differs. */
export async function testCommand(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parseTestArgs(args)
  const [rules, ...commands] = positionals
  if (!rules) throw new UsageError('test needs a rules file')
  const expect = parseExpect(values.expect)
  const hook = await loadHook(rules, io)
  const over = { cwd: values.cwd ? resolve(io.cwd, values.cwd) : io.cwd, home: io.home }
  const results = values.tool !== undefined || values.path
    ? await fileResults(hook, values.tool, values.path, over)
    : await commandResults(hook, commands, io, over)
  return report(results, values.json, expect, io)
}

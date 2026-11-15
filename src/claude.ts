import process from 'node:process'
import { type Context, context } from './context.ts'
import type { Hook } from './hook.ts'
import { type FileOp, type FileTarget, resolvePath } from './paths.ts'
import type { Outcome, Reason } from './verdict.ts'

/** The PreToolUse output Claude Code reads, or null for "no opinion" (print nothing). */
export interface PreToolUseOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse'
    permissionDecision?: 'deny' | 'ask'
    permissionDecisionReason?: string
    updatedInput?: Record<string, unknown>
    additionalContext?: string
  }
}

interface HookInput {
  tool_name?: unknown
  tool_input?: Record<string, unknown>
  cwd?: unknown
  session_id?: unknown
}

/** Claude Code tools that touch one file, and how. */
export const fileTools: Readonly<Record<string, FileOp>> = {
  Write: 'write', Edit: 'write', MultiEdit: 'write', NotebookEdit: 'write', Read: 'read',
}

const join = (rs: Reason[]) => rs.map((r) => `[${r.rule}] ${r.message}`).join('\n')

function contextText(notes: Reason[], command?: string): string | undefined {
  const parts = [...(notes.length ? [join(notes)] : []), ...(command !== undefined ? [`hookshot ran: ${command}`] : [])]
  return parts.length ? parts.join('\n') : undefined
}

const base = { hookEventName: 'PreToolUse' as const }
export const asking = (reason: string): PreToolUseOutput => ({
  hookSpecificOutput: { ...base, permissionDecision: 'ask', permissionDecisionReason: reason },
})

// A rewrite alone sets no permissionDecision, so Claude Code's normal permission checks still apply.
function output(outcome: Outcome, toolInput: Record<string, unknown>): PreToolUseOutput | null {
  const next = outcome.decision === 'deny' ? undefined : outcome.command
  const updatedInput = next !== undefined ? { updatedInput: { ...toolInput, command: next } } : {}
  switch (outcome.decision) {
    case 'deny':
      return { hookSpecificOutput: { ...base, permissionDecision: 'deny', permissionDecisionReason: join(outcome.reasons) } }
    case 'ask': {
      const extra = contextText(outcome.notes, next)
      const out = asking(join(outcome.reasons))
      Object.assign(out.hookSpecificOutput, updatedInput, extra ? { additionalContext: extra } : {})
      return out
    }
    case 'allow': {
      const extra = contextText(outcome.notes, next)
      if (next === undefined && !extra) return null
      return { hookSpecificOutput: { ...base, ...updatedInput, ...(extra ? { additionalContext: extra } : {}) } }
    }
    default:
      return outcome satisfies never
  }
}

/** Input without tool_name but with a command is treated as Bash. Tools hookshot does not know get null. */
export async function handlePreToolUse(hook: Hook, input: unknown, defaults: Partial<Context> = {}): Promise<PreToolUseOutput | null> {
  const i = (input ?? {}) as HookInput
  const toolInput = i.tool_input ?? {}
  const tool = typeof i.tool_name === 'string' ? i.tool_name : typeof toolInput.command === 'string' ? 'Bash' : undefined
  const over: Partial<Context> = {
    ...defaults,
    ...(typeof i.cwd === 'string' && i.cwd ? { cwd: i.cwd } : {}),
    ...(typeof i.session_id === 'string' && i.session_id ? { sessionId: i.session_id } : {}),
  }

  if (tool === 'Bash') {
    const command = toolInput.command
    if (typeof command !== 'string' || !command) return null
    return output((await hook.evaluate(command, over)).outcome, toolInput)
  }
  const op = tool !== undefined ? fileTools[tool] : undefined
  if (!op) return null
  const raw = toolInput.file_path ?? toolInput.notebook_path
  if (typeof raw !== 'string' || !raw) return asking(`hookshot: ${tool} call without a file path, so it cannot check it`)
  const file: FileTarget = { op, path: resolvePath(raw, context(over)), source: 'tool', tool }
  return output((await hook.evaluateFile(file, over)).outcome, toolInput)
}

/** Read hook input from stdin, print the decision. Bad input or an internal error asks, never allows. */
export async function runPreToolUse(hook: Hook): Promise<void> {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  process.stdout.write(await respond(hook, raw))
}

/** The text to print for raw hook input: one JSON line, or nothing. Never throws. */
export async function respond(hook: Hook, raw: string): Promise<string> {
  let out: PreToolUseOutput | null
  try {
    out = await handlePreToolUse(hook, JSON.parse(raw))
  } catch (e) {
    out = asking(`hookshot failed, so it cannot vouch for this call: ${e instanceof Error ? e.message : String(e)}`)
  }
  return out ? `${JSON.stringify(out)}\n` : ''
}

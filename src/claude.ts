import process from 'node:process'
import type { Hook } from './hook.ts'
import type { Reason } from './verdict.ts'

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

const join = (rs: Reason[]) => rs.map((r) => `[${r.rule}] ${r.message}`).join('\n')

function context(notes: Reason[], command?: string): string | undefined {
  const parts = [...(notes.length ? [join(notes)] : []), ...(command !== undefined ? [`hookshot ran: ${command}`] : [])]
  return parts.length ? parts.join('\n') : undefined
}

// A rewrite alone sets no permissionDecision, so Claude Code's normal permission checks still apply.
export async function handlePreToolUse(hook: Hook, input: unknown): Promise<PreToolUseOutput | null> {
  const toolInput = (input as { tool_input?: Record<string, unknown> } | null)?.tool_input
  const command = toolInput?.command
  if (typeof command !== 'string' || !command) return null

  const { outcome } = await hook.evaluate(command)
  const base = { hookEventName: 'PreToolUse' as const }
  const next = outcome.decision === 'deny' ? undefined : outcome.command
  const updatedInput = next !== undefined ? { updatedInput: { ...toolInput, command: next } } : {}

  switch (outcome.decision) {
    case 'deny':
      return { hookSpecificOutput: { ...base, permissionDecision: 'deny', permissionDecisionReason: join(outcome.reasons) } }
    case 'ask': {
      const extra = context(outcome.notes, next)
      return {
        hookSpecificOutput: {
          ...base,
          permissionDecision: 'ask',
          permissionDecisionReason: join(outcome.reasons),
          ...updatedInput,
          ...(extra ? { additionalContext: extra } : {}),
        },
      }
    }
    case 'allow': {
      const extra = context(outcome.notes, next)
      if (next === undefined && !extra) return null
      return { hookSpecificOutput: { ...base, ...updatedInput, ...(extra ? { additionalContext: extra } : {}) } }
    }
    default:
      return outcome satisfies never
  }
}

/** Read hook input from stdin, print the decision. Bad input or an internal error asks, never allows. */
export async function runPreToolUse(hook: Hook): Promise<void> {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  let out: PreToolUseOutput | null
  try {
    out = await handlePreToolUse(hook, JSON.parse(raw))
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e)
    out = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: `hookshot failed, so it cannot vouch for this command: ${why}`,
      },
    }
  }
  if (out) process.stdout.write(`${JSON.stringify(out)}\n`)
}

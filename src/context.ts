import { homedir } from 'node:os'
import process from 'node:process'
import type { History, NoHistory } from './state.ts'

/** Where a tool call happens. Claude Code sends `cwd` and `session_id` with every hook call. */
export interface Context {
  /** Directory the command runs in. */
  cwd: string
  /** Project root: relative path patterns are anchored here. */
  root: string
  home: string
  sessionId?: string
  /** Set by hooks() when a rule escalates; see Terminal.escalate. */
  history?: History | NoHistory
}

// Deno throws on env and homedir without --allow-env / --allow-sys; treat that as unset.
const tryGet = <T>(f: () => T): T | undefined => {
  try {
    return f()
  } catch {
    return undefined
  }
}

export function homeDir(): string {
  const h = tryGet(() => process.env.HOME) || tryGet(homedir)
  if (!h) throw new Error('cannot tell the home directory: set HOME (or allow env/sys access in deno)')
  return h
}

export function context(over: Partial<Context> = {}): Context {
  const cwd = over.cwd ?? process.cwd()
  return {
    cwd,
    root: over.root ?? tryGet(() => process.env.CLAUDE_PROJECT_DIR) ?? cwd,
    home: over.home ?? homeDir(),
    ...(over.sessionId !== undefined ? { sessionId: over.sessionId } : {}),
    ...(over.history !== undefined ? { history: over.history } : {}),
  }
}

import { describe, expect, test } from 'vitest'
import { guardrails } from '../examples/guardrails/hooks.ts'
import { handlePreToolUse } from '../src/claude.ts'

// Port-only rules: bash-guard has no file rules, so these are not in the shared case table.
const ctx = { cwd: '/p', root: '/p', home: '/h' }
const decide = async (input: object) => (await handlePreToolUse(guardrails, input, ctx))?.hookSpecificOutput.permissionDecision

describe('guardrails: .env writes', () => {
  test.each([
    [{ tool_name: 'Write', tool_input: { file_path: '/p/.env' } }, 'deny'],
    [{ tool_name: 'Edit', tool_input: { file_path: '/p/api/.env.local' } }, 'deny'],
    [{ tool_name: 'Write', tool_input: { file_path: '/p/.env.example' } }, undefined],
    [{ tool_name: 'Read', tool_input: { file_path: '/p/.env' } }, undefined],
    [{ tool_name: 'Write', tool_input: { file_path: '/p/.envrc' } }, undefined],
    [{ tool_name: 'Bash', tool_input: { command: 'echo K=1 >> .env' } }, 'deny'],
    [{ tool_name: 'Bash', tool_input: { command: 'cp .env.example .env' } }, undefined],
    // bash expands a glob target to an existing file, so .en? may be .env: not known, so ask.
    [{ tool_name: 'Bash', tool_input: { command: 'echo K=1 > .en?' } }, 'ask'],
    [{ tool_name: 'Bash', tool_input: { command: 'echo K=1 | tee .en[v]' } }, 'ask'],
    [{ tool_name: 'Bash', tool_input: { command: 'echo K=1 > .@(env)' } }, 'ask'],
    [{ tool_name: 'Bash', tool_input: { command: 'echo K=1 > ".en?"' } }, undefined],
    [{ tool_name: 'Bash', tool_input: { command: 'echo K=1 > .en\\?' } }, undefined],
  ])('%j -> %s', async (input, want) => {
    expect(await decide(input)).toBe(want)
  })
})

describe('guardrails: rewrites keep the bytes they do not edit', () => {
  // bash-guard drops trailing newlines here; the port only replaces the grep word.
  test.each([['grep x\n'], ['grep x \n\n'], ['ls\ngrep -n x f\n']])('%j', async (command) => {
    const out = await handlePreToolUse(guardrails, { tool_name: 'Bash', tool_input: { command } }, ctx)
    expect(out?.hookSpecificOutput.updatedInput?.command).toBe(command.replace('grep', 'rg'))
  })
})

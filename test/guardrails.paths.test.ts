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
  ])('%j -> %s', async (input, want) => {
    expect(await decide(input)).toBe(want)
  })
})

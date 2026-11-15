import { describe, expect, test } from 'vitest'
import { handlePreToolUse } from '../src/claude.ts'
import { hooks } from '../src/hook.ts'
import { cmd } from '../src/rules/cmd.ts'
import { visible } from '../src/visible.ts'
import { edit, rewrite } from '../src/verdict.ts'
import { display } from '../src/word.ts'

const ch = (n: number) => String.fromCodePoint(n)

describe('visible', () => {
  test.each([
    [`a${ch(0x1b)}[8mb`, 'a\\x1b[8mb'],
    [`x${ch(0x7f)}${ch(0x9b)}`, 'x\\x7f\\x9b'],
    [`${ch(0x202e)}cba`, '\\u202ecba'],
    [`a${ch(0x200b)}b${ch(0x2066)}c${ch(0xfeff)}`, 'a\\u200bb\\u2066c\\ufeff'],
    [`l1\nl2\tx\r`, 'l1\\nl2\\tx\\x0d'],
    [`a${ch(0x2028)}b`, 'a\\u2028b'],
    ['plain ascii, ünïcödé and 漢字 stay', 'plain ascii, ünïcödé and 漢字 stay'],
  ])('%j -> %s', (s, want) => {
    expect(visible(s)).toBe(want)
  })

  test('keepLines keeps newlines and escapes the rest', () => {
    expect(visible(`a\nb${ch(0x1b)}`, { keepLines: true })).toBe('a\nb\\x1b')
  })
})

describe('reasons reach Claude Code escaped; the rewritten command does not', () => {
  const esc = ch(0x1b)
  const h = hooks([
    cmd('rm').deny(({ inv }) => `no ${display(inv.argv.at(-1)!)}`),
    cmd('ls').note(`hidden${esc}[8m text`),
    cmd('grep').then(({ inv }) => rewrite([edit(inv.call, inv.argv[0]!.start, inv.argv[0]!.end, 'rg')!])),
  ])
  test('a rewrite keeps the bytes it runs', async () => {
    const out = await handlePreToolUse(h, { tool_name: 'Bash', tool_input: { command: `grep 'a${esc}b' f` } })
    expect(out?.hookSpecificOutput.updatedInput).toEqual({ command: `rg 'a${esc}b' f` })
    expect(out?.hookSpecificOutput.additionalContext).toBe("hookshot ran: rg 'a\\x1bb' f")
  })
  test('a deny reason built from the command', async () => {
    const out = await handlePreToolUse(h, { tool_name: 'Bash', tool_input: { command: `rm 'a${esc}[2Kb'` } })
    expect(out?.hookSpecificOutput.permissionDecisionReason).toBe('[rm] no a\\x1b[2Kb')
  })
  test('a note', async () => {
    const out = await handlePreToolUse(h, { tool_name: 'Bash', tool_input: { command: 'ls' } })
    expect(out?.hookSpecificOutput.additionalContext).toBe('[ls] hidden\\x1b[8m text')
  })
})

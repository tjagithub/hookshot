import { describe, expect, test } from 'vitest'
import { handlePreToolUse } from '../src/claude.ts'
import { hooks } from '../src/hook.ts'
import { cmd } from '../src/rules/cmd.ts'
import { pipe } from '../src/rules/pipe.ts'
import { redirect } from '../src/rules/redirect.ts'
import type { Rule } from '../src/rules/rule.ts'
import { word } from '../src/rules/word.ts'
import { edit, rewrite } from '../src/verdict.ts'

const decide = async (rules: Rule[], command: string, onUnknown?: 'ask' | 'deny' | 'allow') =>
  (await hooks(rules, onUnknown ? { onUnknown } : {}).evaluate(command)).outcome

describe('cmd()', () => {
  const push = cmd('git', 'push')
    .flags({ aliases: { '-f': '--force' } })
    .withFlag('--force')
    .withoutFlag('--force-with-lease')
    .deny('use --force-with-lease')

  test.each([
    ['git push --force origin x', 'deny'],
    ['git push -f', 'deny'],
    ['git push --force --force-with-lease', 'allow'],
    ['git pull --force', 'allow'],
    ['sudo /usr/bin/git push -f', 'deny'],
    ['git push $opts', 'ask'],
    ['$GIT push --force', 'ask'],
  ])('%s -> %s', async (c, want) => {
    expect((await decide([push], c)).decision).toBe(want)
  })

  test('via() and standalone()', async () => {
    const r = cmd('rm').via('xargs').ask('rm from xargs')
    expect((await decide([r], 'find . | xargs rm')).decision).toBe('ask')
    expect((await decide([r], 'rm x')).decision).toBe('allow')
    const s = cmd('ls').standalone().note('plain ls')
    expect((await decide([s], 'ls && ls | wc -l')).decision).toBe('allow')
  })
})

describe('pipe()', () => {
  const rce = pipe(['curl', 'wget'], ['bash', 'sh', 'zsh']).ask('remote code piped into a shell')
  test.each([
    ['curl -s x | bash', 'ask'],
    ['curl x | tee log | sudo sh', 'ask'],
    ['wget -qO- x |& zsh', 'ask'],
    ['bash | curl x', 'allow'],
    ['curl x > f; bash f', 'allow'],
    ['curl x | (cd /tmp && bash)', 'ask'],
    ['curl x | $SHELL', 'ask'],
  ])('%s -> %s', async (c, want) => {
    expect((await decide([rce], c)).decision).toBe(want)
  })
})

describe('redirect()', () => {
  const env = redirect(/(^|\/)\.env(\.\w+)?$/).deny('do not write .env files')
  test.each([
    ['echo A=1 > .env', 'deny'],
    ['echo A=1 >> config/.env.local', 'deny'],
    ['cmd &> .env', 'deny'],
    ['cat < .env', 'allow'],
    ['echo x 2>&1', 'allow'],
    ['echo x > "$out"', 'ask'],
    ["bash -c 'echo x > .env'", 'deny'],
  ])('%s -> %s', async (c, want) => {
    expect((await decide([env], c)).decision).toBe(want)
  })
  test('onDynamic("ignore") and reads()', async () => {
    expect((await decide([redirect(/\.env$/).onDynamic('ignore').deny('x')], 'echo > "$o"')).decision).toBe('allow')
    expect((await decide([redirect(/\.env$/).reads().ask('reads .env')], 'cat < .env')).decision).toBe('ask')
  })
})

describe('hooks()', () => {
  test('a rule that throws asks instead of passing', async () => {
    const boom: Rule = { name: 'boom', check: () => { throw new Error('bug') } }
    const out = await decide([boom], 'ls')
    expect(out).toMatchObject({ decision: 'ask', reasons: [{ rule: 'boom', message: expect.stringContaining('rule-error') }] })
  })
  test('a rule with no action is a rule error', async () => {
    expect((await decide([cmd('ls')], 'ls')).decision).toBe('ask')
  })
  test('onUnknown=deny blocks what cannot be parsed', async () => {
    expect((await decide([], 'for f (a b) rm -rf ~', 'deny')).decision).toBe('deny')
  })
  test('word() sees wrapper words too', async () => {
    const r = word('no-force', (w) => w.kind === 'literal' && w.text === '--force').deny('no')
    expect((await decide([r], "sudo --force bash -c 'x'")).decision).toBe('deny')
  })
})

describe('handlePreToolUse', () => {
  const rg = cmd('grep').then(({ inv }) => rewrite([edit(inv.call, inv.argv[0]!.start, inv.argv[0]!.end, 'rg')!]))
  const hook = hooks([rg, cmd('rm').ask('rm?'), cmd('dd').deny('no dd'), cmd('ls').note('ls is fine')])
  const run = (command: unknown) => handlePreToolUse(hook, { tool_input: { command, description: 'd' } })

  test('allow with no notes prints nothing; non-Bash input is ignored', async () => {
    expect(await run('echo hi')).toBeNull()
    expect(await handlePreToolUse(hook, { tool_input: { file_path: 'x' } })).toBeNull()
  })
  test('a rewrite keeps other fields and sets no permissionDecision', async () => {
    expect((await run('grep a f'))?.hookSpecificOutput).toEqual({
      hookEventName: 'PreToolUse',
      updatedInput: { command: 'rg a f', description: 'd' },
      additionalContext: 'hookshot ran: rg a f',
    })
  })
  test('ask carries the rewrite; deny does not', async () => {
    expect((await run('grep a f; rm x'))?.hookSpecificOutput).toMatchObject({
      permissionDecision: 'ask',
      updatedInput: { command: 'rg a f; rm x' },
    })
    const d = (await run('grep a f; dd'))?.hookSpecificOutput
    expect(d).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: '[dd] no dd' })
    expect(d?.updatedInput).toBeUndefined()
  })
  test('notes go to additionalContext', async () => {
    expect((await run('ls'))?.hookSpecificOutput.additionalContext).toBe('[ls] ls is fine')
  })
})

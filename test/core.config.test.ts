import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { ConfigInvalid, compileConfig, configRules, loadConfig, parseConfig } from '../src/config/load.ts'
import { hooks } from '../src/hook.ts'
import { fileStore } from '../src/state.ts'
import { tempDirs } from './support/tmp.ts'

const tmp = tempDirs()
const ctx = { root: '/p', home: '/h', cwd: '/p' }
const hook = (toml: string) => {
  const c = compileConfig(parseConfig(`version = 1\n${toml}`))
  return hooks(c.rules, { ...c.options, store: null })
}
const decide = async (toml: string, command: string) => (await hook(toml).evaluate(command, ctx)).outcome
const errors = (toml: string) => {
  try {
    parseConfig(toml)
  } catch (e) {
    if (e instanceof ConfigInvalid) return e.errors.map((x) => `${x.path}: ${x.message}`)
    throw e
  }
  return []
}

describe('matchers decide like their builders', () => {
  test.each([
    ['[[deny]]\ncommand = "rm"\nflags = ["-r"]\nmessage = "no"', 'rm -fr x', 'deny'],
    ['[[deny]]\ncommand = "rm"\nflags = ["-r"]\nmessage = "no"', 'rm -f x', 'allow'],
    ['[[deny]]\ncommand = "rm"\nwithout_flags = ["-i"]\nmessage = "no"', 'rm -i x', 'allow'],
    ['[[ask]]\ncommand = "git"\nsubcommand = ["push"]\nmessage = "?"', 'git push', 'ask'],
    ['[[ask]]\ncommand = "git"\nsubcommand = ["push"]\nmessage = "?"', 'git pull', 'allow'],
    ['[[deny]]\ncommand = "rm"\nvia = ["sudo"]\nmessage = "no"', 'sudo rm x', 'deny'],
    ['[[deny]]\ncommand = "rm"\nvia = ["sudo"]\nmessage = "no"', 'rm x', 'allow'],
    ['[[deny]]\ncommand = "rm"\nstandalone = true\nmessage = "no"', 'rm x | cat', 'allow'],
    ['[[deny]]\ncommand = "tar"\nflags = ["-x"]\nvalue_flags = ["-f"]\nmessage = "no"', 'tar -f -x', 'allow'],
    ['[[deny]]\ncommand = "tar"\nflags = ["-x"]\nmessage = "no"', 'tar -xf a', 'deny'],
    ['[[ask]]\npipe = { from = "curl", to = ["sh"] }\nmessage = "?"', 'curl x | tee l | sh', 'ask'],
    ['[[deny]]\nword = { prefix = "--force" }\nmessage = "no"', 'echo "--force"', 'allow'],
    ['[[deny]]\nword = { prefix = "--force", unquoted = false }\nmessage = "no"', 'echo "--force"', 'deny'],
    ['[[deny]]\npath = "**/*.lock"\nmessage = "no"', 'echo > a/b.lock', 'deny'],
    ['[[deny]]\npath = "**/*.lock"\nop = "read"\nmessage = "no"', 'echo > a.lock', 'allow'],
    ['[[deny]]\npath = "**/*.lock"\nmessage = "no"', 'echo > "$f"', 'ask'],
    ['[[deny]]\npath = "**/*.lock"\non_dynamic = "ignore"\nmessage = "no"', 'echo > "$f"', 'allow'],
    ['[[deny]]\npath = "/**/.env*"\nexcept = ["/**/*.example"]\nmessage = "no"', 'echo > .env.example', 'allow'],
    ['[[note]]\ncommand = "ls"\nmessage = "fyi"', 'ls', 'allow'],
    ['on_unknown = "deny"\n[[deny]]\npath = "**/*.lock"\nmessage = "no"', 'echo > "$f"', 'deny'],
  ])('%s | %s -> %s', async (toml, command, want) => {
    expect((await decide(toml, command)).decision).toBe(want)
  })

  test('placeholders fill {path} and {arg}; a note reaches the outcome', async () => {
    const rm = await decide('[[deny]]\ncommand = "rm"\nargs = ["/", "~"]\nmessage = "not {arg} ({path})"', 'rm -r ~')
    expect(rm).toEqual({ decision: 'deny', reasons: [{ rule: 'rm', message: 'not ~ ({path})' }] })
    const p = await decide('[[deny]]\nname = "env"\npath = "**/.env"\nmessage = "not {path}"', 'echo > .env')
    expect(p).toEqual({ decision: 'deny', reasons: [{ rule: 'env', message: 'not /p/.env' }] })
    const n = await decide('[[note]]\ncommand = "ls"\nmessage = "fyi"', 'ls')
    expect(n).toMatchObject({ notes: [{ rule: 'ls', message: 'fyi' }] })
  })

  test('args: a run-time word that could be one is unknown', async () => {
    expect((await decide('[[deny]]\ncommand = "rm"\nargs = ["/"]\nmessage = "no"', 'rm "$d"')).decision).toBe('ask')
  })

  test('escalate counts firings', async () => {
    const c = compileConfig(parseConfig('version = 1\n[[note]]\ncommand = "ls"\nmessage = "fyi"\nescalate = { after = 1, within = "1h", to = "deny" }'))
    const h = hooks(c.rules, { store: fileStore(tmp('hookshot-config-')) })
    const run = async () => (await h.evaluate('ls', { ...ctx, sessionId: 's' })).outcome.decision
    expect([await run(), await run()]).toEqual(['allow', 'deny'])
  })
})

describe('rewrite', () => {
  const grep = `[[rewrite]]\nname = "g"\ncommand = "grep"\nto = "rg"\nmessage = "use rg"\nnote = "n"\n[rewrite.flags]\n"-r" = ""\n"-n" = "-n"\n`
  test('maps flags and keeps the rest of the command', async () => {
    expect(await decide(grep, 'grep -rn x src && ls')).toEqual({ decision: 'allow', command: 'rg -n x src && ls', notes: [{ rule: 'g', message: 'n' }] })
    expect(await decide(grep, 'grep -r')).toMatchObject({ decision: 'allow', command: 'rg' })
  })
  test('refuses with the message and the reason; refuse = "ask" asks', async () => {
    expect(await decide(grep, 'grep -e x')).toEqual({ decision: 'deny', reasons: [{ rule: 'g', message: 'use rg (no rg equivalent for -e)' }] })
    expect((await decide(`${grep.replace('note = "n"', 'refuse = "ask"')}`, 'grep -e x')).decision).toBe('ask')
    expect(await decide(grep, `bash -c "grep -n x"`)).toMatchObject({ decision: 'deny', reasons: [{ message: expect.stringContaining('eval') }] })
  })
  test('unlisted and after_args keep; like inherits a table', async () => {
    const keep = grep.replace('note = "n"', 'unlisted = "keep"\nafter_args = "keep"')
    expect(await decide(keep, 'grep -z x f -n')).toMatchObject({ command: 'rg -z x f -n' })
    const like = `${keep}[[rewrite]]\ncommand = "fgrep"\nlike = "g"\nto = "rg"\nadd = ["-F"]\nmessage = "m"\n[rewrite.flags]\n"-n" = "--line-number"\n`
    expect(await decide(like, 'fgrep -rnz x')).toMatchObject({ command: 'rg -F --line-number -z x' })
  })
})

describe('errors name the key path', () => {
  test.each([
    ['', [': missing "version"']],
    ['version = 2', ['version: must be 1']],
    ['version = 1\nfoo = 1', ['foo: unknown key "foo"']],
    ['version = 1\n[[deny]]\ncommand = 1\nmessage = "m"', ['deny[0].command: expected string, or array, got integer']],
    ['version = 1\n[[deny]]\ncommand = "a"\nflags = ["-a", 2]\nmessage = "m"', ['deny[0].flags[1]: expected string, got integer']],
    ['version = 1\n[[deny]]\ncommand = "a"\npath = "x"\nmessage = "m"', ['deny[0]: needs exactly one of "command", "pipe", "path", "word" (has "command", "path")']],
    ['version = 1\n[[ask]]\nmessage = "m"', ['ask[0]: needs exactly one of "command", "pipe", "path", "word"']],
    ['version = 1\n[[ask]]\ncommand = "a"', ['ask[0]: missing "message"']],
    ['version = 1\n[[ask]]\npath = "x"\nflags = ["-a"]\nmessage = "m"', ['ask[0].flags: only applies with "command"']],
    ['version = 1\n[[deny]]\npath = "{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}{o,p}{q,r}"\nmessage = "m"', [expect.stringMatching(/^deny\[0\]\.path: glob .* expands to more than \d+ patterns$/)]],
    ['version = 1\n[[note]]\ncommand = "a"\nmessage = "m"\nescalate = { after = 1, to = "deny", within = "5x" }', ['note[0].escalate.within: "5x" does not match ^\\d+[smhd]$']],
    ['version = 1\n[[rewrite]]\ncommand = "a"\nto = "b"\nmessage = "m"\nflags = { "-ab" = "" }', ['rewrite[0].flags["-ab"]: "-ab" is not one flag (-x or --name)']],
    ['version = 1\n[[rewrite]]\ncommand = "a"\nto = "b"\nmessage = "m"\nflags = { "x" = "" }', ['rewrite[0].flags.x: key "x" does not match ^-']],
    ['version = 1\n[[rewrite]]\ncommand = "a"\nto = "b"\nmessage = "m"\nflags = { "-a" = true }', ['rewrite[0].flags["-a"]: must be false']],
    ['version = 1\n[[rewrite]]\ncommand = "a"\nto = "b"\nmessage = "m"\nflags = { "-a" = { to = "-b", value = "word" } }', ['rewrite[0].flags["-a"].value: expected "number" or "any", or array, got string']],
    ['version = 1\n[[rewrite]]\ncommand = "a"\nto = "b"\nmessage = "m"\nlike = "z"', ['rewrite[0].like: no earlier rewrite named "z"']],
    ['version = 1\nwhen = 1979-05-27', ['when: unknown key "when"']],
    ['version = 1\n[[deny]]\ncommand = "a"\nmessage = 1979-05-27', ['deny[0].message: expected string, got date']],
  ])('%s', (toml, want) => {
    expect(errors(toml)).toEqual(want)
  })

  test('a TOML syntax error gives the line and column', () => {
    expect(errors('version = 1\nx = = 2')[0]).toMatch(/^: line 2, column \d+: /)
  })
  test('the error message joins every error, with the file', () => {
    expect(() => parseConfig('version = 2\nfoo = 1', 'my.toml')).toThrow('my.toml: version: must be 1; foo: unknown key "foo"')
  })
})

describe('files', () => {
  test('loadConfig and configRules read a file; options override the file', async () => {
    const f = join(tmp('hookshot-config-'), 'h.toml')
    writeFileSync(f, 'version = 1\non_unknown = "allow"\n[[deny]]\npath = "x/*"\nmessage = "m"\n')
    expect(configRules(f).map((r) => r.name)).toEqual(['path x/*'])
    expect((await loadConfig(f).evaluate('echo > "$f"', ctx)).outcome.decision).toBe('allow')
    expect((await loadConfig(f, { onUnknown: 'ask' }).evaluate('echo > "$f"', ctx)).outcome.decision).toBe('ask')
  })
})

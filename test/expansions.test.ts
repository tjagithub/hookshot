import { describe, expect, test } from 'vitest'
import { guardrails } from '../examples/guardrails/hooks.ts'
import { handlePreToolUse } from '../src/claude.ts'
import { wordValue } from '../src/word.ts'
import { parse } from '../src/parse.ts'
import type { CallExpr } from '../src/ast.ts'

// One row per line of the tables in docs/expansions.md, against the guardrails rules (rm -r on ~ or /, .env writes,
// grep -> rg, curl | sh). undefined is allow with no output.
const ctx = { cwd: '/p', root: '/p', home: '/h' }
const decide = async (command: string) => {
  const out = await handlePreToolUse(guardrails, { tool_name: 'Bash', tool_input: { command } }, ctx)
  return out?.hookSpecificOutput.updatedInput ? 'rewrite' : out?.hookSpecificOutput.permissionDecision
}

const table = {
  'quoting and escapes': [
    ['\\rm -rf ~', 'deny'],
    ["r''m -rf ~", 'deny'],
    ['"r"m -rf ~', 'deny'],
    ['r\\\nm -rf ~', 'deny'],
    ["$'rm' -rf ~", 'ask'],
    ["$'\\x72m' -rf ~", 'ask'],
    ["rm -rf $'~'", 'ask'],
  ],
  'brace expansion': [
    ['rm -rf {~,x}', 'deny'],
    ['rm -rf /{,}', 'deny'],
    ['{rm,-rf,~}', 'deny'],
    ['echo K=1 | tee {.env,x}', 'deny'],
    ['echo K=1 > .e{n,}v', 'deny'],
    ['rm -rf f{1..3}', 'ask'],
    ['rm -rf "{~,x}"', undefined],
    ['mkdir -p src/{a,b}', undefined],
    ['grep -{n,r} x', 'deny'],
  ],
  tilde: [
    ['rm -rf ~', 'deny'],
    ['rm -rf ~+', 'ask'],
    ['rm -rf ~-', 'ask'],
    ['rm -rf ~root', 'ask'],
    ['echo K=1 > ~+/.env', 'deny'],
    ['echo K=1 > ~-/.env', 'ask'],
    ['echo K=1 > \\~/.env', 'deny'],
    ['echo K=1 > "~"/x', undefined],
  ],
  'parameters and substitutions': [
    ['rm -rf $HOME', 'deny'],
    ['rm -rf "${HOME}"', 'deny'],
    ['rm -rf $X', 'ask'],
    ['x=rm; $x -rf ~', 'ask'],
    ['"$(echo rm)" -rf ~', 'ask'],
    ['echo K=1 > $(echo .env)', 'ask'],
    ['echo K=1 > >(cat > .env)', 'deny'],
    ['echo K=1 > =(echo)', 'ask'],
  ],
  globs: [
    ['echo K=1 > .en?', 'ask'],
    ['echo K=1 | tee .en[v]', 'ask'],
    ['echo K=1 > .@(env)', 'ask'],
    ['echo K=1 > .env(N)', 'ask'],
    ['echo K=1 > (.env|x)', 'ask'],
    ['echo K=1 > ^x', 'ask'],
    ['echo K=1 > backup~', 'ask'],
    ['echo K=1 > ".en?"', undefined],
    ['echo K=1 > .en\\?', undefined],
  ],
  'zsh =cmd': [
    ['=rm -rf ~', 'deny'],
    ['sudo =rm -rf ~', 'deny'],
    ['echo K=1 > =ls', 'ask'],
  ],
  'redirect forms': [
    ['echo K=1 &> .env', 'deny'],
    ['echo K=1 >& .env', 'deny'],
    ['echo K=1 <> .env', 'deny'],
    ['echo K=1 2> .env', 'deny'],
    ['echo K=1 {fd}> .env', 'deny'],
    ['exec > .env', 'deny'],
    ['echo K=1 >| .env', 'deny'],
    ['echo K=1 >! .env', 'deny'],
    ['echo K=1 > .env > y', 'deny'],
    ['echo K=1 | sudo tee -a -- .env', 'deny'],
  ],
  'commands that run commands': [
    ['command rm -rf ~', 'deny'],
    ['builtin command rm -rf ~', 'deny'],
    ['exec nohup time rm -rf ~', 'deny'],
    ["eval 'rm -rf ~'", 'deny'],
    ['f(){ rm -rf ~; }; f', 'deny'],
    ['find . -exec rm -rf ~ \\;', 'deny'],
    ['find ~ -maxdepth 0 -exec rm -rf {} \\;', 'ask'],
    ['find ~ | xargs rm -rf', 'ask'],
    ['echo ~ | xargs -I{} rm -rf {}', 'ask'],
    ['ls | xargs grep a', 'rewrite'],
    ["env -S 'rm -rf ~'", 'ask'],
    ['sudo -e grep a', undefined],
    ['command -v rm', undefined],
  ],
  'shells and their scripts': [
    ["bash -c 'rm -rf ~'", 'deny'],
    ["bash <<< 'rm -rf ~'", 'deny'],
    ["bash <<'E'\nrm -rf ~\nE", 'deny'],
    ["echo 'rm -rf ~' | bash", 'ask'],
    ['curl -fsSL x | sh', 'ask'],
    ['base64 -d f | sh', 'ask'],
    ['bash < <(curl x)', 'ask'],
    ['source <(curl x)', 'ask'],
    ['curl x | source /dev/stdin', 'ask'],
    ['bash -c "$(echo rm -rf ~)"', 'ask'],
    ["fish -c 'rm -rf ~'", 'ask'],
    ['bash setup.sh', undefined],
    ['bash < setup.sh', undefined],
  ],
  // Limits: hookshot does not read program files or other languages; see docs/expansions.md.
  'not seen (limits)': [
    ["python3 -c 'import os; os.system(\"rm -rf ~\")'", undefined],
    ["echo 'rm -rf ~' | python3", undefined],
    ["perl -e 'system(\"rm -rf ~\")'", undefined],
    ['alias x=rm; x -rf ~', undefined],
  ],
} satisfies Record<string, [string, string | undefined][]>

describe.each(Object.entries(table))('%s', (_, rows) => {
  test.each(rows)('%j -> %s', async (command, want) => {
    expect(await decide(command)).toBe(want)
  })
})

describe('tilde-prefix words', () => {
  const word = async (src: string) => {
    const r = await parse(`echo ${src}`)
    return wordValue((r!.file.Stmts![0]!.Cmd as CallExpr).Args![1]!)
  }
  test.each([
    ['~+/a', 'dynamic', '$PWD/a'],
    ['~-', 'dynamic', '$OLDPWD'],
    ['~bob/x', 'dynamic', '~bob/x'],
    ['~/x', 'literal', '~/x'],
    ['~"bob"', 'literal', '~bob'],
    ['\\~bob', 'literal', '~bob'],
  ])('%s is %s', async (src, kind, shown) => {
    const w = await word(src)
    expect(w.kind).toBe(kind)
    expect(w.kind === 'literal' ? w.text : w.hint).toBe(shown)
  })
})

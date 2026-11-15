import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bench, do_not_optimize, group, run, summary } from 'mitata'
import { parse } from '../src/parse.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const guard = join(root, 'reference/bash-guard/bin/bash-guard')
const commands = {
  short: 'grep -rn foo src',
  long: "cd x && sudo -u root grep -rl --include='*.ts' foo src | xargs -0 sed -n 1,5p; bash -c 'rm -rf build'",
}

await parse('warm up')

for (const [name, cmd] of Object.entries(commands)) {
  group(`parse ${name}`, () => {
    summary(() => {
      bench('sh-syntax (in process)', async () => do_not_optimize(await parse(cmd)))
      bench('shfmt --to-json (subprocess)', () =>
        do_not_optimize(spawnSync('shfmt', ['-ln', 'zsh', '--to-json'], { input: cmd }).stdout))
    })
  })

  group(`bash-guard end to end, ${name}`, () => {
    const input = JSON.stringify({ tool_input: { command: cmd } })
    summary(() => {
      for (const parser of ['shfmt', 'sh-syntax']) {
        const env = { ...process.env, CLAUDE_PLUGIN_ROOT: root, GUARD_PARSER: parser }
        bench(`bash-guard (${parser})`, () => do_not_optimize(spawnSync(guard, [], { input, env }).status))
      }
    })
  })
}

await run()

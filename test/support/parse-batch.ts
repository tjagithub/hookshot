// Runs under node, bun or deno: stdin is a JSON array of commands; stdout {backend, status, trees}.
import process from 'node:process'
import { activeBackend, parse, parserStatus, type BackendState } from '../../src/parse.ts'

let input = ''
for await (const chunk of process.stdin) input += chunk
const cmds: string[] = JSON.parse(input)
const trees = []
for (const c of cmds) trees.push((await parse(c))?.file ?? null)

const plain = (s: BackendState) => ('error' in s && s.error ? { ...s, error: s.error.message } : s)
const { native, wasm } = parserStatus()
process.stdout.write(
  JSON.stringify({ backend: await activeBackend(), status: { native: plain(native), wasm: plain(wasm) }, trees }),
)

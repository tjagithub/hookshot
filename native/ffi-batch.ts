// Test helper, run with bun: stdin is a JSON array of commands, stdout {trees}.
import { parse } from './ffi.ts'

const cmds: string[] = await Bun.stdin.json()
const trees = cmds.map((c) => {
  const json = parse(c)
  return json === null ? null : JSON.parse(json)
})
process.stdout.write(JSON.stringify({ trees }))

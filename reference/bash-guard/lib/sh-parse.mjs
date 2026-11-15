// shfmt --to-json fallback: parse stdin with sh-syntax (mvdan/sh as WASM), print it in shfmt's JSON
// shape. Exit 3: sh-syntax not found; exit 1: not valid zsh or bash.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const dirs = [process.env.CLAUDE_PLUGIN_ROOT, process.env.CLAUDE_PLUGIN_DATA, join(import.meta.dirname, '..')]
let sh
for (const d of dirs.filter(Boolean)) {
  try {
    sh = createRequire(join(d, 'package.json'))('sh-syntax')
    break
  } catch {}
}
if (!sh) process.exit(3)

// sh-syntax: {type, start, end, args, op: 11}; shfmt: {Type, Pos: {Offset}, End: {Offset}, Args, Op: "&&"}.
const binaryOps = { 11: '&&', 12: '||', 13: '|', 14: '|&' }
const shape = (v) => {
  if (Array.isArray(v)) return v.map(shape)
  if (!v || typeof v !== 'object') return v
  const out = {}
  for (const [k, x] of Object.entries(v)) {
    if (k === 'start' && typeof x === 'number') out.Pos = { Offset: x }
    else if (k === 'end' && typeof x === 'number') out.End = { Offset: x }
    else if (k === 'op' && v.type === 'BinaryCmd') out.Op = binaryOps[x] ?? x
    else out[k[0].toUpperCase() + k.slice(1)] = shape(x)
  }
  return out
}

const text = readFileSync(0, 'utf8')
for (const variant of [sh.LangVariant.LangZsh, sh.LangVariant.LangBash]) {
  try {
    process.stdout.write(JSON.stringify(shape(await sh.parse(text, { variant }))))
    process.exit(0)
  } catch {}
}
process.exit(1)

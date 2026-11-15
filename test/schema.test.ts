import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { template } from '../src/cli/config.ts'
import { parseConfig } from '../src/config/load.ts'
import { schema, schemaUrl } from '../src/config/schema.ts'
import { validate } from '../src/config/validate.ts'

const repo = fileURLToPath(new URL('..', import.meta.url))
type Node = Record<string, unknown>

// Every object under properties (and $defs entries) a user can hover over.
function properties(node: unknown, at: string, out: [string, Node][] = []): [string, Node][] {
  if (Array.isArray(node)) node.forEach((n, i) => properties(n, `${at}[${i}]`, out))
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Node)) {
      if (k === 'properties' || k === '$defs') for (const [name, p] of Object.entries(v as Node)) out.push([`${at}.${name}`, p as Node])
      properties(v, `${at}.${k}`, out)
    }
  }
  return out
}

describe('schema', () => {
  test('schema/hookshot.schema.json is current (run pnpm schema)', () => {
    expect(JSON.parse(readFileSync(join(repo, 'schema/hookshot.schema.json'), 'utf8'))).toEqual(JSON.parse(JSON.stringify(schema)))
  })
  test('every property has a description', () => {
    const missing = properties(schema, '').filter(([, p]) => typeof p.description !== 'string' && typeof p.$ref !== 'string')
    expect(missing.map(([at]) => at)).toEqual([])
  })
  test('the init template and the examples validate', () => {
    expect(template.startsWith(`#:schema ${schemaUrl}\n`)).toBe(true)
    expect(() => parseConfig(template)).not.toThrow()
    const dir = join(repo, 'examples/guardrails-toml')
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.toml'))) {
      expect(() => parseConfig(readFileSync(join(dir, f), 'utf8'), f)).not.toThrow()
    }
  })
  test('the validator refuses keywords it does not know, and unknown $refs', () => {
    expect(() => validate(1, { maximum: 2 })).toThrow('unsupported schema keyword maximum')
    expect(() => validate(1, { $ref: '#/$defs/nope' })).toThrow('unknown $ref')
  })
})

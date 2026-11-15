import { fc, test } from '@fast-check/vitest'
import { describe, expect } from 'vitest'
import { activeBackend, parse, type Backend, type Node } from '../src/parse.ts'
import { numRuns, shellSoup } from './support/arbitraries.ts'

function* nodes(v: unknown): Generator<Node> {
  if (Array.isArray(v)) for (const x of v) yield* nodes(x)
  else if (v && typeof v === 'object') {
    if ('Pos' in v && 'End' in v) yield v as Node
    for (const x of Object.values(v)) yield* nodes(x)
  }
}

const plainWord = fc
  .string({ unit: 'grapheme', minLength: 1, maxLength: 12 })
  .filter((s) => /^[^\s\\'"$`|&;()<>{}#*?[\]~=!%^]+$/.test(s))

test('picks native when the addon loads', async () => {
  expect(await activeBackend()).toBe('native')
})

describe.each<Backend>(['native', 'wasm'])('parse (%s)', (backend) => {
  test('zsh first, bash as fallback, null when neither parses', async () => {
    expect((await parse('echo hi', { backend }))?.dialect).toBe('zsh')
    expect(await parse('echo $(', { backend })).toBeNull()
  })

  test.prop([fc.oneof(shellSoup, fc.string({ unit: 'grapheme', maxLength: 40 }))], { numRuns: numRuns * 25 })(
    'never throws; node ranges are ordered and inside the input bytes',
    async (text) => {
      const p = await parse(text, { backend })
      if (!p) return
      const bytes = Buffer.byteLength(text)
      for (const n of nodes(p.file)) {
        expect(n.Pos.Offset).toBeLessThanOrEqual(n.End.Offset)
        expect(n.End.Offset).toBeLessThanOrEqual(bytes)
      }
    },
  )

  // bash-guard edits the command by these offsets, so they must be byte offsets, not UTF-16 indexes.
  test.prop([plainWord], { numRuns: numRuns * 25 })('Lit offsets are UTF-8 byte offsets', async (word) => {
    const text = `ü ${word}`
    const p = await parse(text, { backend })
    fc.pre(p !== null)
    const buf = Buffer.from(text)
    for (const n of nodes(p!.file)) {
      if (n.Type !== 'Lit' || typeof n.Value !== 'string') continue
      expect(buf.subarray(n.Pos.Offset, n.End.Offset).toString()).toBe(n.Value)
    }
  })
})

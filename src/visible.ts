// Text hookshot shows a person (reasons, `hookshot test` output) must not drive their terminal: ESC[8m hides
// text, ESC[2K erases a line, U+202E reverses it. Such characters become visible escapes; the command that runs is untouched.

// C0 and DEL/C1 controls, zero-width and direction marks, line/paragraph separators, bidi embeds and isolates, BOM.
const ranges: [number, number][] = [
  [0x00, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2064], [0x2066, 0x2069], [0xfeff, 0xfeff],
]
const hex = (n: number) => `\\u{${n.toString(16)}}`
const pattern = (skipNewline: boolean) => {
  const set = ranges.map(([a, b]) => (a === b ? hex(a) : `${hex(a)}-${hex(b)}`)).join('')
  return new RegExp(skipNewline ? `(?!\\n)[${set}]` : `[${set}]`, 'gu')
}
const hidden = pattern(false)
const hiddenButNewline = pattern(true)

const escape = (c: string) => {
  if (c === '\n') return '\\n'
  if (c === '\t') return '\\t'
  const n = c.codePointAt(0)!
  return n < 0x100 ? `\\x${n.toString(16).padStart(2, '0')}` : `\\u${n.toString(16).padStart(4, '0')}`
}

/** s with control, bidi and zero-width characters escaped (ESC as \x1b, U+202E as \u202e); newlines too unless keepLines. */
export const visible = (s: string, { keepLines = false } = {}): string => s.replace(keepLines ? hiddenButNewline : hidden, escape)

import fc from 'fast-check'

export const numRuns = Number(process.env.FC_RUNS ?? 40)

const tokens = [
  'grep', 'egrep', 'fgrep', 'rg', 'sed', 'rm', 'git', 'echo', 'cat', 'sudo', 'xargs', 'env', 'timeout', '5',
  'find', '.', '-exec', '{}', '+', 'bash', '-c', 'eval', 'command', '-v', '-n', '-i', '-r', '-rf', '-rn', '-l',
  '-A', '3', '-e', '--force', '--include=*.py', '1,5p', 'foo', 'f', '~', '/', '$HOME', 'ü', '|', '&&', '||',
  ';', '&', '>', 'out', '$(', ')', '`', "'", '"', '(', '{', '}', '\\', '#', '\n',
]

/** Shell-ish soup: mostly parseable, often not. Exercises the parser and every rule. */
export const shellSoup = fc.array(fc.constantFrom(...tokens), { minLength: 1, maxLength: 12 }).map((ts) => ts.join(' '))

const sqText = fc.string({ unit: 'grapheme', maxLength: 30 }).filter((s) => !s.includes("'") && !s.includes('\0'))

/** Any text inside single quotes is inert: echo '<text>'. */
export const quotedEcho = sqText.map((s) => `echo '${s}'`)

const grepFlags = ['-r', '-n', '-i', '-l', '-w', '-v', '-c', '-o', '-F', '-E', '-h', '-z', '-e', '-A 2', '-C1',
  '--include=*.ts', "--exclude-dir='dist'", '--count', '--null', '--color=never']

/** grep reached through a wrapper or pipeline, with flags rg may or may not have. */
export const grepCommand = fc
  .record({
    prefix: fc.constantFrom('', 'sudo ', 'xargs ', 'cat x | ', 'ls && ', 'timeout 5 ', 'env A=1 '),
    head: fc.constantFrom('grep', 'egrep', 'fgrep', '/usr/bin/grep'),
    flags: fc.subarray(grepFlags, { maxLength: 4 }),
    pattern: fc.constantFrom('foo', "'a|b'", '"x y"', 'TODO'),
    path: fc.constantFrom('', ' .', ' src', ' "a b"'),
  })
  .map(({ prefix, head, flags, pattern, path }) => `${prefix}${head} ${[...flags, pattern].join(' ')}${path}`)

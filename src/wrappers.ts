import { type WordValue, display } from './word.ts'

export interface WrapperSpec {
  /** Short flags that take a value, in the same word (`-uroot`) or the next one (`-u root`). */
  valueFlags: string
  /** Long flags that take the next word as a value when written without `=`. */
  valueLongFlags?: readonly string[]
  /** Positional words before the wrapped command, e.g. timeout's duration. */
  positionals?: number
  /** env-style NAME=value words before the command. */
  assignments?: boolean
  /** Flags that make the wrapper not run a command at all (`command -v`, `sudo -l`). */
  noRun?: readonly string[]
  /** Flags whose value is a command line we cannot see into (`env -S`). */
  opaque?: readonly string[]
}

export const wrappers: Readonly<Record<string, WrapperSpec>> = {
  sudo: {
    valueFlags: 'ugpCDhrtUT',
    valueLongFlags: ['--user', '--group', '--prompt', '--chdir', '--host', '--role', '--type', '--other-user'],
    noRun: ['-l', '--list', '-v', '--validate', '-k', '-K', '--remove-timestamp', '-e', '--edit', '-V', '--version'],
  },
  doas: { valueFlags: 'uC' },
  env: {
    valueFlags: 'uCPS',
    valueLongFlags: ['--unset', '--chdir'],
    assignments: true,
    opaque: ['-S', '--split-string'],
  },
  xargs: { valueFlags: 'ILnPsdEJRSa' },
  gxargs: { valueFlags: 'ILnPsdEJRSa' },
  nice: { valueFlags: 'n', valueLongFlags: ['--adjustment'] },
  nohup: { valueFlags: '' },
  builtin: { valueFlags: '' },
  noglob: { valueFlags: '' },
  nocorrect: { valueFlags: '' },
  exec: { valueFlags: 'a' },
  stdbuf: { valueFlags: 'ioe' },
  time: { valueFlags: 'of' },
  timeout: { valueFlags: 'sk', valueLongFlags: ['--signal', '--kill-after'], positionals: 1 },
  gtimeout: { valueFlags: 'sk', valueLongFlags: ['--signal', '--kill-after'], positionals: 1 },
  command: { valueFlags: '', noRun: ['-v', '-V'] },
  repeat: { valueFlags: '', positionals: 1 },
}

/** Shells whose `-c` script we parse again. fish and others are not bash or zsh, so they stay opaque. */
export const parsedShells: ReadonlySet<string> = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'mksh'])
export const opaqueShells: ReadonlySet<string> = new Set(['fish', 'nu', 'pwsh', 'csh', 'tcsh', 'xonsh', 'elvish'])

export const findExecFlags: ReadonlySet<string> = new Set(['-exec', '-execdir', '-ok', '-okdir'])

/** Basename of a command word when its last path segment is literal, else undefined. */
export function commandName(w: WordValue | undefined): string | undefined {
  if (!w) return undefined
  if (w.kind === 'literal') return w.text.split('/').pop()
  const last = w.segments.at(-1)
  if (typeof last !== 'string' || !last.includes('/')) return undefined
  return last.split('/').pop()
}

export type Unwrapped =
  | { kind: 'run'; argv: WordValue[]; via: string[] }
  | { kind: 'none'; via: string[] }
  | { kind: 'unknown'; why: 'opaque-wrapper'; detail: string; via: string[] }

const isAssignment = (t: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)

/** Strip wrappers (sudo, env, timeout ...) from the front of argv, per the table above. */
export function unwrap(argv: WordValue[], table: Readonly<Record<string, WrapperSpec>> = wrappers): Unwrapped {
  const via: string[] = []
  let rest = argv
  for (;;) {
    const name = commandName(rest[0])
    const spec = name !== undefined && rest[0]?.kind === 'literal' ? table[name] : undefined
    if (!spec || name === undefined) return rest.length ? { kind: 'run', argv: rest, via } : { kind: 'none', via }
    via.push(name)
    let i = 1
    while (i < rest.length) {
      const w = rest[i]
      if (!w || w.kind !== 'literal') break
      const t = w.text
      if (t === '--') {
        i++
        break
      }
      if (spec.assignments && isAssignment(t)) {
        i++
        continue
      }
      if (t.startsWith('--') && t.length > 2) {
        const flag = t.split('=')[0] ?? t
        if (spec.noRun?.includes(flag)) return { kind: 'none', via }
        if (spec.opaque?.includes(flag)) return { kind: 'unknown', why: 'opaque-wrapper', detail: `${name} ${flag}`, via }
        i += !t.includes('=') && spec.valueLongFlags?.includes(flag) ? 2 : 1
        continue
      }
      if (t.startsWith('-') && t.length > 1) {
        const chars = [...t.slice(1)]
        if (chars.some((c) => spec.noRun?.includes(`-${c}`))) return { kind: 'none', via }
        const opaque = chars.find((c) => spec.opaque?.includes(`-${c}`))
        if (opaque) return { kind: 'unknown', why: 'opaque-wrapper', detail: `${name} -${opaque}`, via }
        const k = chars.findIndex((c) => spec.valueFlags.includes(c))
        i += k !== -1 && k === chars.length - 1 ? 2 : 1
        continue
      }
      break
    }
    rest = rest.slice(i + (spec.positionals ?? 0))
    if (!rest.length) return { kind: 'none', via }
  }
}

/** The script word of `bash -c SCRIPT` (or `-xc`, `-o x -c`), when there is one. */
export function shellScriptWord(argv: WordValue[]): WordValue | undefined {
  const i = argv.findIndex((w, j) => j > 0 && w.kind === 'literal' && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(w.text))
  return i === -1 ? undefined : argv[i + 1]
}

/** Commands run by `find ... -exec CMD ... ;` (or `+`), one argv per -exec. */
export function findExecs(argv: WordValue[]): WordValue[][] {
  const out: WordValue[][] = []
  for (let i = 1; i < argv.length; i++) {
    const w = argv[i]
    if (w?.kind !== 'literal' || !findExecFlags.has(w.text)) continue
    const rest = argv.slice(i + 1)
    const end = rest.findIndex((x) => x.kind === 'literal' && (x.text === ';' || x.text === '+'))
    out.push(end === -1 ? rest : rest.slice(0, end))
    i += end === -1 ? rest.length : end + 1
  }
  return out
}

export const describe = (argv: WordValue[]) => argv.map(display).join(' ')

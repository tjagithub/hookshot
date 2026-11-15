// bash-guard (reference/bash-guard) written as hookshot rules. The baseline tests run both side by side.
import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'
import process from 'node:process'
import { type CmdMatch, type Verdict, type WordValue, cmd, couldEqual, deny, display, edit, hooks, pass, pipe, rewrite, word } from '../../src/index.ts'
import { grepToRg } from '../../src/translate/grep-rg.ts'

const label = 'guardrails'
const rgNote = 'rg skips .gitignored and hidden files; add -uu for grep -r behaviour'

function onPath(bin: string): boolean {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    try {
      accessSync(join(dir, bin), constants.X_OK)
      return true
    } catch {}
  }
  return false
}

function grepRewrite({ inv }: CmdMatch): Verdict {
  const t = grepToRg(inv.argv)
  if (!t.ok) return deny(label, "grep is not allowed here; use rg (e.g. rg PATTERN [path], rg --files -g '<glob>').")
  const { argv, call } = inv
  const more = t.rest < argv.length
  const end = more ? argv[t.rest]!.start : argv.at(-1)!.end
  const e = edit(call, argv[0]!.start, end, `${['rg', ...t.rgFlags].join(' ')}${more ? ' ' : ''}`)
  if (e) return rewrite([{ ...e, rule: 'grep -> rg' }], [{ rule: 'grep -> rg', message: rgNote }])
  return deny(
    label,
    call.origin.kind === 'opaque'
      ? "grep inside a double-quoted or eval'd command; use rg there."
      : 'grep inside a quoted command needs quoting changes; use rg there.',
  )
}

/** A file argument jouet read can take as is: literal, or with $NAME parts only (no $(...)). */
function plainFile(w: WordValue): boolean {
  if (w.kind === 'literal') return !w.text.startsWith('-')
  const paramsOnly = w.segments.every((s) => typeof s === 'string' || /^\$[A-Za-z_0-9]*$/.test(s.dynamic))
  return paramsOnly && !w.hint.startsWith('-')
}

// sed -n 'A,Bp' FILE -> jouet read FILE --range A:B, only for a plain top-level call.
function sedRead({ inv }: CmdMatch): Verdict {
  const ws = inv.call.words
  const [, flag, range, file] = ws
  if (inv.call.assigns || ws.length !== 4 || !file || !plainFile(file)) return pass()
  if (flag?.kind !== 'literal' || flag.text !== '-n' || range?.kind !== 'literal') return pass()
  const m = /^(\d+)(?:,(\d+))?p$/.exec(range.text)
  if (!m) return pass()
  const a = Number(m[1])
  const b = Number(m[2] ?? m[1])
  if (a < 1 || a > b) return pass()
  const head = edit(inv.call, ws[0]!.start, file.start, 'jouet read ')
  const tail = edit(inv.call, file.end, file.end, ` --range ${a}:${b}`)
  if (!head || !tail) return pass()
  return rewrite([{ ...head, rule: 'sed -n -> jouet read' }, { ...tail, rule: 'sed -n -> jouet read' }])
}

const homeOrRoot = ['/', '/*', '~', '~/', '~/*', '$HOME', '$HOME/', '$HOME/*']
const isHomeOrRoot = (w: WordValue) => homeOrRoot.includes(display(w))

export const guardrails = hooks([
  cmd(['grep', 'egrep', 'fgrep']).named('grep -> rg').then(grepRewrite),
  cmd(['zgrep', 'zegrep', 'zfgrep']).named(label).deny('grep is not allowed here; use rg (e.g. rg -z PATTERN file.gz).'),
  cmd(['sed', 'gsed'])
    .named(label)
    .where(({ inv }) => inv.argv.slice(1).some((w) => w.kind === 'literal' && /^--in-place|^-[a-zA-Z]*i/.test(w.text)))
    .deny('sed -i differs between BSD and GNU. Use the Edit tool or perl -pi -e.'),
  cmd('sed').named('sed -n -> jouet read').standalone().where(() => onPath('jouet')).then(sedRead),
  cmd('rm')
    .named(label)
    .flags({ aliases: { '-r': '--recursive', '-R': '--recursive' } })
    .withFlag('--recursive')
    .arg((w) => isHomeOrRoot(w) || (w.kind === 'dynamic' && couldEqual(w, homeOrRoot) ? 'unknown' : false))
    .deny(({ flags }) => {
      const hit = flags.positionals.find(isHomeOrRoot)
      return `refusing recursive rm on '${hit ? display(hit) : '?'}'. Name the exact directory instead.`
    }),
  // Not in bash-guard: download piped into a shell, at any distance (curl | tee | sudo bash).
  pipe(['curl', 'wget'], ['bash', 'sh', 'zsh', 'dash', 'ksh']).named(label).ask('this pipes a download into a shell.'),
  word(label, (w) => w.startsUnquoted && display(w).startsWith('--force')).deny(
    '--force* flags are not allowed. Find the non-forced way, or ask the user to run it themselves.',
  ),
])

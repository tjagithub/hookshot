import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { homeDir } from './context.ts'

/** One time a rule fired in a session. */
export interface Firing {
  t: number
  key: string
}

/** Firings so far in this session, plus the ones this call adds. */
export interface History {
  count(key: string, withinMs?: number): number
  fire(key: string): void
  readonly pending: readonly Firing[]
}

/** Why history is missing: escalating rules turn this into an Unknown. */
export interface NoHistory {
  unavailable: string
}

export interface Store {
  load(sessionId: string): History | NoHistory
  /** Throws when the firings cannot be saved. */
  save(sessionId: string, firings: readonly Firing[]): void
}

export function defaultStateDir(): string {
  let data: string | undefined
  try {
    data = process.env.CLAUDE_PLUGIN_DATA
  } catch {} // deno without --allow-env
  return data ? join(data, 'hookshot') : join(homeDir(), '.local', 'state', 'hookshot')
}

const sessionRe = /^[A-Za-z0-9_-]{1,128}$/
const maxKey = 200
const week = 7 * 24 * 3600 * 1000

export function history(past: readonly Firing[], now: () => number = Date.now): History {
  const pending: Firing[] = []
  return {
    pending,
    count(key, withinMs) {
      const since = withinMs === undefined ? -Infinity : now() - withinMs
      return [...past, ...pending].filter((f) => f.key === key && f.t >= since).length
    },
    fire(key) {
      pending.push({ t: now(), key: key.slice(0, maxKey) })
    },
  }
}

/** Append-only JSONL, one file per session. Each save is one write under 4 KB, so parallel hooks don't interleave. */
export function fileStore(dir: string = defaultStateDir(), { now = Date.now, maxAge = week } = {}): Store {
  let pruned = false
  const file = (id: string) => join(dir, `${id}.jsonl`)
  function prune() {
    if (pruned) return
    pruned = true
    let names: string[] = []
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue
      try {
        if (now() - statSync(join(dir, n)).mtimeMs > maxAge) unlinkSync(join(dir, n))
      } catch {}
    }
  }
  return {
    load(id) {
      if (!sessionRe.test(id)) return { unavailable: `session id ${JSON.stringify(id.slice(0, 40))} is not a plain name` }
      prune()
      let text = ''
      try {
        text = readFileSync(file(id), 'utf8')
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return { unavailable: `cannot read state: ${(e as Error).message}` }
      }
      const past: Firing[] = []
      for (const line of text.split('\n')) {
        if (!line) continue
        try {
          const f = JSON.parse(line) as Partial<Firing>
          if (typeof f.t === 'number' && typeof f.key === 'string') past.push({ t: f.t, key: f.key })
        } catch {} // a line torn by a crash counts as nothing
      }
      return history(past, now)
    },
    save(id, firings) {
      if (!firings.length) return
      if (!sessionRe.test(id)) throw new Error('session id is not a plain name')
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      for (let i = 0; i < firings.length; ) {
        let chunk = ''
        while (i < firings.length) {
          const line = `${JSON.stringify(firings[i])}\n`
          if (chunk && chunk.length + line.length > 4000) break
          chunk += line
          i++
        }
        appendFileSync(file(id), chunk, { mode: 0o600 })
      }
    },
  }
}

const units: Record<string, number> = { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3 }

/** '90s', '10m', '2h', '1d', or milliseconds. */
export function duration(d: string | number): number {
  if (typeof d === 'number' && d > 0) return d
  const m = typeof d === 'string' ? /^(\d+)([smhd])$/.exec(d) : null
  if (!m) throw new Error(`bad duration ${JSON.stringify(d)}; use e.g. '30s', '10m', '2h', '1d'`)
  return Number(m[1]) * units[m[2]!]!
}

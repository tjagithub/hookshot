import type { Context } from '../context.ts'
import type { Extraction } from '../extract.ts'
import type { Tri } from '../flags.ts'
import { type Glob, compileGlob, globCouldEndWith, globMatches, globMatchesUnder } from '../glob.ts'
import { type FileOp, type FileTarget, type PathValue, bashTargets } from '../paths.ts'
import { type Verdict, combine, pass, unknown } from '../verdict.ts'
import { Terminal } from './rule.ts'

/** A glob string (see glob.ts), or a RegExp or predicate on the absolute, normalised path. */
export type PathSpec = string | RegExp | ((abs: string) => boolean)

export interface PathMatch {
  target: FileTarget
  /** The absolute path, or the text as written when its directory is unknown. */
  path: string
}

/** A file read or written by Write, Edit, NotebookEdit, Read, a Bash redirect or tee; cp, mv and sed -i are not seen. */
export class PathRule extends Terminal<PathMatch> {
  name: string
  private ops: ReadonlySet<FileOp> = new Set(['write'])
  private dynamic: 'unknown' | 'ignore' = 'unknown'
  private readonly spec: PathSpec
  private globs = new Map<string, Glob>()

  constructor(spec: PathSpec) {
    super()
    this.spec = spec
    this.name = `path ${String(spec)}`
  }

  writes(): this {
    this.ops = new Set(['write'])
    return this
  }
  reads(): this {
    this.ops = new Set(['read'])
    return this
  }
  any(): this {
    this.ops = new Set(['write', 'read'])
    return this
  }
  /** A path such as "$out" could be anything. Default 'unknown' (the policy decides); 'ignore' skips it. */
  onDynamic(mode: 'unknown' | 'ignore'): this {
    this.dynamic = mode
    return this
  }

  private glob(ctx: Context): Glob {
    const key = `${ctx.root}\0${ctx.home}`
    let g = this.globs.get(key)
    if (!g) this.globs.set(key, (g = compileGlob(this.spec as string, ctx)))
    return g
  }

  private matchPath(p: PathValue, ctx: Context): Tri {
    if (p.kind === 'dynamic') return typeof this.spec === 'string' && p.base !== undefined ? globCouldEndWith(this.glob(ctx), p.base) : 'unknown'
    if (typeof this.spec === 'string') {
      return p.kind === 'known' ? globMatches(this.glob(ctx), p.abs) : globMatchesUnder(this.glob(ctx), p.rel)
    }
    if (p.kind === 'relative') return 'unknown'
    return this.spec instanceof RegExp ? this.spec.test(p.abs) : this.spec(p.abs)
  }

  private one(t: FileTarget, ctx: Context): Verdict {
    if (!this.ops.has(t.op)) return pass()
    const m = this.matchPath(t.path, ctx)
    if (m === true) return this.act({ target: t, path: t.path.kind === 'known' ? t.path.abs : t.path.shown }, ctx)
    if (m === false || this.dynamic === 'ignore') return pass()
    const why = t.path.kind === 'relative' ? 'relative to a directory changed by cd' : 'only known at run time'
    return unknown({ why: 'dynamic', rule: this.name, detail: `${t.source} path ${t.path.shown} is ${why}` })
  }

  protected override bash(x: Extraction, ctx: Context): Verdict {
    const { targets, unclassified } = bashTargets(x, ctx)
    const out = targets.map((t) => this.one(t, ctx))
    if (this.ops.has('write')) {
      for (const u of unclassified) out.push(unknown({ why: 'unsupported-syntax', rule: this.name, detail: `redirect operator ${u.op}` }))
    }
    return out.length ? combine(...out) : pass()
  }

  protected override file(f: FileTarget, ctx: Context): Verdict {
    return this.one(f, ctx)
  }
}

export const path = (spec: PathSpec) => new PathRule(spec)

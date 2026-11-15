import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import type { File } from './ast.ts'
import { type BackendEvent, type BackendState, next } from './backend-state.ts'

export type { BackendState } from './backend-state.ts'
export type Dialect = 'zsh' | 'bash'
export type Backend = 'native' | 'wasm'

export type { File, Node, Pos } from './ast.ts'
export interface Parsed {
  dialect: Dialect
  file: File
}

export class ParserUnavailable extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`hookshot parser: ${message}`, options)
  }
}

type RawParse = (src: string, dialect: number) => string | null
interface GoRuntime {
  importObject: WebAssembly.Imports
  exited: boolean
  run(instance: WebAssembly.Instance): Promise<void>
}
declare global {
  var Go: (new () => GoRuntime) | undefined
  var __hookshotRegister: ((fn: RawParse) => void) | undefined
}

const buildDir = new URL('../native/build/', import.meta.url)
const toError = (e: unknown) => (e instanceof Error ? e : new Error(String(e)))

interface Slot {
  status: BackendState
  raw?: RawParse
  pending?: Promise<RawParse>
  generation: number
}
const slots: Record<Backend, Slot> = {
  native: { status: { state: 'idle' }, generation: 0 },
  wasm: { status: { state: 'idle' }, generation: 0 },
}
const dispatch = (b: Backend, e: BackendEvent) => {
  slots[b].status = next(slots[b].status, e)
}

/** The prebuilt addon for a platform, as CI and `hookshot fetch-parser` name it. */
export const nativeAsset = (platform: string = process.platform, arch: string = process.arch) => `hsparse-${platform}-${arch}.node`
let nativeFile: string | undefined

// The platform build first, then a local build.sh output; a file that exists but won't load is an error, not skipped.
function startNative(): RawParse {
  const req = createRequire(import.meta.url)
  const errors: unknown[] = []
  for (const name of [nativeAsset(), 'hsparse.node']) {
    const file = fileURLToPath(new URL(name, buildDir))
    if (!existsSync(file)) continue
    try {
      const addon = req(file) as { parse: RawParse }
      nativeFile = file
      return addon.parse
    } catch (e) {
      errors.push(e)
    }
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length) throw new AggregateError(errors, 'native addon did not load')
  throw new Error(`no ${nativeAsset()} in ${fileURLToPath(buildDir)}; run native/build.sh or hookshot fetch-parser`)
}

// The Go program hands over its parse function during go.run(); exiting later moves the slot to exited.
async function startWasm(generation: number): Promise<RawParse> {
  await import(new URL('wasm_exec.js', buildDir).href)
  if (!globalThis.Go) throw new Error('wasm_exec.js did not define Go')
  const go = new globalThis.Go()
  const { instance } = await WebAssembly.instantiate(readFileSync(new URL('hsparse.wasm', buildDir)), go.importObject)

  let fn: RawParse | undefined
  globalThis.__hookshotRegister = (f) => (fn = f)
  const done = go.run(instance)
  delete globalThis.__hookshotRegister
  const markExited = (error?: unknown) => {
    const slot = slots.wasm
    if (slot.generation === generation && slot.status.state === 'ready') {
      dispatch('wasm', error === undefined ? { type: 'exited' } : { type: 'exited', error: toError(error) })
    }
  }
  done.then(() => markExited(), markExited)
  if (!fn || go.exited) throw new Error('hsparse.wasm did not register its parse function')

  const parse = fn
  return (src, dialect) => {
    if (go.exited) throw new ParserUnavailable('wasm runtime has exited')
    try {
      return parse(src, dialect)
    } catch (e) {
      if (go.exited) markExited(e)
      throw e
    }
  }
}

function load(b: Backend): Promise<RawParse> {
  const slot = slots[b]
  switch (slot.status.state) {
    case 'ready':
      if (slot.raw) return Promise.resolve(slot.raw)
      throw new Error('invariant: ready backend without a parse function')
    case 'loading':
      if (slot.pending) return slot.pending
      throw new Error('invariant: loading backend without a pending load')
    case 'failed':
      return Promise.reject(new ParserUnavailable(`${b} backend failed to load`, { cause: slot.status.error }))
    case 'idle':
    case 'exited': {
      dispatch(b, { type: 'load' })
      const generation = ++slot.generation
      slot.raw = undefined
      slot.pending = (async () => (b === 'native' ? startNative() : startWasm(generation)))().then(
        (raw) => {
          slot.raw = raw
          dispatch(b, { type: 'loaded' })
          return raw
        },
        (e: unknown) => {
          dispatch(b, { type: 'failed', error: toError(e) })
          throw new ParserUnavailable(`${b} backend failed to load`, { cause: e })
        },
      )
      return slot.pending
    }
    default:
      return slot.status satisfies never
  }
}

function requested(): Backend | undefined {
  try {
    const v = process.env.HOOKSHOT_PARSER
    return v === 'native' || v === 'wasm' ? v : undefined
  } catch {
    return undefined // Deno without --allow-env
  }
}

let active: Backend | undefined
// HOOKSHOT_PARSER forces a backend; otherwise native, then wasm when no addon loads here.
async function choose(): Promise<Backend> {
  if (active && slots[active].status.state !== 'failed') return active
  const want = requested()
  if (want) {
    await load(want)
    return (active = want)
  }
  try {
    await load('native')
    return (active = 'native')
  } catch (nativeError) {
    try {
      await load('wasm')
    } catch (wasmError) {
      throw new ParserUnavailable('no backend loads', { cause: new AggregateError([nativeError, wasmError]) })
    }
    return (active = 'wasm')
  }
}

/** The backend parse() uses in this process. */
export async function activeBackend(): Promise<Backend> {
  return choose()
}

/** Snapshot of both backends, for diagnostics: why wasm, when native was expected. */
export function parserStatus(): { active?: Backend; native: BackendState; wasm: BackendState; nativeFile?: string } {
  return { active, native: slots.native.status, wasm: slots.wasm.status, ...(nativeFile ? { nativeFile } : {}) }
}

const dialects: ReadonlyArray<readonly [Dialect, number]> = [
  ['zsh', 0],
  ['bash', 1],
]

/** Zsh first, then bash, as guardrails does. Null when neither accepts the text. */
export async function parse(text: string, opts: { backend?: Backend } = {}): Promise<Parsed | null> {
  const raw = await load(opts.backend ?? (await choose()))
  for (const [dialect, n] of dialects) {
    const json = raw(text, n)
    if (json !== null) return { dialect, file: JSON.parse(json) as File }
  }
  return null
}

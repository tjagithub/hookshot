/** Lifecycle of one parser backend. `failed` is final: a missing addon or wasm file will not appear. */
export type BackendState =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'ready' }
  | { state: 'failed'; error: Error }
  | { state: 'exited'; error?: Error }

export type BackendEvent =
  | { type: 'load' }
  | { type: 'loaded' }
  | { type: 'failed'; error: Error }
  | { type: 'exited'; error?: Error }

export class InvalidTransition extends Error {
  constructor(from: BackendState['state'], event: BackendEvent['type']) {
    super(`backend: no transition from ${from} on ${event}`)
  }
}

// exited -> loading lets the wasm runtime restart after the Go program stops.
export function next(s: BackendState, e: BackendEvent): BackendState {
  switch (s.state) {
    case 'idle':
    case 'exited':
      if (e.type === 'load') return { state: 'loading' }
      break
    case 'loading':
      if (e.type === 'loaded') return { state: 'ready' }
      if (e.type === 'failed') return { state: 'failed', error: e.error }
      break
    case 'ready':
      if (e.type === 'exited') return e.error ? { state: 'exited', error: e.error } : { state: 'exited' }
      break
    case 'failed':
      break
    default:
      return s satisfies never
  }
  throw new InvalidTransition(s.state, e.type)
}

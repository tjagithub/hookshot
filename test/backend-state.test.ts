import { fc, test } from '@fast-check/vitest'
import { describe, expect } from 'vitest'
import { type BackendEvent, type BackendState, InvalidTransition, next } from '../src/backend-state.ts'

const boom = new Error('boom')
const states: BackendState[] = [
  { state: 'idle' },
  { state: 'loading' },
  { state: 'ready' },
  { state: 'failed', error: boom },
  { state: 'exited' },
]
const events: BackendEvent[] = [
  { type: 'load' },
  { type: 'loaded' },
  { type: 'failed', error: boom },
  { type: 'exited' },
  { type: 'exited', error: boom },
]

// Every allowed (state, event) pair; everything else must throw.
const allowed: Record<string, BackendState['state']> = {
  'idle/load': 'loading',
  'exited/load': 'loading',
  'loading/loaded': 'ready',
  'loading/failed': 'failed',
  'ready/exited': 'exited',
}

describe('backend state machine', () => {
  for (const s of states) {
    for (const e of events) {
      const to = allowed[`${s.state}/${e.type}`]
      test(`${s.state} --${e.type}${'error' in e && e.type === 'exited' ? '(error)' : ''}--> ${to ?? 'throws'}`, () => {
        if (to) expect(next(s, e).state).toBe(to)
        else expect(() => next(s, e)).toThrow(InvalidTransition)
      })
    }
  }

  test('errors are kept on failed and exited', () => {
    expect(next({ state: 'loading' }, { type: 'failed', error: boom })).toEqual({ state: 'failed', error: boom })
    expect(next({ state: 'ready' }, { type: 'exited', error: boom })).toEqual({ state: 'exited', error: boom })
  })

  test.prop([fc.array(fc.constantFrom(...events), { maxLength: 30 })])(
    'from idle, valid runs never leave failed and only reach ready through loading',
    (run) => {
      let s: BackendState = { state: 'idle' }
      for (const e of run) {
        let to: BackendState
        try {
          to = next(s, e)
        } catch (err) {
          expect(err).toBeInstanceOf(InvalidTransition)
          continue
        }
        expect(s.state).not.toBe('failed')
        if (to.state === 'ready') expect(s.state).toBe('loading')
        s = to
      }
    },
  )
})

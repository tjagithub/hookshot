import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'

/** A mkdtemp that removes every directory it made once the test file finishes. */
export function tempDirs(): (prefix: string) => string {
  const made: string[] = []
  afterAll(() => {
    for (const d of made) rmSync(d, { recursive: true, force: true })
  })
  return (prefix) => {
    const d = mkdtempSync(join(tmpdir(), prefix))
    made.push(d)
    return d
  }
}

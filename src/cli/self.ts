import * as nodeModule from 'node:module'
import { indexUrl, pkgName } from '../root.ts'

let registered = false

// Resolves `import '@tjakit/hookshot'` in a rules file to this copy, so a global install works and
// the rules always run against the CLI's own version. Node only: bun and deno ignore these hooks.
export function resolveSelf(): boolean {
  if (registered) return true
  const { registerHooks } = nodeModule
  if (typeof registerHooks !== 'function' || 'Bun' in globalThis || 'Deno' in globalThis) return false
  registerHooks({
    resolve: (specifier, context, next) =>
      specifier === pkgName ? { url: indexUrl.href, shortCircuit: true } : next(specifier, context),
  })
  return (registered = true)
}

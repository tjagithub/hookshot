// The package root: src/root.ts in the repo, dist/src/root.js in the published package.
export const pkgRoot = new URL(import.meta.url.endsWith('.js') ? '../../' : '../', import.meta.url)
export const buildDir = new URL('native/build/', pkgRoot)
export const pkgName = '@tjakit/hookshot'
export const indexUrl = new URL(import.meta.url.endsWith('.js') ? 'dist/src/index.js' : 'src/index.ts', pkgRoot)
/** The CLI entry point for this layout: bin/hookshot.ts, or dist/bin/hookshot.js. */
export const binUrl = new URL(import.meta.url.endsWith('.js') ? 'dist/bin/hookshot.js' : 'bin/hookshot.ts', pkgRoot)

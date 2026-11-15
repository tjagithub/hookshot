import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { nativeAsset } from '../parse.ts'
import { buildDir, pkgRoot } from '../root.ts'
import { type Io, UsageError } from './main.ts'

export const releases = 'https://github.com/tjagithub/hookshot/releases/download'
export const supported = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']

const buildPath = () => fileURLToPath(buildDir)
const pkgVersion = () =>
  (JSON.parse(readFileSync(new URL('package.json', pkgRoot), 'utf8')) as { version: string }).version

/** Download the prebuilt addon for this platform from the release matching the package version; verify its SHA-256. */
export async function fetchParser(args: string[], io: Io, fetchFn: typeof fetch = fetch): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      tag: { type: 'string' },
      base: { type: 'string' },
      platform: { type: 'string', default: process.platform },
      arch: { type: 'string', default: process.arch },
      dir: { type: 'string' },
    },
  })
  const key = `${values.platform}-${values.arch}`
  if (!supported.includes(key)) {
    io.err(`no prebuilt parser for ${key}; hookshot will use the WASM parser (or build one with native/build.sh)\n`)
    return 1
  }
  const tag = values.tag ?? `v${pkgVersion()}`
  const base = `${values.base ?? releases}/${tag}`
  const asset = nativeAsset(values.platform, values.arch)

  const get = async (name: string) => {
    const r = await fetchFn(`${base}/${name}`)
    if (!r.ok) throw new UsageError(`GET ${base}/${name}: HTTP ${r.status}`)
    return Buffer.from(await r.arrayBuffer())
  }
  const sums = (await get('SHA256SUMS')).toString('utf8')
  const want = sums.split('\n').map((l) => /^([0-9a-f]{64})\s+\*?(\S+)$/.exec(l.trim())).find((m) => m?.[2] === asset)?.[1]
  if (!want) throw new UsageError(`${asset} is not listed in ${tag}'s SHA256SUMS`)
  const bytes = await get(asset)
  const got = createHash('sha256').update(bytes).digest('hex')
  if (got !== want) throw new UsageError(`${asset}: SHA-256 is ${got}, SHA256SUMS says ${want}; not installed`)

  const dir = values.dir ?? buildPath()
  mkdirSync(dir, { recursive: true })
  const tmp = `${dir}/.${asset}.${process.pid}`
  writeFileSync(tmp, bytes)
  renameSync(tmp, `${dir}/${asset}`)
  io.out(`installed ${dir}/${asset} (${tag}, sha256 ${got.slice(0, 12)}…)\n`)
  return 0
}

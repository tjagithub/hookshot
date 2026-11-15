import { createRequire } from 'node:module'

interface Addon {
  parse(src: string, dialect?: number): string | null
}

const addon = createRequire(import.meta.url)('./build/hsparse.node') as Addon

/** Typed JSON of the syntax tree (shfmt --to-json shape), or null when src does not parse. */
export const parse: Addon['parse'] = addon.parse

import { CString, dlopen, FFIType } from 'bun:ffi'
import { fileURLToPath } from 'node:url'

const lib = dlopen(fileURLToPath(new URL('build/libhsparse.dylib', import.meta.url)), {
  hs_parse: { args: [FFIType.ptr, FFIType.i32, FFIType.i32], returns: FFIType.ptr },
  hs_free: { args: [FFIType.ptr], returns: FFIType.void },
})

/** Typed JSON of the syntax tree (shfmt --to-json shape), or null when src does not parse. */
export function parse(src: string, dialect = -1): string | null {
  const buf = Buffer.from(`${src}\0`)
  const p = lib.symbols.hs_parse(buf, buf.length - 1, dialect)
  if (!p) return null
  try {
    return new CString(p).toString()
  } finally {
    lib.symbols.hs_free(p)
  }
}

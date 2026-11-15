// A validator for the JSON Schema subset src/config/schema.ts uses; any other keyword is a bug, so it throws.
type Schema = { readonly [k: string]: unknown }
export interface ConfigError {
  /** Where, e.g. deny[2].flags[0] or rewrite[0].flags["-e"]; '' is the top. */
  path: string
  message: string
}

const known = new Set([
  '$schema', '$id', '$ref', '$defs', 'title', 'description', 'type', 'const', 'enum', 'minLength', 'pattern', 'minimum',
  'minItems', 'items', 'required', 'properties', 'additionalProperties', 'propertyNames', 'dependentRequired', 'oneOf',
])

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v))

function typeOf(v: unknown): string {
  if (Array.isArray(v)) return 'array'
  if (v === null) return 'null'
  if (typeof v === 'object') return isPlain(v) ? 'object' : 'date'
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number'
  return typeof v
}

const fits = (want: string, got: string) => want === got || (want === 'number' && got === 'integer')
const join = (path: string, key: string | number) =>
  typeof key === 'number' ? `${path}[${key}]` : /^[A-Za-z_][\w-]*$/.test(key) ? (path ? `${path}.${key}` : key) : `${path}[${JSON.stringify(key)}]`
const show = (v: unknown) => JSON.stringify(v)

/** Every way value breaks schema, with paths. An empty list means it is valid. */
export function validate(value: unknown, schema: Schema, root: Schema = schema, path = ''): ConfigError[] {
  for (const k of Object.keys(schema)) if (!known.has(k)) throw new Error(`validate: unsupported schema keyword ${k}`)
  if (typeof schema.$ref === 'string') {
    const name = schema.$ref.replace(/^#\/\$defs\//, '')
    const target = (root.$defs as Record<string, Schema> | undefined)?.[name]
    if (!target) throw new Error(`validate: unknown $ref ${schema.$ref}`)
    return validate(value, target, root, path)
  }
  const err = (message: string, at = path): ConfigError[] => [{ path: at, message }]
  const got = typeOf(value)

  if (schema.oneOf) return oneOf(value, schema, root, path)
  if (typeof schema.type === 'string' && !fits(schema.type, got)) return err(`expected ${schema.type}, got ${got}`)
  if ('const' in schema && value !== schema.const) return err(`must be ${show(schema.const)}`)
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return err(`must be one of ${schema.enum.map(show).join(', ')}`)

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) return err('must not be empty')
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) return err(`${show(value)} does not match ${schema.pattern}`)
  }
  if (typeof value === 'number' && typeof schema.minimum === 'number' && value < schema.minimum) return err(`must be at least ${schema.minimum}`)

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) return err('must not be empty')
    if (schema.items) return value.flatMap((v, i) => validate(v, schema.items as Schema, root, join(path, i)))
    return []
  }
  if (!isPlain(value)) return []
  return object(value, schema, root, path)
}

function object(value: Record<string, unknown>, schema: Schema, root: Schema, path: string): ConfigError[] {
  const out: ConfigError[] = []
  const props = (schema.properties ?? {}) as Record<string, Schema>
  for (const k of (schema.required ?? []) as string[]) if (!(k in value)) out.push({ path, message: `missing ${show(k)}` })
  for (const [k, v] of Object.entries(value)) {
    const at = join(path, k)
    const names = schema.propertyNames as Schema | undefined
    if (names) out.push(...validate(k, names, root, at).map((e) => ({ ...e, message: `key ${e.message}` })))
    if (props[k]) out.push(...validate(v, props[k], root, at))
    else if (schema.additionalProperties === false) out.push({ path: at, message: `unknown key ${show(k)}` })
    else if (isPlain(schema.additionalProperties)) out.push(...validate(v, schema.additionalProperties, root, at))
  }
  for (const [k, needs] of Object.entries((schema.dependentRequired ?? {}) as Record<string, string[]>)) {
    if (k in value && !needs.every((n) => n in value)) out.push({ path: join(path, k), message: `only applies with ${needs.map(show).join(', ')}` })
  }
  return out
}

// Either a choice of matcher keys ({required: [k]} branches) or a choice of shapes (by type).
function oneOf(value: unknown, schema: Schema, root: Schema, path: string): ConfigError[] {
  const { oneOf: branches, ...rest } = schema as { oneOf: Schema[] }
  const base = Object.keys(rest).some((k) => k !== 'description') ? validate(value, rest, root, path) : []
  const keys = branches.every((b) => Object.keys(b).length === 1 && Array.isArray(b.required) && b.required.length === 1)
  if (keys) {
    if (!isPlain(value)) return base
    const want = branches.map((b) => (b.required as string[])[0]!)
    const has = want.filter((k) => k in value)
    if (has.length === 1) return base
    return [...base, { path, message: `needs exactly one of ${want.map(show).join(', ')}${has.length ? ` (has ${has.map(show).join(', ')})` : ''}` }]
  }
  const results = branches.map((b) => validate(value, b, root, path))
  const ok = results.filter((r) => r.length === 0).length
  if (ok === 1) return base
  if (ok > 1) return [...base, { path, message: 'matches more than one allowed form' }]
  const got = typeOf(value)
  const typed = branches.findIndex((b) => typeof b.type === 'string' && fits(b.type, got))
  if (typed !== -1) return [...base, ...results[typed]!]
  const types = branches.map((b) => (b.type as string | undefined) ?? (b.enum ? (b.enum as unknown[]).map(show).join(' or ') : 'a table'))
  return [...base, { path, message: `expected ${types.join(', or ')}, got ${got}` }]
}

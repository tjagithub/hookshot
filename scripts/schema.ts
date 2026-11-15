// Writes schema/hookshot.schema.json from src/config/schema.ts (test/schema.test.ts fails when it is stale).
import { writeFileSync } from 'node:fs'
import { schema } from '../src/config/schema.ts'

writeFileSync(new URL('../schema/hookshot.schema.json', import.meta.url), `${JSON.stringify(schema, null, 2)}\n`)

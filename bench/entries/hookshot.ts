import { parse } from '../../src/parse.ts'

await parse(process.argv[2] ?? 'grep -rn foo src')

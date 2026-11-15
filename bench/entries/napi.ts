import { parse } from '../../native/napi.ts'

JSON.parse(parse(process.argv[2] ?? 'grep -rn foo src') ?? 'null')

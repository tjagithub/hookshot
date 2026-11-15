import { parse } from '../../native/ffi.ts'

JSON.parse(parse(process.argv[2] ?? 'grep -rn foo src') ?? 'null')

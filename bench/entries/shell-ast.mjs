import { parse } from '@questi0nm4rk/shell-ast'

await parse(process.argv[2] ?? 'grep -rn foo src', 'bash')

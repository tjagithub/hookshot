import { LangVariant, parse } from 'sh-syntax'

await parse(process.argv[2] ?? 'grep -rn foo src', { variant: LangVariant.LangBash })

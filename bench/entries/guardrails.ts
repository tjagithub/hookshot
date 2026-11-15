import { guardrails } from '../../examples/guardrails/hooks.ts'

await guardrails.evaluate(process.argv[2] ?? 'grep -rn foo src')

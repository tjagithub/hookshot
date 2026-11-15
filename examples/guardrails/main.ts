#!/usr/bin/env bun
// PreToolUse hook for Bash: `"command": "bun examples/guardrails/main.ts"` in settings.json.
import { runPreToolUse } from '../../src/index.ts'
import { guardrails } from './hooks.ts'

await runPreToolUse(guardrails)

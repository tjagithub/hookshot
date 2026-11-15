#!/usr/bin/env bun
// PreToolUse hook for Bash: `"command": "bun examples/guardrails-toml/main.ts"` in settings.json.
import { runPreToolUse } from '../../src/index.ts'
import { guardrailsToml } from './hooks.ts'

await runPreToolUse(guardrailsToml)

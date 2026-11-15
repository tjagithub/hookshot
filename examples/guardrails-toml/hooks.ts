// The config, plus the one rule TOML cannot say: sed -n 'A,Bp' f -> jouet read f --range A:B.
import { cmd, configRules, hooks } from '../../src/index.ts'
import { onPath, sedRead } from '../guardrails/hooks.ts'

const config = new URL('./hookshot.toml', import.meta.url).pathname

export const guardrailsToml = hooks([
  ...configRules(config),
  cmd('sed').named('sed -n -> jouet read').standalone().where(() => onPath('jouet')).then(sedRead),
])

export default guardrailsToml

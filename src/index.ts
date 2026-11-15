export { type PreToolUseOutput, handlePreToolUse, runPreToolUse } from './claude.ts'
export {
  type Call, type Extraction, type ExtractOptions, type Invocation, type Origin, type Pipeline,
  type RedirectInfo, type RedirectKind, type Unknown, type UnknownWhy, classifyRedirect, extract,
} from './extract.ts'
export { type Flag, type FlagSpec, type ParsedFlags, type Tri, and, hasFlag, not, or, parseFlags } from './flags.ts'
export { type Evaluation, type Hook, type HookOptions, hooks } from './hook.ts'
export { type Backend, type BackendState, type Dialect, type Parsed, ParserUnavailable, activeBackend, parse, parserStatus } from './parse.ts'
export { type CmdMatch, CmdRule, cmd } from './rules/cmd.ts'
export { type PipeMatch, PipeRule, type StageSpec, pipe } from './rules/pipe.ts'
export { RedirectRule, type TargetSpec, redirect } from './rules/redirect.ts'
export type { Action, Matcher, Message, Rule } from './rules/rule.ts'
export { type WordMatch, WordRule, word } from './rules/word.ts'
export {
  type Edit, type Outcome, type Policy, type Reason, type Verdict, applyEdits, ask, combine, deny, edit, note,
  orderEdits, pass, resolve, rewrite, unknown,
} from './verdict.ts'
export { type Dynamic, type Literal, type Quoting, type Segment, type WordValue, couldEqual, display, wordValue } from './word.ts'
export { type Unwrapped, type WrapperSpec, commandName, unwrap, wrappers } from './wrappers.ts'

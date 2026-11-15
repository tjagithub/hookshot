// The hookshot.toml format: the validator reads this, and `pnpm schema` writes it to schema/hookshot.schema.json.
export const schemaUrl = 'https://unpkg.com/@tjakit/hookshot/schema/hookshot.schema.json'

const names = (what: string) => ({
  description: `${what}: one name, or a list of names (basenames, e.g. "grep" matches /usr/bin/grep).`,
  oneOf: [{ type: 'string', minLength: 1 }, { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1 }],
})
const list = (description: string) => ({ description, type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1 })

const common = {
  name: { description: 'The rule name shown in reasons, as [name]. Default: a name built from the matcher.', type: 'string', minLength: 1 },
  message: {
    description: 'The reason shown to Claude and the user. {path} is the matched file (path rules), {arg} the matched argument (args).',
    type: 'string',
    minLength: 1,
  },
  escalate: {
    description: 'After `after` firings in a session (within `within`), answer with `to` instead. Counts firings, not approvals.',
    type: 'object',
    additionalProperties: false,
    required: ['after', 'to'],
    properties: {
      after: { description: 'Firings before escalating (0 escalates at once).', type: 'integer', minimum: 0 },
      within: { description: 'Only count firings this recent, e.g. "10m", "2h", "30s".', type: 'string', pattern: '^\\d+[smhd]$' },
      to: { description: 'The answer once escalated.', enum: ['ask', 'deny'] },
      key: { description: 'Share one count between rules with the same key. Default: the rule name.', type: 'string', minLength: 1 },
    },
  },
}

const commandKeys = {
  command: names('The commands this rule matches'),
  subcommand: list('Words that must follow the command, e.g. ["push"] for git push.'),
  flags: list('Match only when one of these flags is set (after aliases), e.g. ["-i", "--in-place"].'),
  without_flags: list('Match only when none of these flags is set.'),
  aliases: {
    description: 'Flag spellings mapped to one name, e.g. { "-r" = "--recursive" }. Also lets short clusters like -rf split.',
    type: 'object',
    propertyNames: { pattern: '^-' },
    additionalProperties: { type: 'string', pattern: '^-' },
  },
  value_flags: list('Flags that take a value, so their value is not read as an argument: "-o", "--output".'),
  args: list('Match when some argument is one of these, as written ("~", "/", "$HOME"); a run-time value that could be one is unknown.'),
  via: list('Match only when run through one of these wrappers: sudo, xargs, env, bash -c ...'),
  standalone: { description: 'Match only a plain top-level command: not piped, wrapped, captured or redirected.', type: 'boolean' },
}

const pipeKey = {
  pipe: {
    description: 'A pipeline where a `from` command feeds a later `to` command, at any distance (curl x | tee log | sh).',
    type: 'object',
    additionalProperties: false,
    required: ['from', 'to'],
    properties: { from: names('Commands earlier in the pipe'), to: names('Commands later in the pipe') },
  },
}

const pathKeys = {
  path: {
    description: 'A glob for a file written or read by Write, Edit, MultiEdit, NotebookEdit, Read, a Bash redirect or tee. /x is absolute, ~/x under home, else under the project root.',
    type: 'string',
    minLength: 1,
  },
  op: { description: 'Which access matches. Default: write.', enum: ['write', 'read', 'any'] },
  except: list('Globs this rule leaves alone, e.g. ["**/*.example"].'),
  on_dynamic: { description: 'A path only known at run time ("$out"): ask (default, through on_unknown) or ignore.', enum: ['ask', 'ignore'] },
}

const wordKey = {
  word: {
    description: 'Any word of any command, wrappers included.',
    type: 'object',
    additionalProperties: false,
    required: ['prefix'],
    properties: {
      prefix: { description: 'The word starts with this, e.g. "--force".', type: 'string', minLength: 1 },
      unquoted: { description: 'Only an unquoted word (default true), so echo "--force" is fine.', type: 'boolean' },
    },
  },
}

const matcherOnly = (keys: object, owner: string) => Object.fromEntries(Object.keys(keys).filter((k) => k !== owner).map((k) => [k, [owner]]))

const action = (verb: string) => ({
  description: `Rules that ${verb}. Each has a message and exactly one matcher: command, pipe, path or word.`,
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['message'],
    properties: { ...common, ...commandKeys, ...pipeKey, ...pathKeys, ...wordKey },
    oneOf: [{ required: ['command'] }, { required: ['pipe'] }, { required: ['path'] }, { required: ['word'] }],
    dependentRequired: { ...matcherOnly(commandKeys, 'command'), ...matcherOnly(pathKeys, 'path') },
  },
})

const flagEntry = {
  description: '"" drops the flag, a string renames it, false means no equivalent, a table maps a flag that takes a value.',
  oneOf: [
    { type: 'string' },
    { type: 'boolean', const: false },
    {
      type: 'object',
      additionalProperties: false,
      required: ['to', 'value'],
      properties: {
        to: { description: 'The flag in the target command.', type: 'string', minLength: 1 },
        value: {
          description: '"number", "any", or a list of allowed values.',
          oneOf: [{ enum: ['number', 'any'] }, { type: 'array', items: { type: 'string' }, minItems: 1 }],
        },
        form: { description: 'How the value follows `to`: attached (-A3), separate (-g x, default) or equals (--color=x).', enum: ['attached', 'separate', 'equals'] },
        quote: { description: 'auto (default) quotes a value only when needed; always quotes it.', enum: ['auto', 'always'] },
        prefix: { description: 'Text put before the value, e.g. "!" to turn an include glob into an exclude.', type: 'string' },
        optional: { description: 'The flag may come without a value (long flags: --color or --color=never).', type: 'boolean' },
      },
    },
  ],
}

const rewrite = {
  description: 'Rewrite a command into another one, mapping its flags by a table. Anything the table cannot map is refused.',
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['command', 'to', 'message'],
    properties: {
      name: common.name,
      command: names('The commands to rewrite'),
      to: { description: 'The command to run instead, e.g. "rg".', type: 'string', minLength: 1 },
      flags: {
        description: 'Flag table, keyed by the flag as written: "-r" (short; clusters like -rn split) or "--recursive".',
        type: 'object',
        propertyNames: { pattern: '^-' },
        additionalProperties: { $ref: '#/$defs/flagEntry' },
      },
      like: {
        description: 'Start from the flag table (flags, unlisted, after_args) of an earlier rewrite with this name; flags here add to or override it.',
        type: 'string',
        minLength: 1,
      },
      add: list('Flags put first in the new command, e.g. ["-F"] for fgrep -> rg.'),
      unlisted: { description: 'A flag not in the table: refuse (default) or keep it as written.', enum: ['refuse', 'keep'] },
      after_args: { description: 'A flag after the first argument (not mapped): refuse (default) or keep.', enum: ['refuse', 'keep'] },
      refuse: { description: 'What a refusal answers, with `message` and the reason: deny (default) or ask.', enum: ['deny', 'ask'] },
      message: { description: 'The reason given when the command cannot be rewritten, e.g. "use rg (rg PATTERN [path])".', type: 'string', minLength: 1 },
      note: { description: 'A note shown to Claude with each rewrite.', type: 'string', minLength: 1 },
      via: commandKeys.via,
      standalone: commandKeys.standalone,
      escalate: common.escalate,
    },
  },
}

export const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: schemaUrl,
  title: 'hookshot.toml',
  description: 'Declarative Claude Code hook rules for hookshot (https://github.com/tjagithub/hookshot).',
  type: 'object',
  additionalProperties: false,
  required: ['version'],
  properties: {
    version: { description: 'The format version. Only 1 exists.', const: 1 },
    on_unknown: { description: 'What a call hookshot cannot decide gets: ask (default), deny or allow.', enum: ['ask', 'deny', 'allow'] },
    rewrite,
    deny: action('deny the call'),
    ask: action('ask the user first'),
    note: action('let the call through with a note to Claude'),
  },
  $defs: { flagEntry },
} as const

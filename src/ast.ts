// mvdan/sh typed JSON (`shfmt --to-json`). Only interface-typed fields carry `Type`; Stmt, Word,
// Redirect and Assign do not. Offsets are UTF-8 byte offsets into the parsed text.

export interface Pos {
  Offset: number
  Line: number
  Col: number
}

export interface Spanned {
  Pos: Pos
  End: Pos
}

export interface Node extends Spanned {
  Type?: string
  [key: string]: unknown
}

export interface File extends Node {
  Type: 'File'
  Stmts?: Stmt[]
}

export interface Stmt extends Spanned {
  Cmd?: Command | null
  Redirs?: Redirect[]
  Negated?: boolean
  Background?: boolean
  Coprocess?: boolean
  Disown?: boolean
}

export interface Redirect extends Spanned {
  Op: string
  N?: Lit | null
  Word?: Word | null
  Hdoc?: Word | null
}

export interface Assign extends Spanned {
  Name?: Lit | null
  Value?: Word | null
  Array?: Node | null
  Index?: Node | null
  Naked?: boolean
  Append?: boolean
}

export interface Word extends Spanned {
  Parts: WordPart[]
}

// The unions below are closed: a switch on Type narrows without casts, and `unhandled` in its default
// makes a missing case a compile error. mvdan may still send a Type not listed; `unhandled` names it.

export interface Lit extends Spanned {
  Type: 'Lit'
  /** Omitted when empty, like every typedjson field. */
  Value?: string
}
export interface SglQuoted extends Spanned {
  Type: 'SglQuoted'
  Value?: string
  Dollar?: boolean
}
export interface DblQuoted extends Spanned {
  Type: 'DblQuoted'
  Parts?: WordPart[]
  Dollar?: boolean
}
export interface ParamExp extends Spanned {
  Type: 'ParamExp'
  Param?: Lit | null
  Short?: boolean
}
export interface CmdSubst extends Spanned {
  Type: 'CmdSubst'
  Stmts?: Stmt[]
}
export interface ProcSubst extends Spanned {
  Type: 'ProcSubst'
  Op: string
  Stmts?: Stmt[]
}
/** Parts hookshot only scans into: their fields stay untyped. */
export interface OpaquePart extends Spanned {
  Type: 'ArithmExp' | 'ExtGlob' | 'BraceExp'
}
export type WordPart = Lit | SglQuoted | DblQuoted | ParamExp | CmdSubst | ProcSubst | OpaquePart

export interface CallExpr extends Spanned {
  Type: 'CallExpr'
  Assigns?: Assign[]
  Args?: Word[]
}
export interface BinaryCmd extends Spanned {
  Type: 'BinaryCmd'
  Op: string
  X: Stmt
  Y: Stmt
}
export interface IfClause extends Spanned {
  /** Absent on an else branch without its own condition. */
  Type?: 'IfClause'
  Cond?: Stmt[]
  Then?: Stmt[]
  Else?: IfClause | null
}
export interface Block extends Spanned {
  Type: 'Subshell' | 'Block'
  Stmts?: Stmt[]
}
export interface WhileClause extends Spanned {
  Type: 'WhileClause'
  Cond?: Stmt[]
  Do?: Stmt[]
}
export interface ForClause extends Spanned {
  Type: 'ForClause'
  Loop?: unknown
  Do?: Stmt[]
}
export interface CaseClause extends Spanned {
  Type: 'CaseClause'
  Word?: Word
  Items?: Array<{ Patterns?: Word[]; Stmts?: Stmt[] }>
}
export interface FuncDecl extends Spanned {
  Type: 'FuncDecl'
  Body?: Stmt
}
export interface Wrapped extends Spanned {
  Type: 'TimeClause' | 'CoprocClause'
  Stmt?: Stmt | null
}
/** Commands hookshot only scans for $(...) inside. */
export interface ScannedCmd extends Spanned {
  Type: 'DeclClause' | 'ArithmCmd' | 'LetClause' | 'TestClause'
}

export type Command =
  | CallExpr
  | BinaryCmd
  | (IfClause & { Type: 'IfClause' })
  | Block
  | WhileClause
  | ForClause
  | CaseClause
  | FuncDecl
  | Wrapped
  | ScannedCmd

/** For a switch default: never at compile time; at run time, the Type mvdan sent that no case covers. */
export const unhandled = (x: never): string => String((x as { Type?: unknown } | null)?.Type ?? 'unknown')

export const isNode = (v: unknown): v is Node => typeof v === 'object' && v !== null && !Array.isArray(v)

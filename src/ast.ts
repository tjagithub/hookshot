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

export interface Lit extends Node {
  Type: 'Lit'
  /** Omitted when empty, like every typedjson field. */
  Value?: string
}
export interface SglQuoted extends Node {
  Type: 'SglQuoted'
  Value?: string
  Dollar?: boolean
}
export interface DblQuoted extends Node {
  Type: 'DblQuoted'
  Parts?: WordPart[]
  Dollar?: boolean
}
export interface ParamExp extends Node {
  Type: 'ParamExp'
  Param?: Lit | null
  Short?: boolean
}
export interface CmdSubst extends Node {
  Type: 'CmdSubst'
  Stmts?: Stmt[]
}
export interface ProcSubst extends Node {
  Type: 'ProcSubst'
  Op: string
  Stmts?: Stmt[]
}
export type WordPart = Lit | SglQuoted | DblQuoted | ParamExp | CmdSubst | ProcSubst | Node

export interface CallExpr extends Node {
  Type: 'CallExpr'
  Assigns?: Assign[]
  Args?: Word[]
}
export interface BinaryCmd extends Node {
  Type: 'BinaryCmd'
  Op: string
  X: Stmt
  Y: Stmt
}
export interface IfClause extends Spanned {
  Type?: 'IfClause'
  Cond?: Stmt[]
  Then?: Stmt[]
  Else?: IfClause | null
}

export type Command =
  | CallExpr
  | BinaryCmd
  | (IfClause & { Type: 'IfClause' })
  | (Node & { Type: 'Subshell' | 'Block'; Stmts?: Stmt[] })
  | (Node & { Type: 'WhileClause'; Cond?: Stmt[]; Do?: Stmt[] })
  | (Node & { Type: 'ForClause'; Loop?: Node; Do?: Stmt[] })
  | (Node & { Type: 'CaseClause'; Word?: Word; Items?: Array<{ Patterns?: Word[]; Stmts?: Stmt[] }> })
  | (Node & { Type: 'FuncDecl'; Body?: Stmt })
  | (Node & { Type: 'TimeClause' | 'CoprocClause'; Stmt?: Stmt | null })
  | (Node & { Type: 'DeclClause'; Args?: Assign[] })
  | (Node & { Type: 'ArithmCmd' | 'LetClause' | 'TestClause' })

export const isNode = (v: unknown): v is Node => typeof v === 'object' && v !== null && !Array.isArray(v)

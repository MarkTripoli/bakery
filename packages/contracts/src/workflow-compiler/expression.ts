import {
  WORKFLOW_COMPILER_MESSAGES,
  type WorkflowCompilerDiagnosticCode,
} from "./diagnostics.ts";
import { isExactNumberText } from "./json-value.ts";
import { WORKFLOW_COMPILER_LIMITS } from "./limits.ts";
import { parseReferenceText } from "./reference.ts";
import type { WorkflowExpressionNode } from "./schema.ts";

/**
 * Recursive-descent parser for the restricted expression grammar:
 *
 *   expr    := or
 *   or      := and ("||" and)*
 *   and     := unary ("&&" unary)*
 *   unary   := "!" unary | cmp
 *   cmp     := operand (("==" | "!=" | "<" | "<=" | ">" | ">=" | "in") operand)?
 *   operand := reference | literal | list | "(" expr ")"
 *   literal := JSON string | JSON number | true | false | null
 *   list    := "[" (literal ("," literal)*)? "]"
 *
 * Comparison is non-associative. The parser only builds data nodes: it never
 * evaluates, interpolates or compiles any part of the text.
 */

export type ExpressionDiagnosticCode = Extract<
  WorkflowCompilerDiagnosticCode,
  | "expression_syntax_invalid"
  | "expression_too_long"
  | "expression_too_deep"
  | "expression_too_many_nodes"
  | "expression_list_too_long"
  | "expression_number_invalid"
  | "reference_malformed"
  | "reference_root_unknown"
  | "reference_secret_forbidden"
>;

/** Bounded-work counters reported with every parse, successful or not. */
export type ExpressionWork = {
  /** Tokens lexed, including the end marker. At most length + 1. */
  readonly tokens: number;
  /** AST nodes created. At most the node limit + 1. */
  readonly nodes: number;
  /** Deepest `!` / parenthesis nesting reached. At most the depth limit + 1. */
  readonly maxDepth: number;
};

export type ExpressionParseResult =
  | {
    readonly ok: true;
    readonly ast: WorkflowExpressionNode;
    readonly work: ExpressionWork;
  }
  | {
    readonly ok: false;
    readonly diagnostic: {
      readonly code: ExpressionDiagnosticCode;
      readonly message: string;
    };
    readonly work: ExpressionWork;
  };

type CompareOp = Extract<WorkflowExpressionNode, { kind: "compare" }>["op"];

type Token =
  | { readonly type: "punct"; readonly text: string }
  | { readonly type: "compare"; readonly op: CompareOp }
  | { readonly type: "ref"; readonly text: string }
  | {
    readonly type: "literal";
    readonly value: string | number | boolean | null;
  }
  | { readonly type: "end" };

class ExpressionStop extends Error {
  constructor(readonly code: ExpressionDiagnosticCode) {
    super(code);
  }
}

const WORD_CHAR = /[A-Za-z0-9_]/;
const REFERENCE_CHAR = /[A-Za-z0-9_.]/;
const DIGIT = /[0-9]/;
const NUMBER_SHAPE = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/;
const NUMBER_CHAR = /[0-9eE+\-.]/;
const HEX4 = /^[0-9a-fA-F]{4}$/;

const COMPARE_TWO: Readonly<Record<string, CompareOp>> = Object.freeze({
  "==": "eq",
  "!=": "ne",
  "<=": "le",
  ">=": "ge",
});
const COMPARE_ONE: Readonly<Record<string, CompareOp>> = Object.freeze({
  "<": "lt",
  ">": "gt",
});

class Parser {
  position = 0;
  tokens = 0;
  nodes = 0;
  depth = 0;
  maxDepth = 0;
  lookahead: Token;

  constructor(private readonly text: string) {
    this.lookahead = this.lex();
  }

  private fail(code: ExpressionDiagnosticCode): never {
    throw new ExpressionStop(code);
  }

  private lex(): Token {
    const { text } = this;
    while (this.position < text.length) {
      const char = text[this.position]!;
      if (char === " " || char === "\t" || char === "\n" || char === "\r") {
        this.position += 1;
      } else break;
    }
    this.tokens += 1;
    if (this.position >= text.length) return { type: "end" };
    const char = text[this.position]!;
    const pair = text.slice(this.position, this.position + 2);
    if (pair === "&&" || pair === "||") {
      this.position += 2;
      return { type: "punct", text: pair };
    }
    const twoOp = COMPARE_TWO[pair];
    if (twoOp) {
      this.position += 2;
      return { type: "compare", op: twoOp };
    }
    const oneOp = COMPARE_ONE[char];
    if (oneOp) {
      this.position += 1;
      return { type: "compare", op: oneOp };
    }
    if (
      char === "(" || char === ")" || char === "[" || char === "]" ||
      char === "," || char === "!"
    ) {
      this.position += 1;
      return { type: "punct", text: char };
    }
    if (char === '"') return { type: "literal", value: this.lexString() };
    if (char === "-" || DIGIT.test(char)) {
      return { type: "literal", value: this.lexNumber() };
    }
    if (char === "$") return this.lexReference();
    if (WORD_CHAR.test(char)) return this.lexWord();
    return this.fail("expression_syntax_invalid");
  }

  private lexReference(): Token {
    const start = this.position;
    this.position += 1;
    while (
      this.position < this.text.length &&
      REFERENCE_CHAR.test(this.text[this.position]!)
    ) this.position += 1;
    const parsed = parseReferenceText(this.text.slice(start, this.position));
    if (!parsed.ok) return this.fail(parsed.code);
    return { type: "ref", text: this.text.slice(start, this.position) };
  }

  private lexWord(): Token {
    const start = this.position;
    while (
      this.position < this.text.length &&
      WORD_CHAR.test(this.text[this.position]!)
    ) this.position += 1;
    const word = this.text.slice(start, this.position);
    if (word === "true") return { type: "literal", value: true };
    if (word === "false") return { type: "literal", value: false };
    if (word === "null") return { type: "literal", value: null };
    if (word === "in") return { type: "compare", op: "in" };
    return this.fail("expression_syntax_invalid");
  }

  private lexNumber(): number {
    const { text } = this;
    const start = this.position;
    let end = start;
    while (end < text.length && NUMBER_CHAR.test(text[end]!)) end += 1;
    this.position = end;
    if (end < text.length && WORD_CHAR.test(text[end]!)) {
      return this.fail("expression_syntax_invalid");
    }
    const token = text.slice(start, end);
    if (!NUMBER_SHAPE.test(token)) {
      return this.fail("expression_syntax_invalid");
    }
    if (!isExactNumberText(token)) {
      return this.fail("expression_number_invalid");
    }
    const value = Number(token);
    return Object.is(value, -0) ? 0 : value;
  }

  private lexString(): string {
    const { text } = this;
    this.position += 1;
    let result = "";
    while (true) {
      if (this.position >= text.length) {
        return this.fail("expression_syntax_invalid");
      }
      const char = text[this.position]!;
      this.position += 1;
      if (char === '"') return result;
      if (char.charCodeAt(0) < 0x20) {
        return this.fail("expression_syntax_invalid");
      }
      if (char !== "\\") {
        result += char;
        continue;
      }
      const escape = text[this.position];
      this.position += 1;
      switch (escape) {
        case '"':
          result += '"';
          break;
        case "\\":
          result += "\\";
          break;
        case "/":
          result += "/";
          break;
        case "b":
          result += "\b";
          break;
        case "f":
          result += "\f";
          break;
        case "n":
          result += "\n";
          break;
        case "r":
          result += "\r";
          break;
        case "t":
          result += "\t";
          break;
        case "u": {
          const hex = text.slice(this.position, this.position + 4);
          if (!HEX4.test(hex)) return this.fail("expression_syntax_invalid");
          result += String.fromCharCode(parseInt(hex, 16));
          this.position += 4;
          break;
        }
        default:
          return this.fail("expression_syntax_invalid");
      }
    }
  }

  private advance(): Token {
    const current = this.lookahead;
    this.lookahead = this.lex();
    return current;
  }

  private isPunct(text: string): boolean {
    return this.lookahead.type === "punct" && this.lookahead.text === text;
  }

  private expectPunct(text: string): void {
    if (!this.isPunct(text)) this.fail("expression_syntax_invalid");
    this.advance();
  }

  private node<T extends WorkflowExpressionNode>(created: T): T {
    this.nodes += 1;
    if (this.nodes > WORKFLOW_COMPILER_LIMITS.expression.nodes) {
      this.fail("expression_too_many_nodes");
    }
    return created;
  }

  private enter(): void {
    this.depth += 1;
    if (this.depth > this.maxDepth) this.maxDepth = this.depth;
    if (this.depth > WORKFLOW_COMPILER_LIMITS.expression.depth) {
      this.fail("expression_too_deep");
    }
  }

  private leave(): void {
    this.depth -= 1;
  }

  parse(): WorkflowExpressionNode {
    const expression = this.parseOr();
    if (this.lookahead.type !== "end") this.fail("expression_syntax_invalid");
    return expression;
  }

  private parseOr(): WorkflowExpressionNode {
    let left = this.parseAnd();
    while (this.isPunct("||")) {
      this.advance();
      const right = this.parseAnd();
      left = this.node({ kind: "logical", op: "or", left, right });
    }
    return left;
  }

  private parseAnd(): WorkflowExpressionNode {
    let left = this.parseUnary();
    while (this.isPunct("&&")) {
      this.advance();
      const right = this.parseUnary();
      left = this.node({ kind: "logical", op: "and", left, right });
    }
    return left;
  }

  private parseUnary(): WorkflowExpressionNode {
    if (this.isPunct("!")) {
      this.enter();
      this.advance();
      const operand = this.parseUnary();
      this.leave();
      return this.node({ kind: "not", operand });
    }
    return this.parseCompare();
  }

  private parseCompare(): WorkflowExpressionNode {
    const left = this.parseOperand();
    if (this.lookahead.type !== "compare") return left;
    const { op } = this.lookahead;
    this.advance();
    const right = this.parseOperand();
    return this.node({ kind: "compare", op, left, right });
  }

  private parseOperand(): WorkflowExpressionNode {
    const token = this.lookahead;
    if (token.type === "ref") {
      this.advance();
      const parsed = parseReferenceText(token.text);
      if (!parsed.ok) return this.fail(parsed.code);
      return this.node({ kind: "ref", root: parsed.root, path: parsed.path });
    }
    if (token.type === "literal") {
      this.advance();
      return this.node({ kind: "literal", value: token.value });
    }
    if (this.isPunct("[")) return this.parseList();
    if (this.isPunct("(")) {
      this.enter();
      this.advance();
      const inner = this.parseOr();
      this.expectPunct(")");
      this.leave();
      return inner;
    }
    return this.fail("expression_syntax_invalid");
  }

  private parseList(): WorkflowExpressionNode {
    this.advance();
    const items: WorkflowExpressionNode[] = [];
    if (!this.isPunct("]")) {
      while (true) {
        if (items.length >= WORKFLOW_COMPILER_LIMITS.expression.listItems) {
          this.fail("expression_list_too_long");
        }
        const token = this.lookahead;
        if (token.type !== "literal") this.fail("expression_syntax_invalid");
        this.advance();
        items.push(this.node({ kind: "literal", value: token.value }));
        if (this.isPunct(",")) {
          this.advance();
          continue;
        }
        break;
      }
    }
    this.expectPunct("]");
    return this.node({ kind: "list", items });
  }
}

/**
 * Parses one expression string into typed data nodes, or returns exactly one
 * diagnostic. The length limit is checked before any tokenizing; depth, node
 * and list limits are checked as the parser goes, so work stays bounded by the
 * counters in the result whatever the input. Diagnostics carry fixed prose and
 * never any part of the expression.
 */
export function parseWorkflowExpression(text: unknown): ExpressionParseResult {
  const empty: ExpressionWork = { tokens: 0, nodes: 0, maxDepth: 0 };
  const failure = (
    code: ExpressionDiagnosticCode,
    work: ExpressionWork,
  ): ExpressionParseResult => ({
    ok: false,
    diagnostic: Object.freeze({
      code,
      message: WORKFLOW_COMPILER_MESSAGES[code],
    }),
    work,
  });
  if (typeof text !== "string") {
    return failure("expression_syntax_invalid", empty);
  }
  if (text.length > WORKFLOW_COMPILER_LIMITS.expression.length) {
    return failure("expression_too_long", empty);
  }
  let parser: Parser | undefined;
  try {
    parser = new Parser(text);
    const ast = parser.parse();
    return {
      ok: true,
      ast,
      work: {
        tokens: parser.tokens,
        nodes: parser.nodes,
        maxDepth: parser.maxDepth,
      },
    };
  } catch (error) {
    if (!(error instanceof ExpressionStop)) throw error;
    const work = parser
      ? {
        tokens: parser.tokens,
        nodes: parser.nodes,
        maxDepth: parser.maxDepth,
      }
      : empty;
    return failure(error.code, work);
  }
}

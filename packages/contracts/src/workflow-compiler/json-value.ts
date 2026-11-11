import {
  createDiagnosticCollector,
  type DiagnosticCollector,
  pointerOf,
  type PointerSegment,
  type WorkflowCompilerDiagnostic,
} from "./diagnostics.ts";
import { canonicalJson } from "./canonical.ts";
import { WORKFLOW_COMPILER_LIMITS } from "./limits.ts";

/** Inert JSON value produced by the snapshot or the duplicate-rejecting decoder. */
export type WorkflowJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly WorkflowJsonValue[]
  | { readonly [key: string]: WorkflowJsonValue };

export type WorkflowJsonResult =
  | { readonly ok: true; readonly value: WorkflowJsonValue }
  | {
    readonly ok: false;
    readonly diagnostics: readonly WorkflowCompilerDiagnostic[];
  };

export type SnapshotOptions = {
  /**
   * Returns true when the container at these segments is opaque data (a
   * `json`-typed value or `$literal` content). Diagnostics below an opaque
   * container are reported at the container; its keys never enter a pointer.
   */
  readonly opaqueAt?: (segments: readonly PointerSegment[]) => boolean;
  /**
   * When set, an object key extends a pointer only if this returns true for
   * the key and its already-safe parent segments. Any other submitted key
   * truncates the pointer at its parent.
   */
  readonly structuralKey?: (
    parent: readonly PointerSegment[],
    key: string,
  ) => boolean;
};

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);
const SNAPSHOT_KEY = /^[a-z][A-Za-z0-9_]{0,63}$/;
const encoder = new TextEncoder();

type PathNode = {
  readonly parent: PathNode | null;
  readonly segment: PointerSegment;
};

function segmentsOf(node: PathNode | null): PointerSegment[] {
  const segments: PointerSegment[] = [];
  for (let cursor = node; cursor !== null; cursor = cursor.parent) {
    segments.push(cursor.segment);
  }
  return segments.reverse();
}

/**
 * Pointer for a snapshot path. Keys outside the strict snapshot pattern, and
 * everything under an opaque container, truncate to the nearest safe ancestor.
 */
function snapshotPointer(
  node: PathNode | null,
  options: SnapshotOptions,
): string {
  return safePointer(segmentsOf(node), options);
}

function safePointer(
  all: readonly PointerSegment[],
  options: SnapshotOptions,
): string {
  const safe: PointerSegment[] = [];
  for (const segment of all) {
    if (typeof segment === "string") {
      if (!SNAPSHOT_KEY.test(segment)) break;
      if (options.structuralKey && !options.structuralKey(safe, segment)) {
        break;
      }
    }
    safe.push(segment);
    if (options.opaqueAt?.(safe)) break;
  }
  return pointerOf(safe);
}

/**
 * Copies a candidate definition into a frozen, null-prototype JSON value with
 * one iterative bounded scan. Accessors are never invoked; non-plain objects,
 * symbols, bigint, functions, undefined, non-finite numbers, non-safe
 * integers, `__proto__`/`constructor`/`prototype` keys, excess depth, value
 * count or size are rejected with fixed diagnostics. A Proxy can observe
 * enumeration; the function trusts plain data from the JSON or YAML decoders.
 */
export function snapshotWorkflowValue(
  input: unknown,
  options: SnapshotOptions = {},
  collector: DiagnosticCollector = createDiagnosticCollector(),
): WorkflowJsonResult {
  const limits = WORKFLOW_COMPILER_LIMITS;
  const failuresBefore = collector.size;
  const containers: object[] = [];
  const fail = (
    node: PathNode | null,
    code: Parameters<DiagnosticCollector["add"]>[1],
  ) => collector.add(snapshotPointer(node, options), code);

  type Frame = {
    readonly source: unknown;
    readonly depth: number;
    readonly path: PathNode | null;
    readonly assign: (value: WorkflowJsonValue) => void;
  };
  let root: WorkflowJsonValue = null;
  const stack: Frame[] = [{
    source: input,
    depth: 0,
    path: null,
    assign: (value) => {
      root = value;
    },
  }];
  let count = 0;
  let approximateBytes = 0;
  let aborted = false;

  while (stack.length > 0 && !aborted) {
    const frame = stack.pop()!;
    const { source, depth, path, assign } = frame;
    count += 1;
    if (count > limits.jsonValues) {
      fail(path, "definition_too_many_values");
      aborted = true;
      break;
    }
    if (source === null || typeof source === "boolean") {
      approximateBytes += 5;
      assign(source);
    } else if (typeof source === "string") {
      approximateBytes += source.length + 2;
      if (approximateBytes > limits.bytes) {
        fail(path, "definition_too_large");
        aborted = true;
        break;
      }
      assign(source);
    } else if (typeof source === "number") {
      approximateBytes += 1;
      if (!Number.isFinite(source)) {
        fail(path, "definition_value_unsupported");
      } else if (Number.isInteger(source) && !Number.isSafeInteger(source)) {
        fail(path, "definition_number_invalid");
      } else {
        assign(Object.is(source, -0) ? 0 : source);
      }
    } else if (typeof source === "object") {
      if (depth >= limits.jsonDepth) {
        fail(path, "definition_too_deep");
        aborted = true;
        break;
      }
      if (Array.isArray(source)) {
        if (Object.getPrototypeOf(source) !== Array.prototype) {
          fail(path, "definition_value_unsupported");
          continue;
        }
        if (source.length > limits.jsonValues - count) {
          fail(path, "definition_too_many_values");
          aborted = true;
          break;
        }
        if (Reflect.ownKeys(source).length !== source.length + 1) {
          fail(path, "definition_value_unsupported");
          continue;
        }
        const out: WorkflowJsonValue[] = new Array(source.length).fill(null);
        containers.push(out);
        assign(out);
        approximateBytes += 2 + source.length;
        for (let index = source.length - 1; index >= 0; index -= 1) {
          const descriptor = Object.getOwnPropertyDescriptor(source, index);
          if (
            !descriptor || !("value" in descriptor) || !descriptor.enumerable
          ) {
            fail(path, "definition_value_unsupported");
            continue;
          }
          stack.push({
            source: descriptor.value,
            depth: depth + 1,
            path: { parent: path, segment: index },
            assign: (value) => {
              out[index] = value;
            },
          });
        }
      } else {
        const proto = Object.getPrototypeOf(source);
        if (proto !== Object.prototype && proto !== null) {
          fail(path, "definition_value_unsupported");
          continue;
        }
        const keys = Reflect.ownKeys(source);
        if (keys.length > limits.jsonValues - count) {
          fail(path, "definition_too_many_values");
          aborted = true;
          break;
        }
        const out: Record<string, WorkflowJsonValue> = Object.create(null);
        containers.push(out);
        assign(out);
        approximateBytes += 2;
        for (let index = keys.length - 1; index >= 0; index -= 1) {
          const key = keys[index]!;
          if (typeof key === "symbol") {
            fail(path, "definition_value_unsupported");
            continue;
          }
          if (FORBIDDEN_KEYS.has(key)) {
            fail(path, "definition_key_forbidden");
            continue;
          }
          const descriptor = Object.getOwnPropertyDescriptor(source, key);
          if (
            !descriptor || !("value" in descriptor) || !descriptor.enumerable
          ) {
            fail(path, "definition_value_unsupported");
            continue;
          }
          approximateBytes += key.length + 4;
          stack.push({
            source: descriptor.value,
            depth: depth + 1,
            path: { parent: path, segment: key },
            assign: (value) => {
              out[key] = value;
            },
          });
        }
      }
      if (approximateBytes > limits.bytes) {
        fail(path, "definition_too_large");
        aborted = true;
      }
    } else {
      fail(path, "definition_value_unsupported");
    }
  }

  if (collector.size > failuresBefore || aborted) {
    return { ok: false, diagnostics: collector.list() };
  }
  for (let index = containers.length - 1; index >= 0; index -= 1) {
    Object.freeze(containers[index]);
  }
  if (encoder.encode(canonicalJson(root)).length > limits.bytes) {
    collector.add("", "definition_too_large");
    return { ok: false, diagnostics: collector.list() };
  }
  return { ok: true, value: root };
}

type Decimal = {
  readonly negative: boolean;
  readonly digits: string;
  readonly exponent: bigint;
};

const NUMBER_TOKEN =
  /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/;

function normalizeDecimal(text: string): Decimal | null {
  const match = NUMBER_TOKEN.exec(text);
  if (!match) return null;
  const fraction = match[3] ?? "";
  let digits = `${match[2]}${fraction}`;
  let exponent = BigInt(match[4] ?? "0") - BigInt(fraction.length);
  const trimmed = digits.replace(/^0+/, "");
  digits = trimmed;
  if (digits === "") return { negative: false, digits: "", exponent: 0n };
  const stripped = digits.replace(/0+$/, "");
  exponent += BigInt(digits.length - stripped.length);
  return { negative: match[1] === "-", digits: stripped, exponent };
}

/**
 * True when a JSON number token is within the length bound and its exact
 * decimal value equals the decimal value of `String(Number(token))`, so the
 * double the runtime holds is the number the author wrote. `1` and `1.0`
 * qualify; `1.00000000000000001` and `9007199254740993` do not. Compared as
 * normalized digits and exponents, never with float arithmetic.
 */
export function isExactNumberText(token: string): boolean {
  if (
    token.length === 0 ||
    token.length > WORKFLOW_COMPILER_LIMITS.numberTokenChars
  ) {
    return false;
  }
  const written = normalizeDecimal(token);
  if (!written) return false;
  const value = Number(token);
  if (!Number.isFinite(value)) return false;
  const held = normalizeDecimal(String(value));
  if (!held) return false;
  return written.negative === held.negative && written.digits === held.digits &&
    written.exponent === held.exponent;
}

type DecodeContext = {
  readonly text: string;
  position: number;
  values: number;
  readonly path: PointerSegment[];
  readonly collector: DiagnosticCollector;
  readonly options: SnapshotOptions;
};

class DecodeStop extends Error {
  constructor() {
    super("decode stopped");
  }
}

const WHITESPACE = new Set([" ", "\t", "\n", "\r"]);

function skipWhitespace(context: DecodeContext): void {
  while (
    context.position < context.text.length &&
    WHITESPACE.has(context.text[context.position]!)
  ) context.position += 1;
}

function stop(
  context: DecodeContext,
  code: Parameters<DiagnosticCollector["add"]>[1],
): never {
  context.collector.add(safePointer(context.path, context.options), code);
  throw new DecodeStop();
}

function parseString(context: DecodeContext): string {
  const { text } = context;
  context.position += 1;
  let result = "";
  let chunkStart = context.position;
  while (true) {
    if (context.position >= text.length) {
      return stop(context, "definition_syntax_invalid");
    }
    const code = text.charCodeAt(context.position);
    if (code === 0x22) {
      result += text.slice(chunkStart, context.position);
      context.position += 1;
      return result;
    }
    if (code < 0x20) return stop(context, "definition_syntax_invalid");
    if (code === 0x5c) {
      result += text.slice(chunkStart, context.position);
      const escape = text[context.position + 1];
      context.position += 2;
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
          const hex = text.slice(context.position, context.position + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            return stop(context, "definition_syntax_invalid");
          }
          result += String.fromCharCode(parseInt(hex, 16));
          context.position += 4;
          break;
        }
        default:
          return stop(context, "definition_syntax_invalid");
      }
      chunkStart = context.position;
    } else {
      context.position += 1;
    }
    if (
      result.length + (context.position - chunkStart) >
        WORKFLOW_COMPILER_LIMITS.bytes
    ) {
      return stop(context, "definition_too_large");
    }
  }
}

function parseNumber(context: DecodeContext): number {
  const { text } = context;
  const start = context.position;
  const limit = WORKFLOW_COMPILER_LIMITS.numberTokenChars;
  let end = start;
  while (end < text.length && /[0-9eE+\-.]/.test(text[end]!)) {
    end += 1;
    if (end - start > limit) return stop(context, "definition_number_invalid");
  }
  const token = text.slice(start, end);
  context.position = end;
  if (!NUMBER_TOKEN.test(token)) {
    return stop(context, "definition_syntax_invalid");
  }
  if (!isExactNumberText(token)) {
    return stop(context, "definition_number_invalid");
  }
  const value = Number(token);
  return Object.is(value, -0) ? 0 : value;
}

function parseValue(context: DecodeContext, depth: number): unknown {
  skipWhitespace(context);
  context.values += 1;
  if (context.values > WORKFLOW_COMPILER_LIMITS.jsonValues) {
    return stop(context, "definition_too_many_values");
  }
  const { text } = context;
  const char = text[context.position];
  if (char === undefined) return stop(context, "definition_syntax_invalid");
  if (char === "{" || char === "[") {
    if (depth >= WORKFLOW_COMPILER_LIMITS.jsonDepth) {
      return stop(context, "definition_too_deep");
    }
    return char === "{"
      ? parseObject(context, depth)
      : parseArray(context, depth);
  }
  if (char === '"') return parseString(context);
  if (char === "-" || (char >= "0" && char <= "9")) return parseNumber(context);
  for (const [word, value] of LITERALS) {
    if (text.startsWith(word, context.position)) {
      context.position += word.length;
      return value;
    }
  }
  return stop(context, "definition_syntax_invalid");
}

const LITERALS: readonly (readonly [string, null | boolean])[] = [
  ["true", true],
  ["false", false],
  ["null", null],
];

function parseArray(context: DecodeContext, depth: number): unknown[] {
  context.position += 1;
  const result: unknown[] = [];
  skipWhitespace(context);
  if (context.text[context.position] === "]") {
    context.position += 1;
    return result;
  }
  while (true) {
    context.path.push(result.length);
    result.push(parseValue(context, depth + 1));
    context.path.pop();
    skipWhitespace(context);
    const char = context.text[context.position];
    context.position += 1;
    if (char === "]") return result;
    if (char !== ",") {
      context.position -= 1;
      return stop(context, "definition_syntax_invalid");
    }
  }
}

function parseObject(
  context: DecodeContext,
  depth: number,
): Record<string, unknown> {
  context.position += 1;
  const result: Record<string, unknown> = Object.create(null);
  skipWhitespace(context);
  if (context.text[context.position] === "}") {
    context.position += 1;
    return result;
  }
  while (true) {
    skipWhitespace(context);
    if (context.text[context.position] !== '"') {
      return stop(context, "definition_syntax_invalid");
    }
    const key = parseString(context);
    if (Object.hasOwn(result, key)) {
      return stop(context, "definition_duplicate_key");
    }
    skipWhitespace(context);
    if (context.text[context.position] !== ":") {
      return stop(context, "definition_syntax_invalid");
    }
    context.position += 1;
    context.path.push(key);
    result[key] = parseValue(context, depth + 1);
    context.path.pop();
    skipWhitespace(context);
    const char = context.text[context.position];
    context.position += 1;
    if (char === "}") return result;
    if (char !== ",") {
      context.position -= 1;
      return stop(context, "definition_syntax_invalid");
    }
  }
}

/**
 * Decodes JSON text with duplicate-member rejection, bounded depth and
 * exact-number checks, then runs the inert snapshot over the result. Text
 * longer than the byte ceiling is rejected before parsing.
 */
export function decodeWorkflowJson(
  text: string,
  options: SnapshotOptions = {},
): WorkflowJsonResult {
  const collector = createDiagnosticCollector();
  if (
    text.length > WORKFLOW_COMPILER_LIMITS.bytes ||
    encoder.encode(text).length > WORKFLOW_COMPILER_LIMITS.bytes
  ) {
    collector.add("", "definition_too_large");
    return { ok: false, diagnostics: collector.list() };
  }
  const context: DecodeContext = {
    text,
    position: 0,
    values: 0,
    path: [],
    collector,
    options,
  };
  let decoded: unknown;
  try {
    decoded = parseValue(context, 0);
    skipWhitespace(context);
    if (context.position < text.length) {
      stop(context, "definition_syntax_invalid");
    }
  } catch (error) {
    if (error instanceof DecodeStop) {
      return { ok: false, diagnostics: collector.list() };
    }
    throw error;
  }
  return snapshotWorkflowValue(decoded, options, collector);
}

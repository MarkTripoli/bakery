import {
  Composer,
  Document,
  isAlias,
  isMap,
  isScalar,
  isSeq,
  Parser,
  Scalar,
  visit,
} from "yaml";
import { canonicalJson } from "./canonical.ts";
import {
  createDiagnosticCollector,
  type DiagnosticCollector,
  pointerOf,
  type PointerSegment,
  type WorkflowCompilerDiagnostic,
} from "./diagnostics.ts";
import {
  isExactNumberText,
  type SnapshotOptions,
  snapshotWorkflowValue,
  type WorkflowJsonResult,
  type WorkflowJsonValue,
} from "./json-value.ts";
import { WORKFLOW_COMPILER_LIMITS } from "./limits.ts";

/**
 * YAML 1.2 as a JSON-compatible subset (doc 06, "One semantic document can
 * round-trip without preserving source formatting"). The importer refuses
 * what the JSON decoder could not represent: duplicate keys, anchors and
 * aliases, tags and directives, merge keys, more than one document,
 * non-string keys and numbers that are not exact finite JSON numbers. What
 * it accepts then passes through the same inert snapshot as JSON, so the
 * compiler never sees a value that depends on which syntax carried it.
 *
 * Comments and formatting are presentation data and are not kept.
 */

const encoder = new TextEncoder();

/**
 * What YAML 1.2 does not list as printable (`c-printable`): C0 controls other
 * than tab, line feed and carriage return, DEL, the C1 controls other than
 * NEL, U+FFFE and U+FFFF, and a surrogate that is not half of a pair. The JSON
 * decoder refuses a raw control character in a string; this refuses them in
 * the text before it is parsed, so no parser decides what they mean.
 */
const hex = (code: number) => `\\u${code.toString(16).padStart(4, "0")}`;
const NON_PRINTABLE = new RegExp(
  `[${
    [[0x00, 0x08], [0x0b, 0x0c], [0x0e, 0x1f], [0x7f, 0x84], [0x86, 0x9f], [
      0xfffe,
      0xffff,
    ]].map(([from, to]) => `${hex(from!)}-${hex(to!)}`).join("")
  }]|[\\ud800-\\udbff](?![\\udc00-\\udfff])|(?<![\\ud800-\\udbff])[\\udc00-\\udfff]`,
);
const PARSE_OPTIONS = Object.freeze(
  {
    version: "1.2",
    schema: "core",
    // Duplicates are found by the walk below, which knows the path; the parser
    // would only say that one exists.
    uniqueKeys: false,
    merge: false,
    keepSourceTokens: true,
  } as const,
);

function textBytes(text: string): number {
  return text.length > WORKFLOW_COMPILER_LIMITS.bytes
    ? text.length
    : encoder.encode(text).length;
}

function failed(
  collector: DiagnosticCollector,
  path: string,
  code: Parameters<DiagnosticCollector["add"]>[1],
): WorkflowJsonResult {
  collector.add(path, code);
  return { ok: false, diagnostics: collector.list() };
}

type PathNode = {
  readonly parent: PathNode | null;
  readonly segment: PointerSegment;
};

type Frame = { readonly node: unknown; readonly path: PathNode | null };

function segmentsOf(path: PathNode | null): PointerSegment[] {
  const segments: PointerSegment[] = [];
  for (let cursor = path; cursor !== null; cursor = cursor.parent) {
    segments.push(cursor.segment);
  }
  return segments.reverse();
}

/**
 * Walks the parsed document without recursion and reports every fault of the
 * kinds the parser would otherwise resolve silently: a tag changing a
 * scalar's type, an alias expanding, a merge key splicing members in, a key
 * that is not a string. Size, depth and value count are not judged here: the
 * inert snapshot judges them on the plain value, as it does for JSON.
 */
function inspect(
  document: Document.Parsed,
  collector: DiagnosticCollector,
): boolean {
  const start = collector.size;
  const stack: Frame[] = [{ node: document.contents, path: null }];
  const fail = (
    path: PathNode | null,
    code: Parameters<DiagnosticCollector["add"]>[1],
  ) => collector.add(pointerOf(segmentsOf(path)), code);
  while (stack.length > 0) {
    const { node, path } = stack.pop()!;
    if (isAlias(node)) {
      fail(path, "yaml_alias_forbidden");
      continue;
    }
    const { anchor, tag } = node as { anchor?: unknown; tag?: unknown };
    if (anchor !== undefined && anchor !== null) {
      fail(path, "yaml_alias_forbidden");
      continue;
    }
    if (tag !== undefined && tag !== null) {
      fail(path, "yaml_tag_forbidden");
      continue;
    }
    if (isScalar(node)) {
      if (typeof node.value === "number") {
        // The source text, not the parsed double: `1.00000000000000001`
        // and `12345678901234567890` parse to a number the author did not
        // write, and `0x1F`, `.5` and `+1` are not JSON numbers.
        const source = (node as unknown as { srcToken?: { source?: string } })
          .srcToken?.source;
        if (!isExactNumberText(source ?? String(node.value))) {
          fail(path, "definition_number_invalid");
        }
      }
      continue;
    }
    if (isSeq(node)) {
      for (let index = node.items.length - 1; index >= 0; index -= 1) {
        stack.push({
          node: node.items[index],
          path: { parent: path, segment: index },
        });
      }
      continue;
    }
    if (isMap(node)) {
      const seen = new Set<string>();
      for (let index = node.items.length - 1; index >= 0; index -= 1) {
        const pair = node.items[index]!;
        const key = pair.key;
        // Only the plain `<<` is a merge key; a quoted one is an ordinary
        // string, and export quotes every `<<` so it stays one.
        if (isScalar(key) && key.value === "<<" && key.type === "PLAIN") {
          fail(path, "yaml_merge_key_forbidden");
          continue;
        }
        if (!isScalar(key) || typeof key.value !== "string") {
          fail(path, "definition_value_unsupported");
          continue;
        }
        if (key.anchor || key.tag) {
          fail(path, key.tag ? "yaml_tag_forbidden" : "yaml_alias_forbidden");
          continue;
        }
        if (seen.has(key.value)) {
          fail(
            { parent: path, segment: key.value },
            "definition_duplicate_key",
          );
          continue;
        }
        seen.add(key.value);
        stack.push({
          node: pair.value,
          path: { parent: path, segment: key.value },
        });
      }
    }
  }
  return collector.size === start;
}

/**
 * Decodes one YAML 1.2 document into the same inert value the JSON decoder
 * returns. Text longer than the byte ceiling is refused before it is parsed.
 * Diagnostics carry fixed messages; no submitted text is echoed.
 */
export function decodeWorkflowYaml(
  text: string,
  options: SnapshotOptions = {},
): WorkflowJsonResult {
  const collector = createDiagnosticCollector();
  if (textBytes(text) > WORKFLOW_COMPILER_LIMITS.bytes) {
    return failed(collector, "", "definition_too_large");
  }
  if (NON_PRINTABLE.test(text)) {
    return failed(collector, "", "yaml_syntax_invalid");
  }
  try {
    return decodeParsed(text, options, collector);
  } catch (error) {
    // The parser and `toJS` compose nested collections recursively: a text
    // of the permitted size can nest deeper than the stack allows.
    return failed(
      collector,
      "",
      error instanceof RangeError
        ? "definition_too_deep"
        : "yaml_syntax_invalid",
    );
  }
}

function decodeParsed(
  text: string,
  options: SnapshotOptions,
  collector: DiagnosticCollector,
): WorkflowJsonResult {
  // The parse `parseAllDocuments` makes, with one addition: a directive of any
  // kind (`%YAML`, `%TAG`, an unknown one, even one that restates a default) is
  // seen in the token stream, where the document no longer says it was there.
  let directive = false;
  const tokens = new Parser().parse(text);
  const watched = (function* () {
    for (const token of tokens) {
      if (token.type === "directive") directive = true;
      yield token;
    }
  })();
  const documents = Array.from(
    new Composer(PARSE_OPTIONS).compose(watched),
  ) as Document.Parsed[];
  if (directive) return failed(collector, "", "yaml_tag_forbidden");
  if (documents.length > 1) {
    return failed(collector, "", "yaml_multiple_documents");
  }
  const document = documents[0];
  // No document at all: the text is empty or only comments.
  if (document === undefined || document.errors.length > 0) {
    return failed(collector, "", "yaml_syntax_invalid");
  }
  if (!inspect(document, collector)) {
    return { ok: false, diagnostics: collector.list() };
  }
  if (document.warnings.length > 0) {
    return failed(collector, "", "yaml_syntax_invalid");
  }
  return snapshotWorkflowValue(
    document.toJS({ maxAliasCount: 0 }),
    options,
    collector,
  );
}

export type WorkflowYamlEncodeResult =
  | { readonly ok: true; readonly text: string }
  | {
    readonly ok: false;
    readonly diagnostics: readonly WorkflowCompilerDiagnostic[];
  };

// Words a YAML 1.1 reader turns into booleans, null or a merge, and the 1.2
// core schema leaves as strings. Quoted on export so any reader agrees.
const YAML_1_1_WORD = /^(y|n|yes|no|on|off|true|false|null|~|<<)$/i;

// A string the plain and block styles cannot carry through a round trip: a
// byte order mark (read as one, not as data, at the start of a document) or a
// character the importer refuses raw. It is double quoted, and every such
// character is written as an escape.
const NEEDS_ESCAPES = new RegExp(`${NON_PRINTABLE.source}|\\uFEFF`);
const ESCAPED_EACH = new RegExp(`${NON_PRINTABLE.source}|\\uFEFF`, "g");

function escapeUnit(unit: string): string {
  return `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`;
}

function escaped(text: string): string {
  return text.replace(ESCAPED_EACH, escapeUnit);
}

// A fresh tree: nothing is shared, so the stringifier never needs an anchor.
function sortedTree(value: WorkflowJsonValue): unknown {
  if (Array.isArray(value)) return value.map(sortedTree);
  if (value !== null && typeof value === "object") {
    const record = value as { readonly [key: string]: WorkflowJsonValue };
    return new Map(
      Object.keys(record).sort().map((key) => [key, sortedTree(record[key]!)]),
    );
  }
  return value;
}

/**
 * Exports a semantic definition as block-style YAML 1.2 with sorted keys and
 * array order unchanged: the text `decodeWorkflowYaml` turns back into the same
 * canonical JSON and so the same digest. Nothing that is not plain JSON data
 * is exported. When block indentation would push the text past the byte
 * ceiling, the canonical JSON is emitted instead: JSON is YAML 1.2, so the
 * export always imports.
 */
export function encodeWorkflowYaml(value: unknown): WorkflowYamlEncodeResult {
  const snapshot = snapshotWorkflowValue(value);
  if (!snapshot.ok) return snapshot;
  const json = escaped(canonicalJson(snapshot.value));
  // A definition's root is an object. Anything else (a bare string, which block
  // YAML writes as a block scalar that does not always read back, a number, a
  // list) is exported as its canonical JSON.
  if (!isPlainObject(snapshot.value)) return { ok: true, text: json };
  const document = new Document(sortedTree(snapshot.value), {
    version: "1.2",
    schema: "core",
  });
  visit(document, {
    Scalar(_key, node) {
      if (typeof node.value !== "string") return;
      if (YAML_1_1_WORD.test(node.value) || NEEDS_ESCAPES.test(node.value)) {
        node.type = Scalar.QUOTE_DOUBLE;
      }
    },
  });
  const text = escaped(document.toString({ lineWidth: 0 }));
  return {
    ok: true,
    text: textBytes(text) <= WORKFLOW_COMPILER_LIMITS.bytes ? text : json,
  };
}

function isPlainObject(value: WorkflowJsonValue): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

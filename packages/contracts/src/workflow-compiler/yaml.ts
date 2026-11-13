import {
  Document,
  isAlias,
  isMap,
  isScalar,
  isSeq,
  parseAllDocuments,
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

const CORE_TAG_HANDLE = "tag:yaml.org,2002:";
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

function directiveFound(document: Document.Parsed): boolean {
  const { yaml, tags } = document.directives;
  if (yaml.explicit) return true;
  const handles = Object.keys(tags);
  return handles.length !== 1 || handles[0] !== "!!" ||
    tags["!!"] !== CORE_TAG_HANDLE;
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
  const documents = parseAllDocuments(text, PARSE_OPTIONS) as Document.Parsed[];
  if (documents.length > 1) {
    return failed(collector, "", "yaml_multiple_documents");
  }
  const document = documents[0];
  // No document at all: the text is empty or only comments.
  if (document === undefined || document.errors.length > 0) {
    return failed(collector, "", "yaml_syntax_invalid");
  }
  if (directiveFound(document)) {
    return failed(collector, "", "yaml_tag_forbidden");
  }
  if (!inspect(document, collector)) {
    return { ok: false, diagnostics: collector.list() };
  }
  const warning = document.warnings[0];
  if (warning !== undefined) {
    return failed(
      collector,
      "",
      warning.code === "TAG_RESOLVE_FAILED" || warning.code === "BAD_DIRECTIVE"
        ? "yaml_tag_forbidden"
        : "yaml_syntax_invalid",
    );
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
  const document = new Document(sortedTree(snapshot.value), {
    version: "1.2",
    schema: "core",
  });
  visit(document, {
    Scalar(_key, node) {
      if (typeof node.value === "string" && YAML_1_1_WORD.test(node.value)) {
        node.type = Scalar.QUOTE_DOUBLE;
      }
    },
  });
  const text = document.toString({ lineWidth: 0 });
  return {
    ok: true,
    text: textBytes(text) <= WORKFLOW_COMPILER_LIMITS.bytes
      ? text
      : canonicalJson(snapshot.value),
  };
}

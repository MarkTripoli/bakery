import { z } from "zod";
import {
  ProviderPermissionLevelSchema,
  ResourceKindIdSchema,
} from "@bakery/contracts/integrations";

export const MAX_RESPONSE_BYTES = 8_388_608;

const SEGMENT = /^(?:[A-Za-z0-9._~-]+|\{[a-z][a-z0-9_]*\})$/;
const PLACEHOLDER = /^\{([a-z][a-z0-9_]*)\}$/;

export type PathTemplate = {
  segments: readonly string[];
  placeholders: readonly string[];
};

/**
 * Parses a fixed path template. Every placeholder fills a whole segment.
 * Returns null for anything that could escape the template: `..`, `//`, `%`,
 * `?`, `#`, `\`, empty or relative paths, duplicate placeholders.
 */
export function parsePathTemplate(template: string): PathTemplate | null {
  if (!template.startsWith("/") || template.length > 512) return null;
  const segments = template.slice(1).split("/");
  const placeholders: string[] = [];
  for (const segment of segments) {
    if (!SEGMENT.test(segment) || segment === "." || segment === "..") {
      return null;
    }
    if (/^\.+$/.test(segment)) return null;
    const match = PLACEHOLDER.exec(segment);
    if (match) {
      if (placeholders.includes(match[1])) return null;
      placeholders.push(match[1]);
    }
  }
  return { segments, placeholders };
}

/** True when the schema is a zod object with a closed (never) catchall. */
export function isStrictObject(schema: unknown): boolean {
  if (!(schema instanceof z.ZodObject)) return false;
  const catchall = (schema._zod.def as { catchall?: unknown }).catchall;
  return catchall instanceof z.ZodNever;
}

const zodSchema = z.custom<z.ZodType>((v) => v instanceof z.ZodType, {
  message: "must be a zod schema",
}).describe(
  "Zod schema supplied by the integration author; descriptions are audited at activation.",
);

const strictObjectSchema = z.custom<z.ZodObject>(isStrictObject, {
  message: "must be a strict zod object (z.strictObject)",
}).describe(
  "Strict zod object schema; unknown keys are rejected so callers cannot smuggle extra fields.",
);

const PATH_PARAM_SOURCE =
  /^(?:input|input-text|binding:[a-zA-Z][a-zA-Z0-9_]*)$/;

/** The static query text a graphql template declares, or null when it has none. */
function graphqlDocumentOf(template: {
  body?: z.ZodType;
  graphqlQuery?: string;
}): string | null {
  return template.graphqlQuery ?? null;
}

/**
 * Removes everything in a document that is not structure: comments and string
 * and block-string literals. What is left is tokenised, so a field or an
 * argument that merely contains the word `mutation` cannot confuse the read.
 *
 * Commas need no handling here. They are insignificant whitespace in GraphQL,
 * which is why `},mutation` chains a second operation on the same line, but a
 * comma is not an identifier character, so the tokeniser skips it already.
 */
function graphqlStructure(document: string): string {
  let out = "";
  let index = 0;
  while (index < document.length) {
    const char = document[index];
    if (char === "#") {
      // A comment ends at either line terminator: graphql-js stops at 0x0A and
      // 0x0D, so a lone carriage return ends the comment and the text after it
      // is structure. Stopping only at "\n" would read a mutation that follows
      // a "\r" as part of the comment.
      while (
        index < document.length && document[index] !== "\n" &&
        document[index] !== "\r"
      ) {
        index++;
      }
      continue;
    }
    if (document.startsWith('"""', index)) {
      index += 3;
      while (index < document.length && !document.startsWith('"""', index)) {
        if (document[index] === "\\") index++;
        index++;
      }
      index += 3;
      out += " ";
      continue;
    }
    if (char === '"') {
      index++;
      while (index < document.length && document[index] !== '"') {
        if (document[index] === "\\") index++;
        index++;
      }
      index++;
      out += " ";
      continue;
    }
    out += char;
    index++;
  }
  return out;
}

const GRAPHQL_TOKEN = /[A-Za-z_][A-Za-z0-9_]*|[{}]/g;
const GRAPHQL_READABLE_OPENERS = new Set(["query", "fragment", "{"]);
const GRAPHQL_WRITE_OPERATIONS = new Set(["mutation", "subscription"]);

/**
 * A GraphQL request is a POST whose body is a document. It is a `read` only
 * when the whole document is queries and fragments.
 *
 * This reads the document's shape rather than matching words: strings and
 * comments are removed, commas are treated as whitespace, and only tokens at
 * brace depth zero are judged. Every depth-zero word must not be `mutation` or
 * `subscription`, so a document cannot chain a write after a query however the
 * two are separated. A field named `mutation` inside a selection is a field,
 * not an operation, and is allowed.
 */
/**
 * The GraphQL request body for a template: the declared document, with the
 * caller's values only as variables.
 *
 * The broker must build the body with this rather than sending the caller's
 * body through, or `effect: read` would be a claim about a document nobody
 * sends: a template could declare a harmless query and post a mutation in the
 * body, which would skip the write and approval gates that read bypasses.
 * A body key that tries to carry a document is refused, so the document can
 * only ever come from the template.
 */
export function graphqlBody(
  document: string,
  variables: Record<string, unknown>,
): { query: string; variables: Record<string, unknown> } {
  if (graphqlBodyCarriesDocument(variables)) {
    throw new Error("GRAPHQL_BODY_CARRIES_DOCUMENT: a body may not carry one");
  }
  return { query: document, variables };
}

/** Envelope keys a caller's values may never fill, whichever template it is. */
const GRAPHQL_ENVELOPE_KEYS: readonly string[] = [
  "query",
  "mutation",
  "document",
  "operationName",
];

/**
 * True when a caller's values try to fill an envelope key, so the document
 * could come from the caller rather than the template.
 */
export function graphqlBodyCarriesDocument(values: unknown): boolean {
  return typeof values === "object" && values !== null &&
    GRAPHQL_ENVELOPE_KEYS.some((key) => Object.hasOwn(values, key));
}

export function isGraphqlRead(query: string): boolean {
  const tokens = graphqlStructure(query).match(GRAPHQL_TOKEN);
  if (!tokens || tokens.length === 0) return false;
  if (!GRAPHQL_READABLE_OPENERS.has(tokens[0])) return false;
  let depth = 0;
  for (const token of tokens) {
    if (token === "{") {
      depth++;
      continue;
    }
    if (token === "}") {
      depth--;
      if (depth < 0) return false;
      continue;
    }
    if (depth === 0 && GRAPHQL_WRITE_OPERATIONS.has(token)) return false;
  }
  return depth === 0;
}

export const requestTemplateSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$/).max(128)
    .describe(
      "Namespaced request template identifier such as github.issue.comments.list.",
    ),
  version: z.number().int().positive().describe(
    "Explicit positive integer template version; templates are pinned per action, never latest.",
  ),
  method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]).describe(
    "HTTP method the host broker sends; the integration cannot choose another at call time.",
  ),
  // The description is on the inner enum as well as the wrapper: the audit
  // walks both nodes, and `.default()` returns a new node whose inner schema
  // keeps no description on its own.
  kind: z.enum(["rest", "graphql"]).describe(
    "Request kind: rest is a path-and-query request, graphql is a POST whose body is a query document on the provider's single endpoint.",
  ).default("rest").describe(
    "Request kind: rest is a path-and-query request, graphql is a POST whose body is a query document on the provider's single endpoint.",
  ),
  effect: z.enum(["read", "write"]).describe(
    "Declared provider effect. read is allowed for GET, HEAD, and a graphql POST whose document is verifiably a query, so read-only metadata cannot hide a mutation.",
  ),
  idempotent: z.boolean().describe(
    "True when repeating the request leaves provider state unchanged; GET and HEAD must be idempotent.",
  ),
  resourceKind: ResourceKindIdSchema,
  pathTemplate: z.string().max(512).describe(
    "Fixed path under the host-owned origin; placeholders fill whole segments and no query, fragment or traversal is allowed.",
  ),
  pathParams: z.record(
    z.string().regex(/^[a-z][a-z0-9_]*$/).describe(
      "Placeholder name used in the path template.",
    ),
    z.string().regex(PATH_PARAM_SOURCE).describe(
      "Source of the path value: binding:<attribute> is supplied by the host from the bound resource; input comes from the validated request input and must be a plain name; input-text comes from the validated request input and may be free text (a label name), which the host percent-encodes into one segment.",
    ),
  ).describe(
    "Maps every path placeholder to its source; unmapped or extra placeholders are rejected.",
  ),
  input: strictObjectSchema,
  query: z.array(
    z.string().regex(/^[a-z][a-z0-9_]*$/).describe(
      "Query parameter name taken from the request input.",
    ),
  ).max(16).describe(
    "Allowlist of query parameters; each must be a key of the request input and nothing else is sent.",
  ),
  body: zodSchema.optional().describe(
    "Optional request body schema; omitted for bodiless requests.",
  ),
  graphqlQuery: z.string().min(1).max(65_536).describe(
    "Static GraphQL document sent as the request body's query field; required for kind graphql and never assembled from caller input.",
  ).optional().describe(
    "Static GraphQL document sent as the request body's query field; required for kind graphql and never assembled from caller input.",
  ),
  response: zodSchema,
  refusal: z.strictObject({
    okField: z.string().regex(/^[a-z][a-zA-Z0-9_]*$/).describe(
      "Top-level boolean response field that is false when the provider refused the call.",
    ),
    codeField: z.string().regex(/^[a-z][a-zA-Z0-9_]*$/).describe(
      "Top-level string response field that names the provider's refusal reason.",
    ),
  }).describe(
    "How a provider that answers HTTP 200 marks a definite refusal in the body.",
  ).optional().describe(
    "Body-level refusal marker; when the ok field is false the broker records an authoritative rejection, so the write is known not to have happened.",
  ),
  maxResponseBytes: z.number().int().min(1).max(MAX_RESPONSE_BYTES).describe(
    "Hard cap on the response bytes the broker reads, between 1 and 8 MiB.",
  ),
  providerPermissions: z.record(
    z.string().regex(/^[a-z][a-z0-9_]*$/).describe(
      "Provider permission name from the host profile vocabulary.",
    ),
    ProviderPermissionLevelSchema,
  ).describe(
    "Provider permissions and levels this request needs; the connection must hold them.",
  ),
}).superRefine((t, ctx) => {
  const issue = (message: string, path: (string | number)[] = []) =>
    ctx.addIssue({ code: "custom", message, path });
  const readMethod = t.method === "GET" || t.method === "HEAD";
  const graphql = t.kind === "graphql";
  if (graphql) {
    // A GraphQL template is exactly one POST to one endpoint with a document
    // body. Path placeholders and query parameters would let the caller steer
    // the request away from the provider's single endpoint.
    if (t.method !== "POST") {
      issue("a graphql request must be POST", ["method"]);
    }
    if (t.query.length > 0) {
      issue("a graphql request carries no query parameters", ["query"]);
    }
    if (t.pathTemplate !== "/" && t.pathTemplate !== "/graphql") {
      issue("a graphql request targets the provider's graphql endpoint", [
        "pathTemplate",
      ]);
    }
    if (!t.body) issue("a graphql request must declare a body", ["body"]);
    const document = graphqlDocumentOf(t);
    if (document === null) {
      issue("a graphql body must carry a query string", ["body"]);
    } else if (t.effect === "read" && !isGraphqlRead(document)) {
      issue(
        "effect read needs a query document; a mutation cannot be read",
        ["effect"],
      );
    }
  } else if ((t.effect === "read") !== readMethod) {
    issue(
      "effect read is allowed only for GET and HEAD, or a graphql POST",
      ["effect"],
    );
  }
  if ((readMethod || graphql) && !t.idempotent) {
    issue("GET, HEAD and graphql requests must be idempotent", ["idempotent"]);
  }
  if (readMethod && t.body) issue("GET and HEAD cannot carry a body", ["body"]);
  const parsed = parsePathTemplate(t.pathTemplate);
  if (!parsed) {
    issue("invalid path template", ["pathTemplate"]);
    return;
  }
  const mapped = Object.keys(t.pathParams).sort();
  const declared = [...parsed.placeholders].sort();
  if (mapped.join() !== declared.join()) {
    issue("pathParams must map exactly the template placeholders", [
      "pathParams",
    ]);
  }
  const shape = t.input.shape as Record<string, unknown>;
  for (const [name, source] of Object.entries(t.pathParams)) {
    if ((source === "input" || source === "input-text") && !(name in shape)) {
      issue(`input path param ${name} missing from request input`, [
        "pathParams",
        name,
      ]);
    }
  }
  for (const key of t.query) {
    if (!(key in shape)) {
      issue(`query key ${key} missing from request input`, ["query"]);
    }
  }
  if (new Set(t.query).size !== t.query.length) {
    issue("query keys must be unique", ["query"]);
  }
}).describe(
  "Broker request template: fixed method, path under a host-owned origin, allowlisted query, bounded response and exact provider permissions. Carries no URL, header or secret.",
);
export type RequestTemplate = z.infer<typeof requestTemplateSchema>;

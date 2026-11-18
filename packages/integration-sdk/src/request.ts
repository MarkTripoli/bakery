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

const PATH_PARAM_SOURCE = /^(?:input|binding:[a-zA-Z][a-zA-Z0-9_]*)$/;

/** The static query text a graphql template declares, or null when it has none. */
function graphqlDocumentOf(template: {
  body?: z.ZodType;
  graphqlQuery?: string;
}): string | null {
  return template.graphqlQuery ?? null;
}

/** A document may open with a query or an anonymous selection, nothing else. */
const GRAPHQL_OPERATION = /^\s*(?:query\b|\{)/;
/**
 * A mutation anywhere in the document blocks a read. Anchoring this at the
 * start would let `query Q { a } mutation M { ... }` through, and a document
 * chains operations, so the keyword is searched for at any depth.
 */
const GRAPHQL_MUTATION = /(?:^|[}\s])mutation\b/;

/**
 * A GraphQL request is a POST whose body is a document. It is a `read` only
 * when the document is verifiably a query: the first keyword must be `query`
 * (or `subscription` is refused here too, since it streams) and the text must
 * not open a `mutation` anywhere, because a document can chain operations and
 * an alias or fragment can hide one further down.
 */
export function isGraphqlRead(query: string): boolean {
  return GRAPHQL_OPERATION.test(query) && !GRAPHQL_MUTATION.test(query);
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
      "Source of the path value: binding:<attribute> is supplied by the host from the bound resource; input comes from the validated request input.",
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
    if (source === "input" && !(name in shape)) {
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

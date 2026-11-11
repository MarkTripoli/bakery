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
  effect: z.enum(["read", "write"]).describe(
    "Declared provider effect; read is allowed only for GET and HEAD, so read-only metadata cannot hide a mutation.",
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
  if ((t.effect === "read") !== readMethod) {
    issue("effect read is allowed only for GET and HEAD", ["effect"]);
  }
  if (readMethod && !t.idempotent) {
    issue("GET and HEAD requests must be idempotent", ["idempotent"]);
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

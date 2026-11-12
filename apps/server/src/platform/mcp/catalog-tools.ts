import { z } from "zod";
import type { ActionRegistry } from "@bakery/contracts/action-registry";
import {
  type CatalogAction,
  catalogActions,
  type CatalogPermissionKey,
  routeParameterNames,
} from "@bakery/contracts/contracts";
import {
  type ActionContextSeed,
  createApiRouter,
  toProblem,
} from "@bakery/contracts/http";
import type { McpGrant } from "./guard.ts";

/** Header the authority runner reads to scope an action to one organization. */
const ORGANIZATION_HEADER = "Bakery-Organization-Id";
/** Largest tool result the MCP resource returns inline. */
export const MAX_TOOL_RESULT_BYTES = 1024 * 1024;

/** Standard Schema the MCP SDK accepts for a tool's input. */
export type McpDiscoverySchema = {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: "bakery";
    validate(
      value: unknown,
    ):
      | { value: Record<string, unknown> }
      | { issues: { message: string }[] };
    readonly jsonSchema: {
      input(options: { target: string }): Record<string, unknown>;
      output(options: { target: string }): Record<string, unknown>;
    };
  };
};

/**
 * Publishes `schema` as the tool's JSON Schema but only checks that arguments
 * are an object. Field validation is left to the REST pipeline the call runs
 * through, so an invalid argument comes back as the REST fault code in
 * `structuredContent.problem` instead of SDK text.
 */
export function discoverySchema(schema: z.ZodObject): McpDiscoverySchema {
  const json = (io: "input" | "output", target: string) =>
    z.toJSONSchema(schema, {
      target: target as "draft-2020-12",
      io,
      unrepresentable: "any",
    }) as Record<string, unknown>;
  return {
    "~standard": {
      version: 1,
      vendor: "bakery",
      validate: (value) =>
        typeof value === "object" && value !== null && !Array.isArray(value)
          ? { value: value as Record<string, unknown> }
          : { issues: [{ message: "Tool arguments must be a JSON object." }] },
      jsonSchema: {
        input: ({ target }) => json("input", target),
        output: ({ target }) => json("output", target),
      },
    },
  };
}

/** One catalog operation exposed as an MCP tool under its catalog `mcp` name. */
export type McpCatalogTool = Readonly<{
  name: string;
  action: string;
  method: string;
  path: string;
  permission: CatalogPermissionKey;
  pathNames: readonly string[];
  inputSchema: z.ZodObject;
  discoverySchema: McpDiscoverySchema;
  description: string;
}>;

/** Runs one action outside the REST router; throws a StandardError on refusal. */
export type McpToolOverride = (call: {
  request: Request;
  principal: unknown;
  params: Record<string, string>;
}) => Promise<unknown>;

/** Success of a tool call: the REST status, body and the headers a client needs to continue. */
export type McpToolSuccess = {
  status: number;
  body: unknown;
  etag?: string;
  location?: string;
};

export type McpToolOutcome =
  | { ok: true; result: McpToolSuccess }
  | { ok: false; problem: Record<string, unknown> };

export type McpCatalogToolRunner = {
  readonly tools: readonly McpCatalogTool[];
  get(name: string): McpCatalogTool | undefined;
  run(
    tool: McpCatalogTool,
    grant: McpGrant,
    args: Record<string, unknown>,
  ): Promise<McpToolOutcome>;
};

function toolInputSchema(
  catalog: CatalogAction,
  input: z.ZodType,
  pathNames: readonly string[],
): z.ZodObject {
  const base = input instanceof z.ZodObject ? input.shape : {};
  const shape: Record<string, z.ZodType> = { ...base };
  for (const name of pathNames) {
    shape[name] ??= z.string().min(1).describe(
      `Route identifier ${name} of the ${catalog.action} operation.`,
    );
  }
  if (catalog.method !== "GET") {
    shape.idempotencyKey = z.string().min(1).max(255).optional().describe(
      "Idempotency key, sent as the Idempotency-Key header; replaying the same key with the same input returns the original result.",
    );
  }
  if (
    catalog.method === "PATCH" || catalog.method === "PUT" ||
    catalog.method === "DELETE"
  ) {
    shape.ifMatch = z.string().min(1).max(200).optional().describe(
      "Strong ETag of the version being changed, sent as the If-Match header.",
    );
  }
  return z.object(shape).describe(
    `Input of the ${catalog.action} operation, with its route identifiers and request headers as fields.`,
  );
}

/**
 * A header argument Headers.set accepts unchanged: visible ASCII with inner
 * spaces, starting and ending with a visible character. The raw value is
 * tested, never a trimmed copy: JavaScript trim() strips characters (U+3000,
 * U+FEFF and others) that Headers rejects. Leading or trailing whitespace,
 * control characters, CR/LF, characters above U+007E and lone surrogates are
 * a validation fault, not a 500.
 */
function isHeaderValue(value: unknown): value is string {
  return typeof value === "string" &&
    /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/.test(value);
}

/**
 * Tools generated from the operation catalog for the registries the MCP
 * resource is given: every implemented operation with a catalog `mcp` name and
 * a permission. A call is sent in-process through a REST router built over the
 * same registry, so validation, authorization, idempotency, preconditions,
 * status codes and fault codes are the REST ones by construction.
 */
export function createMcpCatalogTools(options: {
  publicOrigin: string;
  registries: readonly ActionRegistry[];
  /** The authenticated subject the registries expect, loaded live for the provider user. */
  loadSubject(providerUserId: string): Promise<unknown>;
  deadlineMs?: number;
  /**
   * Actions whose REST response is not a JSON body (byte streams). The tool
   * runs this instead, under the action's own authority, and returns JSON.
   */
  overrides?: Readonly<Record<string, McpToolOverride>>;
}): McpCatalogToolRunner {
  const origin = new URL(options.publicOrigin).origin;
  const seeds = new WeakMap<Request, ActionContextSeed>();
  const byAction = new Map(
    catalogActions.map((entry) => [entry.action, entry]),
  );
  const tools: McpCatalogTool[] = [];
  const routers: {
    action: string;
    fetch: (request: Request) => Promise<Response>;
  }[] = [];
  for (const registry of options.registries) {
    const router = createApiRouter({
      registry,
      publicBaseUrl: origin,
      deadlineMs: options.deadlineMs,
      createContext: (context) => {
        const seed = seeds.get(context.req.raw);
        if (!seed) {
          throw new Error("MCP tool request without a seeded principal");
        }
        return seed;
      },
    });
    for (const action of registry.list()) {
      const catalog = byAction.get(action.name as CatalogAction["action"]);
      if (!catalog?.mcp || !catalog.permission) continue;
      // Access-management actions refuse token-authenticated callers; an MCP
      // grant is token authentication, so they are never tools.
      if (action.policy.sessionOnly === true) continue;
      const pathNames = routeParameterNames(action.path);
      const schema = toolInputSchema(catalog, action.input, pathNames);
      tools.push(Object.freeze({
        name: catalog.mcp,
        action: action.name,
        method: action.method,
        path: action.path,
        permission: catalog.permission,
        pathNames,
        inputSchema: schema,
        discoverySchema: discoverySchema(schema),
        description: action.input.description ??
          `Runs the ${action.name} operation.`,
      }));
      routers.push({
        action: action.name,
        fetch: (r) => Promise.resolve(router.fetch(r)),
      });
    }
  }
  tools.sort((a, b) => a.name.localeCompare(b.name));
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const routerFor = new Map(
    routers.map((entry) => [entry.action, entry.fetch]),
  );
  return {
    tools,
    get: (name) => byName.get(name),
    async run(tool, grant, args) {
      const { idempotencyKey, ifMatch, ...fields } = args;
      const invalid = (): McpToolOutcome => ({
        ok: false,
        problem: { code: "MALFORMED_REQUEST", status: 400 },
      });
      // Header arguments must be strings when given; never dropped silently.
      if (
        (idempotencyKey !== undefined && !isHeaderValue(idempotencyKey)) ||
        (ifMatch !== undefined && !isHeaderValue(ifMatch))
      ) return invalid();
      // A route identifier is one opaque path segment. Empty, "." and ".."
      // would be collapsed by URL normalization and could reach another route.
      const segments: string[] = [];
      for (const name of tool.pathNames) {
        const value = fields[name];
        if (
          typeof value !== "string" || !value.isWellFormed() || value === "" ||
          value === "." ||
          value === ".." || value.includes("/") || value.includes("\\")
        ) return invalid();
        segments.push(encodeURIComponent(value));
      }
      let path = tool.path;
      tool.pathNames.forEach((name, index) => {
        path = path.replace(`:${name}`, segments[index]!);
      });
      const url = new URL(`${origin}${path}`);
      // The request must reach exactly the route this tool's scope was checked for.
      if (url.pathname !== path) return invalid();
      const principal = await options.loadSubject(grant.providerUserId);
      const headers = new Headers({
        [ORGANIZATION_HEADER]: grant.organizationId,
      });
      if (typeof idempotencyKey === "string") {
        headers.set("idempotency-key", idempotencyKey);
      }
      if (typeof ifMatch === "string") headers.set("if-match", ifMatch);
      let body: string | undefined;
      if (tool.method === "GET") {
        for (const [key, value] of Object.entries(fields)) {
          if (tool.pathNames.includes(key) || value === undefined) continue;
          url.searchParams.set(
            key,
            typeof value === "string" ? value : JSON.stringify(value),
          );
        }
      } else {
        headers.set("content-type", "application/json");
        // Route identifiers travel in the path only, as a REST client sends them.
        body = JSON.stringify(
          Object.fromEntries(
            Object.entries(fields).filter(([key]) =>
              !tool.pathNames.includes(key)
            ),
          ),
        );
      }
      const request = new Request(url, { method: tool.method, headers, body });
      const override = options.overrides?.[tool.action];
      if (override) {
        const params = Object.fromEntries(
          tool.pathNames.map((name) => [name, String(fields[name])]),
        );
        try {
          const result = await override({ request, principal, params });
          return { ok: true, result: { status: 200, body: result } };
        } catch (error) {
          const problem = toProblem(error, {
            requestId: crypto.randomUUID(),
            traceId: crypto.randomUUID().replaceAll("-", ""),
            publicBaseUrl: origin,
          });
          return {
            ok: false,
            problem: problem as unknown as Record<string, unknown>,
          };
        }
      }
      seeds.set(request, { principal } as ActionContextSeed);
      const response = await routerFor.get(tool.action)!(request);
      const text = await response.text();
      if (new TextEncoder().encode(text).byteLength > MAX_TOOL_RESULT_BYTES) {
        return {
          ok: false,
          problem: {
            code: "RESPONSE_TOO_LARGE",
            status: 502,
            title:
              "The result is larger than an MCP tool result may be; read it through REST.",
          },
        };
      }
      const parsed = text ? JSON.parse(text) : null;
      if (!response.ok) {
        return { ok: false, problem: parsed as Record<string, unknown> };
      }
      const etag = response.headers.get("etag") ?? undefined;
      const location = response.headers.get("location") ?? undefined;
      return {
        ok: true,
        result: {
          status: response.status,
          body: parsed,
          ...(etag ? { etag } : {}),
          ...(location ? { location } : {}),
        },
      };
    },
  };
}

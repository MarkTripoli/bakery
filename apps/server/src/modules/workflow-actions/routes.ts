import {
  WORKFLOW_ACTION_METADATA,
  WORKFLOW_ACTION_NAMES,
  WORKFLOW_ACTION_REGISTRY_VERSION,
  type WorkflowActionMetadata,
  type WorkflowActionName,
} from "@bakery/contracts/workflow-action-registry";
import { problemResponse, StandardError } from "@bakery/contracts/http";
import type { contractSchemas } from "@bakery/contracts/contracts";
import type { z } from "zod";
import { Hono, type MiddlewareHandler } from "hono";
import type { AuthVariables } from "../auth/middleware.ts";
import { createWorkflowActionRuntime } from "../workflows/action-runtime.ts";

/** Wire shape of one declaration, typed from the published contract schema. */
export type WorkflowActionMetadataDeclaration = z.output<
  typeof contractSchemas.WorkflowActionDeclaration
>;

const DEFAULT_PAGE_LIMIT = 25;
const MAX_PAGE_LIMIT = 100;
const CURSOR_MAX_LENGTH = 512;
const CURSOR_ACTION = "workflowActions.list";
const CURSOR_ORDERING = "registry-order:asc";
const CURSOR_SCHEMA_VERSION = 1;

type WorkflowActionCursor = {
  readonly action: typeof CURSOR_ACTION;
  readonly after: WorkflowActionName;
  readonly catalogVersion: typeof WORKFLOW_ACTION_REGISTRY_VERSION;
  readonly ordering: typeof CURSOR_ORDERING;
  readonly schemaVersion: typeof CURSOR_SCHEMA_VERSION;
};

function invalidCursor(): never {
  throw new StandardError({ code: "INVALID_CURSOR" });
}

function encodeCursor(after: WorkflowActionName): string {
  const payload: WorkflowActionCursor = {
    action: CURSOR_ACTION,
    after,
    catalogVersion: WORKFLOW_ACTION_REGISTRY_VERSION,
    ordering: CURSOR_ORDERING,
    schemaVersion: CURSOR_SCHEMA_VERSION,
  };
  return btoa(JSON.stringify(payload))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeCursor(cursor: string): number {
  if (
    cursor.length === 0 || cursor.length > CURSOR_MAX_LENGTH ||
    !/^[A-Za-z0-9_-]+$/u.test(cursor) || cursor.length % 4 === 1
  ) invalidCursor();

  let value: unknown;
  try {
    const encoded = cursor.replaceAll("-", "+").replaceAll("_", "/");
    value = JSON.parse(
      atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=")),
    );
  } catch {
    return invalidCursor();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalidCursor();
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !==
      "action,after,catalogVersion,ordering,schemaVersion" ||
    record.action !== CURSOR_ACTION ||
    record.catalogVersion !== WORKFLOW_ACTION_REGISTRY_VERSION ||
    record.ordering !== CURSOR_ORDERING ||
    record.schemaVersion !== CURSOR_SCHEMA_VERSION ||
    typeof record.after !== "string" ||
    !Object.hasOwn(WORKFLOW_ACTION_METADATA, record.after)
  ) return invalidCursor();

  const after = record.after as WorkflowActionName;
  if (encodeCursor(after) !== cursor) return invalidCursor();
  const index = WORKFLOW_ACTION_NAMES.indexOf(after);
  if (index < 0 || index >= WORKFLOW_ACTION_NAMES.length - 1) {
    return invalidCursor();
  }
  return index + 1;
}

function listQuery(url: string): { start: number; limit: number } {
  const search = new URL(url).searchParams;
  const limits = search.getAll("limit");
  const cursors = search.getAll("cursor");
  if (
    limits.length > 1 || cursors.length > 1 ||
    ["page", "pageNumber", "pageIndex", "offset", "skip"].some((name) =>
      search.has(name)
    )
  ) {
    throw new StandardError({ code: "MALFORMED_REQUEST" });
  }
  const rawLimit = limits[0];
  if (rawLimit !== undefined && !/^[1-9][0-9]*$/u.test(rawLimit)) {
    throw new StandardError({ code: "MALFORMED_REQUEST" });
  }
  const limit = rawLimit === undefined ? DEFAULT_PAGE_LIMIT : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit > MAX_PAGE_LIMIT) {
    throw new StandardError({ code: "MALFORMED_REQUEST" });
  }
  return {
    start: cursors[0] === undefined ? 0 : decodeCursor(cursors[0]),
    limit,
  };
}

function declaration(
  actionId: WorkflowActionName,
): WorkflowActionMetadataDeclaration {
  const metadata: WorkflowActionMetadata = WORKFLOW_ACTION_METADATA[actionId];
  return {
    actionId,
    version: WORKFLOW_ACTION_REGISTRY_VERSION,
    ...metadata,
    capabilities: [...metadata.capabilities],
    retry: { ...metadata.retry, faults: [...metadata.retry.faults] },
    modelBillingRequired: metadata.capabilities.includes("model"),
  };
}

function findDeclaration(
  actionId: string,
  version: string,
): WorkflowActionMetadataDeclaration {
  if (
    version !== String(WORKFLOW_ACTION_REGISTRY_VERSION) ||
    !Object.hasOwn(WORKFLOW_ACTION_METADATA, actionId)
  ) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  return declaration(actionId as WorkflowActionName);
}

export function createWorkflowActionRoutes(options: {
  browserSession: MiddlewareHandler<{ Variables: AuthVariables }>;
  publicBaseUrl: string;
  schemas?: Parameters<typeof createWorkflowActionRuntime>[0];
}) {
  // Runtime drift (missing handler, schema, or metadata) fails app startup.
  createWorkflowActionRuntime(options.schemas);
  const app = new Hono<{ Variables: AuthVariables }>();
  app.onError((error, context) =>
    problemResponse(context, error, { publicBaseUrl: options.publicBaseUrl })
  );
  app.use("/v1/workflow-actions", options.browserSession);
  app.use("/v1/workflow-actions/*", options.browserSession);
  app.get("/v1/workflow-actions", (context) => {
    const { start, limit } = listQuery(context.req.url);
    const actionIds = WORKFLOW_ACTION_NAMES.slice(start, start + limit);
    const hasNext = start + actionIds.length < WORKFLOW_ACTION_NAMES.length;
    return context.json({
      items: actionIds.map(declaration),
      nextCursor: hasNext ? encodeCursor(actionIds.at(-1)!) : null,
    });
  });
  app.get(
    "/v1/workflow-actions/:actionId/versions/:version",
    (context) =>
      context.json(
        findDeclaration(
          context.req.param("actionId"),
          context.req.param("version"),
        ),
      ),
  );
  return app;
}

import { assert, assertEquals } from "@std/assert";
import {
  assertDescribedJsonSchema,
  contractSchemas,
} from "../../packages/contracts/src/contracts.ts";
import {
  WORKFLOW_ACTION_NAMES,
  WORKFLOW_ACTION_REGISTRY_VERSION,
} from "../../packages/contracts/src/workflow-action-registry.ts";
import {
  WorkflowActionDiscoveryImplementedAction,
  workflowActionDiscoveryImplementedActions,
} from "../../packages/contracts/src/implemented-actions.ts";
import { createWorkflowActionRoutes } from "../../apps/server/src/modules/workflow-actions/routes.ts";

type Json = Record<string, unknown>;

const readJson = async (path: string): Promise<Json> =>
  JSON.parse(await Deno.readTextFile(new URL(path, import.meta.url))) as Json;

const catalog = await readJson("../../docs/technical-design/api-catalog.json");
const transport = await readJson(
  "../../docs/technical-design/transport-schemas.json",
);
const generated = await readJson(
  "../../packages/contracts/generated/contracts.json",
) as { schemas: Record<string, Json>; openapi: Json } & Json;
const inputs = transport.inputs as Record<string, Json>;
const outputs = transport.outputs as Record<string, Json>;
const entry = (action: string): Json => {
  const found = (catalog.actions as Json[]).find((row) =>
    row.action === action
  );
  assert(found, `catalog entry ${action}`);
  return found;
};

/** Validates the JSON Schema subset the contract generator emits. */
function conforms(schema: Json, value: unknown, path = "$"): string[] {
  if (Array.isArray(schema.anyOf)) {
    const attempts = (schema.anyOf as Json[]).map((option) =>
      conforms(option, value, path)
    );
    return attempts.some((errors) => errors.length === 0)
      ? []
      : [`${path}: no anyOf branch matched`];
  }
  const errors: string[] = [];
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const kind = value === null
    ? "null"
    : Array.isArray(value)
    ? "array"
    : Number.isInteger(value)
    ? "integer"
    : typeof value;
  const typeOk = schema.type === undefined ||
    types.some((type) =>
      type === kind || (type === "number" && kind === "integer")
    );
  if (!typeOk) return [`${path}: expected ${types.join("|")}, got ${kind}`];
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${path}: not in enum`);
  }
  if ("const" in schema && schema.const !== value) {
    errors.push(`${path}: not const`);
  }
  if (typeof value === "string") {
    if (
      typeof schema.maxLength === "number" && value.length > schema.maxLength
    ) {
      errors.push(`${path}: too long`);
    }
    if (
      typeof schema.minLength === "number" && value.length < schema.minLength
    ) errors.push(`${path}: too short`);
    if (
      typeof schema.pattern === "string" &&
      !new RegExp(schema.pattern, "u").test(value)
    ) errors.push(`${path}: pattern`);
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push(`${path}: below minimum`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push(`${path}: above maximum`);
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      errors.push(`${path}: too many items`);
    }
    if (schema.items) {
      value.forEach((item, index) =>
        errors.push(
          ...conforms(schema.items as Json, item, `${path}[${index}]`),
        )
      );
    }
  }
  if (kind === "object") {
    const record = value as Json;
    const properties = (schema.properties ?? {}) as Record<string, Json>;
    for (const required of (schema.required ?? []) as string[]) {
      if (!(required in record)) errors.push(`${path}.${required}: missing`);
    }
    for (const [key, child] of Object.entries(record)) {
      if (properties[key]) {
        errors.push(...conforms(properties[key], child, `${path}.${key}`));
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}.${key}: unexpected`);
      }
    }
  }
  return errors;
}

function checkBoth(name: string, value: unknown): void {
  const schema = (contractSchemas as Record<string, {
    safeParse(value: unknown): { success: boolean };
  }>)[name];
  assert(schema, `contract schema ${name}`);
  assertEquals(schema.safeParse(value).success, true, `${name} zod parse`);
  assertEquals(
    conforms(generated.schemas[name], value),
    [],
    `${name} generated JSON Schema`,
  );
}

const app = createWorkflowActionRoutes({
  publicBaseUrl: "https://bakery.example",
  browserSession: async (_context, next) => await next(),
});

Deno.test("discovery catalog entries carry exact routes, policy and errors", () => {
  const auth = [
    "AUTH_REQUIRED",
    "AUTH_INVALID",
    "AUTH_EXPIRED",
    "AUTH_FACTOR_REQUIRED",
    "AUTH_FORBIDDEN",
  ];
  const expected = [
    {
      action: "workflowActions.list",
      path: "/v1/workflow-actions",
      input: "WorkflowActionsListQuery",
      output: "Page<WorkflowActionDeclaration>",
      errors: [...auth, "MALFORMED_REQUEST", "INVALID_CURSOR"],
    },
    {
      action: "workflowActions.get",
      path: "/v1/workflow-actions/{actionId}/versions/{version}",
      input: "WorkflowActionVersionPath",
      output: "WorkflowActionDeclaration",
      errors: [...auth, "RESOURCE_NOT_FOUND"],
    },
  ];
  for (const want of expected) {
    const row = entry(want.action);
    assertEquals(row.method, "GET");
    assertEquals(row.access, "Authenticated");
    assertEquals(row.permission, "workflowAction:read");
    assertEquals(row.organizationContext, "authenticated_principal_scope");
    assertEquals(row.mcp, null);
    assertEquals(row.idempotency, "read");
    assertEquals(row.event, "");
    for (const key of ["path", "input", "output", "errors"] as const) {
      assertEquals(row[key], want[key], `${want.action}.${key}`);
    }
  }
  assertEquals(workflowActionDiscoveryImplementedActions, [
    WorkflowActionDiscoveryImplementedAction.WorkflowActionsList,
    WorkflowActionDiscoveryImplementedAction.WorkflowActionsGet,
  ]);
  const paths = (generated.openapi.paths ?? {}) as Record<string, Json>;
  assert(paths["/v1/workflow-actions"]?.get);
  const detail = paths["/v1/workflow-actions/{actionId}/versions/{version}"]
    ?.get as Json;
  assert(detail);
  assertEquals(
    (detail.parameters as Json[]).map((parameter) => parameter.name),
    ["actionId", "version"],
  );
});

Deno.test("discovery and binding schemas are described", () => {
  for (
    const name of [
      "WorkflowActionsListQuery",
      "WorkflowActionVersionPath",
      "PlanInput",
    ]
  ) {
    assert(inputs[name], `input ${name}`);
    assert(String(inputs[name].description).length > 20, `${name} description`);
    assertDescribedJsonSchema(generated.schemas[name], name);
  }
  for (
    const name of [
      "WorkflowActionDeclaration",
      "WorkflowActionRetry",
      "Page<WorkflowActionDeclaration>",
      "WorkflowStepBinding",
      "ValidationReport",
    ]
  ) {
    assert(outputs[name], `output ${name}`);
    assertDescribedJsonSchema(generated.schemas[name], name);
  }
  const plan = generated.schemas.PlanInput as {
    properties: Record<string, Json>;
    required: string[];
  };
  assertEquals(plan.required, ["designArtifact"]);
  assert(String(plan.properties.designArtifact.description).length > 20);
  assertEquals(
    (outputs.ValidationReport.optionalFields as string[]).includes(
      "stepBindings",
    ),
    true,
  );
});

type Page = {
  items: Json[];
  nextCursor: string | null;
};

async function walk(limit: number): Promise<Json[]> {
  const items: Json[] = [];
  let cursor: string | null = null;
  const seen = new Set<string>();
  do {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set("cursor", cursor);
    const response = await app.request(`/v1/workflow-actions?${query}`);
    assertEquals(response.status, 200);
    const page = await response.json() as Page;
    assert(page.items.length <= limit);
    checkBoth("Page<WorkflowActionDeclaration>", page);
    checkBoth("WorkflowActionsListQuery", {
      limit,
      ...(cursor ? { cursor } : {}),
    });
    items.push(...page.items);
    cursor = page.nextCursor;
    if (cursor) {
      assert(!seen.has(cursor), "cursor never repeats");
      seen.add(cursor);
    }
  } while (cursor);
  return items;
}

Deno.test("every mounted list page parses at limits 1, 7 and 100", async () => {
  for (const limit of [1, 7, 100]) {
    const items = await walk(limit);
    assertEquals(
      items.map((item) => item.actionId),
      [...WORKFLOW_ACTION_NAMES],
      `limit ${limit}`,
    );
  }
});

Deno.test("every mounted detail parses, including delivery.candidate_evidence", async () => {
  assert(
    (WORKFLOW_ACTION_NAMES as readonly string[]).includes(
      "delivery.candidate_evidence",
    ),
  );
  for (const actionId of WORKFLOW_ACTION_NAMES) {
    const path = { actionId, version: WORKFLOW_ACTION_REGISTRY_VERSION };
    checkBoth("WorkflowActionVersionPath", path);
    const response = await app.request(
      `/v1/workflow-actions/${actionId}/versions/${WORKFLOW_ACTION_REGISTRY_VERSION}`,
    );
    assertEquals(response.status, 200, actionId);
    const detail = await response.json() as Json;
    assertEquals(detail.actionId, actionId);
    checkBoth("WorkflowActionDeclaration", detail);
  }
});

Deno.test("not found and malformed answers are Problem bodies", async () => {
  for (
    const path of [
      "/v1/workflow-actions/rpi.plan/versions/abc",
      "/v1/workflow-actions/rpi.plan/versions/2",
      "/v1/workflow-actions/unknown.action/versions/1",
    ]
  ) {
    const response = await app.request(path);
    assertEquals(response.status, 404, path);
    const body = await response.json();
    assertEquals(contractSchemas.Problem.safeParse(body).success, true, path);
    assertEquals((body as Json).code, "RESOURCE_NOT_FOUND");
  }
  for (const query of ["limit=0", "limit=101", "limit=x", "offset=1"]) {
    const response = await app.request(`/v1/workflow-actions?${query}`);
    assertEquals(response.status, 400, query);
    const body = await response.json();
    assertEquals(contractSchemas.Problem.safeParse(body).success, true, query);
    assertEquals((body as Json).code, "MALFORMED_REQUEST");
  }
  const bad = await app.request("/v1/workflow-actions?cursor=AAAA");
  assertEquals(bad.status, 400);
  const body = await bad.json();
  assertEquals(contractSchemas.Problem.safeParse(body).success, true);
  assertEquals((body as Json).code, "INVALID_CURSOR");
});

Deno.test("ValidationReport with stepBindings parses and PlanInput resolves", () => {
  const binding = {
    stepId: "implement",
    action: "harness.implement",
    source: "workflow",
    agentVersionId: "11111111-1111-4111-8111-111111111111",
    revision: 2,
    digest: "b".repeat(64),
    requiredCapabilities: ["git", "shell", "web", "model"],
    modelBillingRequired: true,
  };
  const report = {
    valid: true,
    errors: [],
    warnings: [],
    normalizedDigest: "c".repeat(64),
    graph: {},
    requiresRepository: true,
    registryVersion: 1,
    registryDigest: "d".repeat(64),
    stepBindings: [binding],
  };
  checkBoth("ValidationReport", report);
  const { stepBindings: _omitted, ...withoutBindings } = report;
  checkBoth("ValidationReport", withoutBindings);
  checkBoth("WorkflowStepBinding", binding);
  assertEquals(
    contractSchemas.ValidationReport.safeParse({
      ...report,
      stepBindings: [{ ...binding, digest: `sha256:${"b".repeat(64)}` }],
    }).success,
    false,
  );
  checkBoth("PlanInput", {
    designArtifact: "11111111-1111-4111-8111-111111111111",
  });
  assertEquals(
    contractSchemas.PlanInput.safeParse({ designArtifact: "x" }).success,
    false,
  );
});

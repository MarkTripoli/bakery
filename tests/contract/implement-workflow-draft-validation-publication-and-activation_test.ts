import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  assertDescribedJsonSchema,
  contractSchemas,
  toJsonSchema,
} from "../../packages/contracts/src/contracts.ts";
import {
  WorkflowImplementedAction,
  workflowImplementedActions,
} from "../../packages/contracts/src/implemented-actions.ts";
import {
  createWorkflowsActionRegistry,
  type WorkflowsActionHandlers,
} from "../../apps/server/src/modules/workflows/actions.ts";
import type { PgDatabase } from "../../apps/server/src/platform/database.ts";

type Json = Record<string, unknown>;

const readJson = async (name: string): Promise<Json> =>
  JSON.parse(
    await Deno.readTextFile(
      new URL(`../../docs/technical-design/${name}`, import.meta.url),
    ),
  ) as Json;

const catalog = await readJson("api-catalog.json");
const transport = await readJson("transport-schemas.json");
const actions = catalog.actions as Json[];
const inputs = transport.inputs as Record<string, Json>;
const outputs = transport.outputs as Record<string, Json>;
const events = transport.events as Record<string, Json>;

const ID = "11111111-1111-4111-8111-111111111111";
const SHA = "a".repeat(64);

const entry = (action: string): Json => {
  const found = actions.find((candidate) => candidate.action === action);
  assert(found, `catalog entry ${action} exists`);
  return found;
};

const fieldOf = (schema: Json, name: string): Json => {
  const found = (schema.fields as Json[]).find((field) => field.name === name);
  assert(found, `field ${name} exists`);
  return found;
};

const existing = [
  "workflows.list",
  "workflows.get",
  "workflows.create",
  "workflows.update",
  "workflowVersions.list",
  "workflowVersions.create",
  "workflows.validate",
];

Deno.test("existing workflow catalog entries require an authenticated organization context", () => {
  for (const action of existing) {
    const row = entry(action);
    assertEquals(row.organizationContext, "required_authenticated_context");
    const errors = row.errors as string[];
    assert(errors.includes("SCOPE_REQUIRED"), `${action} SCOPE_REQUIRED`);
    assert(errors.includes("MALFORMED_REQUEST"), `${action} MALFORMED_REQUEST`);
  }
});

Deno.test("new workflow publication catalog entries carry exact routes and policies", () => {
  const expected = [
    {
      action: "workflowVersions.get",
      method: "GET",
      path: "/v1/workflows/{id}/versions/{versionId}",
      access: "Developer",
      permission: "workflowVersion:read",
      input: "WorkflowVersionPath",
      output: "WorkflowVersion",
      event: "",
      idempotency: "read",
    },
    {
      action: "workflowVersions.update",
      method: "PATCH",
      path: "/v1/workflows/{id}/versions/{versionId}",
      access: "Admin",
      permission: "workflowVersion:manage",
      input: "WorkflowDraftUpdate",
      output: "WorkflowVersion",
      event: "workflow.version_updated",
      idempotency: "Idempotency-Key required; PATCH also If-Match",
    },
    {
      action: "workflowVersions.publish",
      method: "POST",
      path: "/v1/workflows/{id}/versions/{versionId}/publish",
      access: "Admin",
      permission: "workflowVersion:manage",
      input: "WorkflowVersionPublish",
      output: "WorkflowVersion",
      event: "workflow.version_published",
      idempotency: "Idempotency-Key + If-Match required",
    },
    {
      action: "workflowActivations.create",
      method: "POST",
      path: "/v1/workflows/{id}/activations",
      access: "Admin",
      permission: "workflow:manage",
      input: "WorkflowActivationCreate",
      output: "Workflow",
      event: "workflows.updated",
      idempotency: "Idempotency-Key + If-Match required",
    },
  ];
  for (const want of expected) {
    const row = entry(want.action);
    for (const [key, value] of Object.entries(want)) {
      assertEquals(row[key], value, `${want.action}.${key}`);
    }
    assertEquals(row.organizationContext, "required_authenticated_context");
    const errors = row.errors as string[];
    assert(errors.includes("SCOPE_REQUIRED"));
    assert(errors.includes("MALFORMED_REQUEST"));
    if (want.method !== "GET") {
      for (
        const code of [
          "UNPROCESSABLE",
          "STATE_CONFLICT",
          "PRECONDITION_FAILED",
          "PRECONDITION_REQUIRED",
          "IDEMPOTENCY_PAYLOAD_MISMATCH",
        ]
      ) assert(errors.includes(code), `${want.action} ${code}`);
    }
  }
});

Deno.test("new workflow schemas and events are described", () => {
  for (
    const name of [
      "WorkflowVersionPath",
      "WorkflowDraftUpdate",
      "WorkflowVersionPublish",
      "WorkflowActivationCreate",
      "WorkflowVersionCreate",
      "ValidationReport",
    ] as const
  ) {
    assertDescribedJsonSchema(
      toJsonSchema(contractSchemas[name]),
      `schemas.${name}`,
    );
  }
  for (
    const name of ["workflow.version_updated", "workflow.version_published"]
  ) {
    assert(events[name], `event ${name}`);
    assert((events[name].description as string).length > 20);
  }
});

Deno.test("descriptions state draft semantics and drop the old publish wording", () => {
  const create = inputs.WorkflowVersionCreate;
  const checks: [string, string][] = [
    [create.description as string, "single shared mutable draft"],
    [
      fieldOf(create, "definition").description as string,
      "Initial draft specification",
    ],
    [
      fieldOf(create, "revision").description as string,
      "server allocates the draft revision",
    ],
    [
      fieldOf(create, "digest").description as string,
      "server-computed canonical digest",
    ],
    [
      fieldOf(create, "sourceYaml").description as string,
      "canonical JSON text",
    ],
    [
      fieldOf(inputs.WorkflowValidation, "definition").description as string,
      "the same shape a draft saves",
    ],
    [
      outputs.WorkflowVersion.description as string,
      "A draft (mutable, with a compare-and-set version)",
    ],
    [
      (outputs.WorkflowVersion.fieldDescriptions as Json).status as string,
      "draft is the shared editable draft",
    ],
    [
      (outputs.WorkflowVersion.fieldDescriptions as Json).version as string,
      "Draft compare-and-set counter",
    ],
    [
      fieldOf(inputs.RunCreate, "workflowVersionId").description as string,
      "Exactly one of workflowVersionId, presetId and workflowId",
    ],
    [
      fieldOf(inputs.RunCreate, "presetId").description as string,
      "Exactly one of workflowVersionId, presetId and workflowId",
    ],
    [
      fieldOf(inputs.RunCreate, "workflowId").description as string,
      "active published version",
    ],
    [
      (outputs.ValidationIssue.fieldDescriptions as Json).path as string,
      "JSON Pointer into the submitted definition",
    ],
  ];
  for (const [text, phrase] of checks) {
    assert(text.includes(phrase), `expected "${phrase}" in "${text}"`);
  }
  const serialized = JSON.stringify([
    create,
    inputs.WorkflowValidation,
    outputs.WorkflowVersion,
    inputs.RunCreate,
    outputs.ValidationIssue,
  ]);
  for (
    const stale of [
      "Publishes a new immutable version",
      "Exactly one of workflowVersionId and presetId must",
      "Filesystem or route path",
    ]
  ) assertFalse(serialized.includes(stale), `stale phrase: ${stale}`);
});

Deno.test("RunCreate requires exactly one of three selectors", () => {
  const base = { executionMode: "cloud_only" };
  const schema = contractSchemas.RunCreate;
  assert(schema.safeParse({ ...base, workflowVersionId: ID }).success);
  assert(schema.safeParse({ ...base, presetId: "fixed-coding" }).success);
  assert(schema.safeParse({ ...base, workflowId: ID }).success);
  assertFalse(schema.safeParse(base).success);
  assertFalse(
    schema.safeParse({ ...base, workflowVersionId: ID, workflowId: ID })
      .success,
  );
  assertFalse(
    schema.safeParse({ ...base, presetId: "fixed-coding", workflowId: ID })
      .success,
  );
  assertFalse(
    schema.safeParse({
      ...base,
      workflowVersionId: ID,
      presetId: "fixed-coding",
    }).success,
  );
});

Deno.test("WorkflowVersionCreate revision and digest are optional, sourceYaml is accepted", () => {
  const schema = contractSchemas.WorkflowVersionCreate;
  assert(schema.safeParse({ definition: { kind: "fixed" } }).success);
  assert(
    schema.safeParse({
      definition: { kind: "fixed" },
      revision: 3,
      digest: SHA,
      sourceYaml: "kind: fixed",
    }).success,
  );
  assertFalse(schema.safeParse({ revision: 1 }).success);
});

Deno.test("ValidationReport parses with and without the optional analysis fields", () => {
  const schema = contractSchemas.ValidationReport;
  const base = { valid: true, errors: [], warnings: [], normalizedDigest: SHA };
  assert(schema.safeParse(base).success);
  assert(
    schema.safeParse({
      ...base,
      graph: { nodes: [], edges: [] },
      requiresRepository: false,
      registryVersion: 1,
      registryDigest: SHA,
    }).success,
  );
});

const implementedWorkflowActions = [
  "workflowActivations.create",
  "workflowVersions.create",
  "workflowVersions.get",
  "workflowVersions.list",
  "workflowVersions.publish",
  "workflowVersions.update",
  "workflows.create",
  "workflows.get",
  "workflows.list",
  "workflows.update",
  "workflows.validate",
];

Deno.test("workflows registry implements exactly the eleven definition, read, draft, publish, activate and validate actions", () => {
  const unavailable = () => Promise.reject(new Error("not called"));
  const registry = createWorkflowsActionRegistry(
    {} as PgDatabase,
    {
      listWorkflows: unavailable,
      getWorkflow: unavailable,
      createWorkflow: unavailable,
      updateWorkflow: unavailable,
      listVersions: unavailable,
      getVersion: unavailable,
      createVersion: unavailable,
      updateVersion: unavailable,
      publishVersion: unavailable,
      activate: unavailable,
      validate: unavailable,
    } as unknown as WorkflowsActionHandlers,
  );
  assertEquals(
    registry.list().map(({ name }) => name).sort(),
    implementedWorkflowActions,
  );
  assertEquals(
    [...workflowImplementedActions].sort(),
    implementedWorkflowActions,
  );
  assertEquals(
    Object.values(WorkflowImplementedAction).sort(),
    implementedWorkflowActions,
  );
  for (const action of implementedWorkflowActions) {
    assertEquals(
      entry(action).organizationContext,
      "required_authenticated_context",
    );
  }
});

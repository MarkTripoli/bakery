import { assert, assertEquals } from "@std/assert";
import { z } from "zod";
import {
  assertDescribedJsonSchema,
  contractSchemas,
  toJsonSchema,
} from "../../packages/contracts/src/contracts.ts";
import { CoordinationImplementedAction } from "../../packages/contracts/src/implemented-actions.ts";
import { createCoordinationActionRegistry } from "../../apps/server/src/coordination-actions.ts";
import { CoordinationPlanOriginSchema } from "../../apps/server/src/modules/work/coordination-plan.ts";

const PARENT = crypto.randomUUID();
const VERSION = crypto.randomUUID();

Deno.test("the saved-workflow entry is a registered coordination operation with a described input", () => {
  assertEquals(
    CoordinationImplementedAction.CoordinationPlansCreateFromWorkflow,
    "coordinationPlans.createFromWorkflow",
  );
  const registry = createCoordinationActionRegistry(
    new Proxy({}, { get: () => () => undefined }) as never,
    {
      authorityRunner: { authorize: () => undefined } as never,
      commandRunner: { run: () => undefined } as never,
    },
  );
  const registered = registry.list().find((action) =>
    action.name === "coordinationPlans.createFromWorkflow"
  );
  assert(registered, "operation is registered");
  assertEquals(registered.path, "/v1/coordination-plans/from-workflow");
  assertDescribedJsonSchema(
    toJsonSchema(contractSchemas.CoordinationPlanCreateFromWorkflow),
    "CoordinationPlanCreateFromWorkflow",
  );
  const parsed = contractSchemas.CoordinationPlanCreateFromWorkflow.safeParse({
    parentTaskId: PARENT,
    workflowVersionId: VERSION,
    nodeId: "delivery",
  });
  assert(parsed.success);
  for (
    const bad of [
      { parentTaskId: PARENT, workflowVersionId: VERSION },
      { parentTaskId: PARENT, workflowVersionId: VERSION, nodeId: "" },
      {
        parentTaskId: PARENT,
        workflowVersionId: VERSION,
        nodeId: "x",
        spec: {},
      },
    ]
  ) {
    assertEquals(
      contractSchemas.CoordinationPlanCreateFromWorkflow.safeParse(bad).success,
      false,
    );
  }
});

Deno.test("plan create takes an optional origin and the plan output carries one", () => {
  const input = contractSchemas.CoordinationPlanCreate.safeParse({
    parentTaskId: PARENT,
    spec: {},
    origin: { kind: "ticket", provider: "jira", reference: "BAK-1" },
  });
  assert(input.success);
  assert(
    contractSchemas.CoordinationPlanCreate.safeParse({
      parentTaskId: PARENT,
      spec: {},
    }).success,
    "origin stays optional on create",
  );
  const outputJson = toJsonSchema(contractSchemas.CoordinationPlan) as {
    properties: Record<string, unknown>;
    required: string[];
  };
  assert("origin" in outputJson.properties);
  assert(outputJson.required.includes("origin"));
});

Deno.test("every node of the origin schema carries a meaningful description", () => {
  assertDescribedJsonSchema(
    z.toJSONSchema(CoordinationPlanOriginSchema),
    "CoordinationPlanOrigin",
  );
});

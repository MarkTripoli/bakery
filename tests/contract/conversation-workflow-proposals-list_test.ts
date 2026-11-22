import { assert, assertEquals, assertThrows } from "@std/assert";
import { contractSchemas } from "../../packages/contracts/src/contracts.ts";

// Issue #39: the contract for finding a conversation's workflow proposals.

const catalog = JSON.parse(
  await Deno.readTextFile("docs/technical-design/api-catalog.json"),
) as { actions: Array<Record<string, unknown>> };

const proposal = {
  id: "8f8b5e43-2c2f-4b4a-9a43-5d6f3c1b2a10",
  conversationId: "0b6c3c8e-7a1d-4f1e-8d2a-3c4b5a6d7e8f",
  turnId: "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
  workflowId: null,
  baseDraftVersion: null,
  name: "Weekly dependency update",
  definition: { kind: "fixed", steps: [] },
  digest: "a".repeat(64),
  state: "accepted",
  decidedBy: "2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a",
  decidedByName: "Ana",
  decidedAt: "2026-11-21T10:00:00.000Z",
  supersededByVersionId: null,
  createdAt: "2026-11-21T09:00:00.000Z",
  updatedAt: "2026-11-21T10:00:00.000Z",
  version: 2,
};

Deno.test("workflowDefinitionProposals.list reads a conversation's proposals as the conversation does", () => {
  const entry = catalog.actions.find((action) =>
    action.action === "workflowDefinitionProposals.list"
  );
  assert(entry, "workflowDefinitionProposals.list missing from the catalog");
  assertEquals(entry.method, "GET");
  assertEquals(
    entry.path,
    "/v1/conversations/{id}/workflow-definition-proposals",
  );
  assertEquals(entry.permission, "conversation:read");
  assertEquals(entry.input, "CursorQuery");
  assertEquals(entry.output, "Page<WorkflowDefinitionProposal>");
  assertEquals(entry.organizationContext, "required_authenticated_context");
});

Deno.test("a proposal page carries items and nextCursor, and each proposal names its decider", () => {
  const page = contractSchemas["Page<WorkflowDefinitionProposal>"].parse({
    items: [proposal, { ...proposal, decidedBy: null, decidedByName: null }],
    nextCursor: null,
  }) as { items: { decidedByName: string | null }[] };
  assertEquals(page.items[0].decidedByName, "Ana");
  assertEquals(page.items[1].decidedByName, null);
  assertThrows(() =>
    contractSchemas.WorkflowDefinitionProposal.parse({
      ...proposal,
      decidedByName: undefined,
    })
  );
  const schemas = JSON.parse(
    Deno.readTextFileSync("docs/technical-design/transport-schemas.json"),
  ) as {
    outputs: Record<string, { fieldDescriptions: Record<string, string> }>;
  };
  assert(
    (schemas.outputs.WorkflowDefinitionProposal.fieldDescriptions
      .decidedByName ?? "").length > 20,
    "decidedByName has a meaningful description",
  );
});

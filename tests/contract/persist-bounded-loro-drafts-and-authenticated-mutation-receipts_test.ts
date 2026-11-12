import { assert, assertEquals } from "@std/assert";
import {
  catalogActions,
  contractSchemas,
} from "../../packages/contracts/src/contracts.ts";
import {
  draftImplementedActions,
  implementedActions,
} from "../../packages/contracts/src/implemented-actions.ts";
import transport from "../../packages/contracts/generated/transport-schemas.ts";
import contracts from "../../packages/contracts/generated/contracts.json" with {
  type: "json",
};

const expected = [
  ["drafts.open", "POST", "/v1/artifacts/{id}/drafts", "bakery_drafts_open"],
  ["drafts.get", "GET", "/v1/drafts/{id}", "bakery_drafts_get"],
  [
    "draftCheckpoints.get",
    "GET",
    "/v1/drafts/{id}/checkpoints/{checkpointId}",
    "bakery_draftCheckpoints_get",
  ],
  ["draftSlices.get", "GET", "/v1/drafts/{id}/slice", "bakery_draftSlices_get"],
  ["drafts.edit", "POST", "/v1/drafts/{id}/edits", "bakery_drafts_edit"],
] as const;

Deno.test("generated REST and scoped MCP catalogs own the guarded draft actions", () => {
  for (const [name, method, path, mcp] of expected) {
    const action = catalogActions.find((candidate) =>
      candidate.action === name
    );
    assert(action);
    assertEquals(action.method, method);
    assertEquals(action.path, path);
    assertEquals(action.mcp, mcp);
    assertEquals(action.organizationContext, "required_authenticated_context");
    assertEquals(action.access, "Developer");
    assert(transport.mcp.defaultTools.includes(mcp));
    assert(implementedActions.includes(name));
    const generated = contracts.actions.find((candidate) =>
      candidate.action === name
    );
    assertEquals(generated?.implemented, true);
    assertEquals(generated?.mcp, mcp);
    assert(
      (contracts.openapi.paths as Record<string, unknown>)[path],
      `missing generated OpenAPI path ${path}`,
    );
  }
  assertEquals([...draftImplementedActions], expected.map(([name]) => name));
});

Deno.test("draft edit is strict text-only input with no caller authority or binary field", () => {
  const valid = {
    epoch: 1,
    sourceCheckpointId: crypto.randomUUID(),
    startCursor: "AA==",
    endCursor: "AA==",
    expectedText: "target",
    expectedDigest: "a".repeat(64),
    replacement: "replacement",
    mutationId: crypto.randomUUID(),
  };
  assert(contractSchemas.DraftEdit.safeParse(valid).success);
  for (
    const field of [
      "update",
      "bytes",
      "state",
      "actorId",
      "origin",
      "peerId",
      "organizationId",
      "artifactId",
      "taskId",
    ]
  ) {
    assertEquals(
      contractSchemas.DraftEdit.safeParse({ ...valid, [field]: "forged" })
        .success,
      false,
      `${field} crossed the strict public boundary`,
    );
  }
  // Binary Loro bytes never cross a REST or MCP action. The only
  // collaboration entry is the WebSocket upgrade, which has no MCP tool.
  assertEquals(
    catalogActions.some((action) =>
      action.action.toLowerCase().includes("binary")
    ),
    false,
  );
  const collaboration = catalogActions.filter((action) =>
    action.path.includes("collaboration")
  );
  assertEquals(
    collaboration.map(({ action, method, path, mcp }) => ({
      action,
      method,
      path,
      mcp,
    })),
    [{
      action: "collaboration.connect",
      method: "GET",
      path: "/v1/collaboration",
      mcp: null,
    }],
  );
});

Deno.test("readback schemas expose committed text and receipts but no Loro bytes", () => {
  const receipt = {
    mutationId: crypto.randomUUID(),
    draftId: crypto.randomUUID(),
    epoch: 1,
    serverSequence: "1",
    checkpointId: crypto.randomUUID(),
    actorId: crypto.randomUUID(),
    mutationDigest: "a".repeat(64),
    updateDigest: "b".repeat(64),
    textDigest: "c".repeat(64),
    committedAt: new Date().toISOString(),
  };
  const draft = {
    id: receipt.draftId,
    artifactId: crypto.randomUUID(),
    taskId: crypto.randomUUID(),
    epoch: 1,
    serverSequence: "1",
    checkpointId: receipt.checkpointId,
    textDigest: receipt.textDigest,
    text: "committed",
    receipts: [receipt],
  };
  assert(contractSchemas.Draft.safeParse(draft).success);
  assertEquals(
    contractSchemas.Draft.safeParse({ ...draft, state: "AA==" }).success,
    false,
  );
  assertEquals(
    contractSchemas.DraftMutationReceipt.safeParse({
      ...receipt,
      update: "AA==",
    }).success,
    false,
  );
});

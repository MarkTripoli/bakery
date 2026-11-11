import { assertEquals } from "@std/assert";
import {
  contractSchemas,
  generateContracts,
  toJsonSchema,
} from "../../packages/contracts/src/contracts.ts";

Deno.test("collection and sync inputs reject offset pagination controls", () => {
  // Given: schemas for row traversal and event synchronization.
  const cursorQuery = contractSchemas.CursorQuery;
  const syncQuery = contractSchemas.SyncQuery;

  // When: callers supply offset-style controls.
  const rowResult = cursorQuery.safeParse({ offset: 10, limit: 25 });
  const syncResult = syncQuery.safeParse({
    scopeType: "task",
    scopeId: "00000000-0000-4000-8000-000000000001",
    page: 2,
  });

  // Then: both strict boundary schemas reject them.
  assertEquals(rowResult.success, false);
  assertEquals(syncResult.success, false);
});

Deno.test("sync snapshot contract preserves opaque and decimal boundaries", () => {
  // Given: a coherent snapshot containing one safe event envelope.
  const value = {
    resourceState: { tasks: [] },
    highwater: "42",
    events: [{
      id: "00000000-0000-4000-8000-000000000001",
      sequence: "42",
      type: "tasks.updated",
      schemaVersion: 1,
      occurredAt: "2026-09-12T12:00:00.000Z",
      taskId: "00000000-0000-4000-8000-000000000002",
      repositoryId: null,
      conversationId: "00000000-0000-4000-8000-000000000003",
      workerHostId: null,
      workerEnrollmentId: null,
      payload: { resourceId: "00000000-0000-4000-8000-000000000002" },
    }],
    nextCursor: "opaque",
    resetRequired: false,
  };

  // When: the public output schema parses the value.
  const parsed = contractSchemas.SyncSnapshot.safeParse(value);

  // Then: decimal strings and opaque cursors remain wire-level values.
  assertEquals(parsed.success, true);
});

Deno.test("generated Problem reset metadata retains recovery semantics", () => {
  const generated = generateContracts();
  const problem = toJsonSchema(generated.schemas.Problem);
  const properties = problem.properties as Record<
    string,
    Record<string, unknown>
  >;

  assertEquals(
    properties.resetRequired.description,
    "Whether the client must discard its local state and request a fresh snapshot.",
  );
  assertEquals(
    properties.retainedFrom.description,
    "Earliest retained event sequence that can be used to establish a fresh sync position.",
  );
  assertEquals(
    properties.retryWithoutAfter.description,
    "Whether the client should retry the sync request without its after cursor.",
  );
});

import { assertEquals, assertRejects } from "@std/assert";
import {
  decodeCursor,
  encodeCursor,
} from "../../apps/server/src/platform/cursor.ts";
import { StandardError } from "../../packages/contracts/src/http.ts";

const principalId = "00000000-0000-4000-8000-000000000001";

Deno.test("row cursors reject normalized-filter reuse", async () => {
  // Given: a cursor issued for one normalized filter set.
  const cursor = await encodeCursor(
    "issue-33-unit-secret",
    {
      action: "tasks.list",
      principalId,
      organizationId: "00000000-0000-4000-8000-000000000002",
      ordering: "createdAt:desc,id:desc",
      filters: '{"repositoryId":"00000000-0000-4000-8000-000000000003"}',
      schemaVersion: 1,
    },
    {
      createdAt: "2026-09-12T12:00:00.000000Z",
      id: "00000000-0000-4000-8000-000000000004",
    },
  );

  // When: another filter context tries to continue that traversal.
  const error = await assertRejects(
    () =>
      decodeCursor("issue-33-unit-secret", cursor, {
        action: "tasks.list",
        principalId,
        organizationId: "00000000-0000-4000-8000-000000000002",
        ordering: "createdAt:desc,id:desc",
        filters: "{}",
        schemaVersion: 1,
      }),
    StandardError,
  );

  // Then: reuse fails closed instead of restarting or crossing filters.
  assertEquals(error.code, "INVALID_CURSOR");
});

Deno.test("row cursors preserve microsecond keyset positions", async () => {
  // Given: equal-millisecond rows distinguished by PostgreSQL microseconds and UUID.
  const binding = {
    action: "tasks.list",
    principalId,
    organizationId: "00000000-0000-4000-8000-000000000002",
    ordering: "createdAt:desc,id:desc",
    filters: "{}",
    schemaVersion: 1,
  };
  const position = {
    createdAt: "2026-09-12T12:00:00.123456Z",
    id: "00000000-0000-4000-8000-000000000004",
  };

  // When: the position is encoded and decoded.
  const decoded = await decodeCursor(
    "issue-33-unit-secret",
    await encodeCursor("issue-33-unit-secret", binding, position),
    binding,
  );

  // Then: the exact tuple survives.
  assertEquals(decoded, position);
});

Deno.test("row cursors reject cross-shape binding reuse", async () => {
  const timestampBinding = {
    action: "runs.list",
    principalId,
    organizationId: "00000000-0000-4000-8000-000000000002",
    ordering: "createdAt:desc,id:desc",
    filters: "{}",
    schemaVersion: 1,
  };
  const ordinalBinding = {
    action: "runSteps.list",
    principalId,
    organizationId: "00000000-0000-4000-8000-000000000002",
    ordering: "position:asc,iteration:asc,id:asc",
    filters: "{}",
    schemaVersion: 1,
  };
  const timestampCursor = await encodeCursor(
    "issue-36-shape-secret",
    timestampBinding,
    {
      createdAt: "2026-09-12T12:00:00.000000Z",
      id: "00000000-0000-4000-8000-000000000004",
    },
  );
  const ordinalCursor = await encodeCursor(
    "issue-36-shape-secret",
    ordinalBinding,
    {
      position: 0,
      iteration: 0,
      id: "00000000-0000-4000-8000-000000000004",
    },
  );

  for (
    const [cursor, binding] of [
      [timestampCursor, ordinalBinding],
      [ordinalCursor, timestampBinding],
    ] as const
  ) {
    const error = await assertRejects(
      () => decodeCursor("issue-36-shape-secret", cursor, binding),
      StandardError,
    );
    assertEquals(error.code, "INVALID_CURSOR");
  }
});

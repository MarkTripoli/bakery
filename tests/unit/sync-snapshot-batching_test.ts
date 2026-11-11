import { assertEquals, assertLessOrEqual } from "@std/assert";
import type { OrganizationId } from "../../packages/contracts/src/contracts.ts";
import type { PgTransactionClient } from "../../apps/server/src/platform/database.ts";
import type { TaskRow } from "../../apps/server/src/modules/work/postgres.ts";
import { resourceState } from "../../apps/server/src/modules/work/sync-snapshot.ts";

const organizationId = "00000000-0000-4000-8000-000000000001" as OrganizationId;

function taskRow(index: number): TaskRow & { cursorCreatedAt: string } {
  const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  const createdAt = new Date("2026-09-12T12:00:00.000Z");
  return {
    id,
    application_id: "00000000-0000-4000-8000-000000000002",
    repository_id: null,
    conversation_id: "00000000-0000-4000-8000-000000000003",
    parent_task_id: null,
    title: `Task ${index}`,
    description: "",
    task_type: "feature",
    status: "draft",
    priority: 50,
    created_by: "00000000-0000-4000-8000-000000000004",
    current_run_id: null,
    archived_at: null,
    created_at: createdAt,
    updated_at: createdAt,
    version: 1,
    repository_profile_id: null,
    repository_profile_revision: null,
    repository_profile_digest: null,
    observation_id: null,
    observation_digest: null,
    base_sha: null,
    approval_policy: null,
    planning_only: false,
    cursorCreatedAt: createdAt.toISOString(),
  };
}

Deno.test("snapshot reads many small tasks in bounded batches", async () => {
  const rows = Array.from({ length: 101 }, (_, index) => taskRow(101 - index));
  let queryCount = 0;
  const transaction = {
    query(_sql: string, values: unknown[] = []) {
      queryCount++;
      const cursorId = values.length === 4 ? String(values[3]) : undefined;
      const start = cursorId === undefined
        ? 0
        : rows.findIndex((row) => row.id === cursorId) + 1;
      const page = rows.slice(start, start + 100);
      return Promise.resolve({ rows: page, rowCount: page.length });
    },
  } as unknown as PgTransactionClient;

  const snapshot = await resourceState(
    transaction,
    organizationId,
    "00000000-0000-4000-8000-000000000002",
    "application_id",
  );

  assertEquals(snapshot.tasks.length, 101);
  assertLessOrEqual(queryCount, 3);
});

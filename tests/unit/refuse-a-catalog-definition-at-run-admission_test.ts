import { assertEquals, assertRejects } from "@std/assert";
import { StandardError } from "../../packages/contracts/src/http.ts";
import type { PgTransactionClient } from "../../packages/persistence/src/postgres.ts";
import { loadActiveWorkflowVersionId } from "../../apps/server/src/modules/work/run-command.ts";

// The lock on running a definition by id reads its origin, not its slug, so the
// slug is not the lock in either direction. The transaction is a stand-in that
// returns the one definition row the function reads.
function transactionReturning(row: {
  origin_kind: string;
  enabled: boolean;
  active_version_id: string | null;
}): PgTransactionClient {
  return {
    query: () => Promise.resolve({ rows: [row], rowCount: 1 }),
  } as unknown as PgTransactionClient;
}

async function reasonOf(row: Parameters<typeof transactionReturning>[0]) {
  const error = await assertRejects(
    () =>
      loadActiveWorkflowVersionId(
        transactionReturning(row),
        crypto.randomUUID(),
        crypto.randomUUID(),
      ),
    StandardError,
  );
  return (error as StandardError).params?.reason;
}

Deno.test("a catalog definition is refused at run admission, whatever its slug", async () => {
  assertEquals(
    await reasonOf({
      origin_kind: "catalog",
      enabled: true,
      active_version_id: crypto.randomUUID(),
    }),
    "workflow_locked",
  );
});

Deno.test("an authored or copied definition is not locked, even under a preset: slug", async () => {
  // The lock does not fire for these, so the next check - no active version -
  // is the one that answers. The slug is deliberately not in the row: it is no
  // longer read.
  for (const origin_kind of ["authored", "copy"]) {
    assertEquals(
      await reasonOf({ origin_kind, enabled: true, active_version_id: null }),
      "workflow_not_active",
    );
  }
  const active = crypto.randomUUID();
  assertEquals(
    await loadActiveWorkflowVersionId(
      transactionReturning({
        origin_kind: "authored",
        enabled: true,
        active_version_id: active,
      }),
      crypto.randomUUID(),
      crypto.randomUUID(),
    ),
    active,
  );
});

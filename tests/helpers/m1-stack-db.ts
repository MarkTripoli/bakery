import { readDatabaseConfig } from "../../packages/config/src/env.ts";
import {
  closePgDatabase,
  openPgDatabase,
  type PgDatabase,
  withPgTransaction,
} from "../../apps/server/src/platform/database.ts";
import {
  COORDINATOR_TURN_MODELS_SQL,
  FORCE_APPROVAL_EXPIRY_SQL,
  SETTLED_SPEND_SQL,
  STORED_QUESTION_STATUS_SQL,
} from "../../apps/web/tests/helpers/m1-stack-env.ts";

/**
 * Owner-database helper for `apps/web/tests/helpers/m1-stack-control.ts`, the
 * stack controls of the M1 journey proof. Playwright runs on Node
 * and the repo's database code is Deno, so the controls shell out here the way
 * `apps/web/tests/helpers/real-run-observation.ts` shells out to
 * `web-run-artifact-seed.ts`. Config is the stack's owner `DATABASE_URL`.
 *
 * Subcommands (one JSON line on stdout; secrets never printed):
 * - `spend`: settled installation spend, read only.
 * - `status <questionId>`: the status the sweep stored, read only. An API read
 *   returns the effective (read-through) status, which proves nothing about
 *   the sweep.
 * - `coordinator-models <conversationId>`: the model each coordinator turn
 *   of the conversation ran on, read only (`COORDINATOR_TURN_MODELS_SQL`).
 * - `expire <approvalId>`: operator step 3, the only write this helper can
 *   perform. It runs `FORCE_APPROVAL_EXPIRY_SQL` in one transaction and rolls
 *   back unless exactly one row changed.
 *
 * Every result carries the SQL text that ran and the row count.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireId(value: string): string {
  if (!UUID.test(value)) {
    throw new Error("M1_STACK_DB_ID_INVALID");
  }
  return value;
}

/** Runs one select inside a transaction that cannot write. */
async function readOnly<Row extends Record<string, unknown>>(
  database: PgDatabase,
  sql: string,
  parameters: readonly unknown[],
) {
  return await withPgTransaction(database, async (transaction) => {
    await transaction.query("set transaction read only");
    return await transaction.query<Row>(sql, [...parameters]);
  });
}

export async function settledSpend(database: PgDatabase) {
  const result = await readOnly<{ total: string }>(
    database,
    SETTLED_SPEND_SQL,
    [],
  );
  return {
    sql: SETTLED_SPEND_SQL,
    rowCount: result.rowCount,
    totalUsd: result.rows[0]?.total ?? null,
  };
}

export async function storedStatus(database: PgDatabase, questionId: string) {
  const result = await readOnly<{ status: string }>(
    database,
    STORED_QUESTION_STATUS_SQL,
    [requireId(questionId)],
  );
  if (result.rowCount !== 1) {
    throw new Error(`M1_STORED_STATUS_ROW_COUNT:${result.rowCount}`);
  }
  return {
    sql: STORED_QUESTION_STATUS_SQL,
    rowCount: result.rowCount,
    status: result.rows[0].status,
  };
}

export async function coordinatorModels(
  database: PgDatabase,
  conversationId: string,
) {
  const result = await readOnly<{
    turnId: string;
    attemptStatus: string;
    model: string | null;
    claudeCodeVersion: string | null;
  }>(
    database,
    COORDINATOR_TURN_MODELS_SQL,
    [requireId(conversationId)],
  );
  return {
    sql: COORDINATOR_TURN_MODELS_SQL,
    rowCount: result.rowCount,
    rows: result.rows,
  };
}

export async function forceApprovalExpiry(
  database: PgDatabase,
  approvalId: string,
) {
  const id = requireId(approvalId);
  const rowCount = await withPgTransaction(database, async (transaction) => {
    const result = await transaction.query(FORCE_APPROVAL_EXPIRY_SQL, [id]);
    // Roll back (throwing here does) unless exactly the one approval changed.
    if (result.rowCount !== 1) {
      throw new Error(`M1_APPROVAL_EXPIRY_ROW_COUNT:${result.rowCount}`);
    }
    return result.rowCount;
  });
  return { sql: FORCE_APPROVAL_EXPIRY_SQL, approvalId: id, rowCount };
}

if (import.meta.main) {
  const [command, argument] = Deno.args;
  const database = openPgDatabase(
    readDatabaseConfig(Deno.env.toObject(), "owner").url,
  );
  try {
    const result = command === "spend"
      ? await settledSpend(database)
      : command === "status"
      ? await storedStatus(database, argument ?? "")
      : command === "coordinator-models"
      ? await coordinatorModels(database, argument ?? "")
      : command === "expire"
      ? await forceApprovalExpiry(database, argument ?? "")
      : null;
    if (result === null) {
      console.error(
        "m1-stack-db: usage: spend | status <questionId> | coordinator-models <conversationId> | expire <approvalId>",
      );
      Deno.exit(2);
    }
    console.log(JSON.stringify(result));
  } finally {
    await closePgDatabase(database);
  }
}

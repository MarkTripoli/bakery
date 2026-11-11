import type { OrganizationId } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import type { PgTransactionClient } from "../../platform/database.ts";
import { TASK_COLUMNS, type TaskRow, toTask } from "./postgres.ts";

const RESOURCE_STATE_MAX_BYTES = 524_288;
const SNAPSHOT_TASK_BATCH_SIZE = 100;
const JSON_TASKS_PREFIX = '{"tasks":[';
const JSON_TASKS_SUFFIX = "]}";
const textEncoder = new TextEncoder();
const JSON_TASKS_PREFIX_BYTES =
  textEncoder.encode(JSON_TASKS_PREFIX).byteLength;
const JSON_TASKS_SUFFIX_BYTES =
  textEncoder.encode(JSON_TASKS_SUFFIX).byteLength;

export async function resourceState(
  transaction: PgTransactionClient,
  organizationId: OrganizationId,
  scopeId: string,
  taskColumn: string,
): Promise<{ tasks: ReturnType<typeof toTask>[] }> {
  const tasks: ReturnType<typeof toTask>[] = [];
  let serializedBytes = JSON_TASKS_PREFIX_BYTES + JSON_TASKS_SUFFIX_BYTES;
  let last: { createdAt: string; id: string } | undefined;

  while (true) {
    const result = await transaction.query<
      TaskRow & { cursorCreatedAt: string }
    >(
      `select ${TASK_COLUMNS},
          to_char(created_at at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "cursorCreatedAt"
       from bakery.tasks
       where organization_id = $1
         and ${taskColumn} = $2
          ${
        last
          ? "and (created_at < $3::timestamptz or (created_at = $3::timestamptz and id < $4))"
          : ""
      }
       order by created_at desc, id desc
       limit ${SNAPSHOT_TASK_BATCH_SIZE}`,
      last
        ? [organizationId, scopeId, last.createdAt, last.id]
        : [organizationId, scopeId],
    );
    if (result.rows.length === 0) break;

    for (const row of result.rows) {
      const task = toTask(row);
      const serialized = JSON.stringify(task);
      const candidateBytes = serializedBytes +
        (tasks.length === 0 ? 0 : 1) +
        textEncoder.encode(serialized).byteLength;
      if (candidateBytes > RESOURCE_STATE_MAX_BYTES) {
        throw new StandardError({
          code: "SNAPSHOT_SCOPE_TOO_LARGE",
          params: { refineScope: { scopeType: "task" } },
        });
      }
      tasks.push(task);
      serializedBytes = candidateBytes;
      last = { createdAt: row.cursorCreatedAt, id: row.id };
    }
  }

  return { tasks };
}

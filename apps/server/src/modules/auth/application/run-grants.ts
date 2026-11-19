import type { CatalogActionName } from "@bakery/contracts/contracts";
import type { PgTransactionClient } from "../../../platform/database.ts";

/**
 * Run-scoped access (issue #456, migration 0247).
 *
 * A person who is a member of the organization but has no standing access to a
 * run can be given the right to see that one run. This is observe only, and it
 * reaches exactly the actions below, each named for the one kind of id it
 * takes. Every other action stays closed to a grant-holder, whatever grants
 * they hold: the gate asks about this table only for the actions listed here.
 *
 * A grant never replaces the role check; it is consulted after the role and the
 * resource bindings have both refused. Every lookup carries organization_id.
 */
export const RUN_GRANT_ACTIONS: Readonly<
  Partial<Record<CatalogActionName, "run" | "task">>
> = Object.freeze({
  // `:id` is the run.
  "runs.get": "run",
  "runSteps.list": "run",
  // `:id` is a task; a grant on any run of that task reads the task.
  "tasks.get": "task",
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether the person holds a live grant on this run, or on a run of this task. */
export async function hasLiveRunGrant(
  transaction: Pick<PgTransactionClient, "query">,
  organizationId: string,
  principalId: string,
  kind: "run" | "task",
  id: string | undefined,
): Promise<boolean> {
  // A malformed id is no grant, not a database error.
  if (id === undefined || !UUID.test(id)) return false;
  const found = await transaction.query(
    `select 1 from bakery.run_access_grants
      where organization_id = $1 and principal_id = $2
        and ${kind === "run" ? "run_id" : "task_id"} = $3::uuid
        and revoked_at is null
      limit 1`,
    [organizationId, principalId, id],
  );
  return found.rows.length > 0;
}

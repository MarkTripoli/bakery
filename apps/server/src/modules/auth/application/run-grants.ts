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

/**
 * Whether the person holds a live grant on this run, or on a run of this task.
 * The row is read `for share`, so a concurrent revoke is ordered before or
 * after this request rather than interleaved with it (the same as the
 * conversation grant).
 */
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
      limit 1
      for share`,
    [organizationId, principalId, id],
  );
  return found.rows.length > 0;
}

/**
 * The one things a person can be given the right to do on a run (#456 slice 2a),
 * each on exactly one row. The vocabulary is closed and lives here, not in the
 * database.
 */
export type RunPower = "approve" | "answer";

/**
 * The actions a power reaches, each with the power it needs. `:id` is the
 * question row in every one of them: an approval is a question of kind
 * approval. The power grant is looked up by person, power and exactly that id,
 * so it reaches no other row, run or organization. Anything not listed here
 * stays closed to a grant-holder, whatever grants they hold; approvals.revoke
 * in particular is not a power.
 */
export const RUN_POWER_ACTIONS: Readonly<
  Partial<Record<CatalogActionName, RunPower>>
> = Object.freeze({
  "approvals.get": "approve",
  "approvals.decide": "approve",
  "questions.get": "answer",
  "questions.answer": "answer",
});

/**
 * Whether the person holds a live, unexpired power on this one row. Read
 * `for share`, so a concurrent revoke is ordered before or after the request,
 * never in the middle; every lookup carries organization_id.
 */
export async function hasLivePowerGrant(
  transaction: Pick<PgTransactionClient, "query">,
  organizationId: string,
  principalId: string,
  power: RunPower,
  targetId: string | undefined,
): Promise<boolean> {
  // A malformed id is no grant, not a database error.
  if (targetId === undefined || !UUID.test(targetId)) return false;
  const found = await transaction.query(
    `select 1 from bakery.run_power_grants
      where organization_id = $1 and principal_id = $2 and power = $3
        and target_id = $4::uuid and revoked_at is null and expires_at > now()
      limit 1
      for share`,
    [organizationId, principalId, power, targetId],
  );
  return found.rows.length > 0;
}

/**
 * Whether the person may act on a question row that names an audience: they are
 * one of the named people, or they hold the power on exactly this row. The
 * grant replaces the audience check for that one row; it does not widen
 * anything else.
 */
export async function mayActOnQuestion(
  transaction: Pick<PgTransactionClient, "query">,
  organizationId: string,
  principalId: string,
  row: {
    id: string;
    audience: { type: string; principalIds?: readonly string[] };
  },
  power: RunPower,
): Promise<boolean> {
  if (row.audience.type !== "principals") return true;
  if ((row.audience.principalIds ?? []).includes(principalId)) return true;
  return await hasLivePowerGrant(
    transaction,
    organizationId,
    principalId,
    power,
    row.id,
  );
}

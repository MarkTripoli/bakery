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
/** What the `:id` of an observe action is, and so how a grant is matched to it. */
export type RunGrantKind = "run" | "task" | "artifactVersion";

export const RUN_GRANT_ACTIONS: Readonly<
  Partial<Record<CatalogActionName, RunGrantKind>>
> = Object.freeze({
  // `:id` is the run.
  "runs.get": "run",
  "runSteps.list": "run",
  // The run's delivery evidence (#456 slice 2a): what its checks, reviews and
  // decisions say. Each is keyed by the run and reads nothing outside it.
  "checks.list": "run",
  "runReviews.list": "run",
  "runDeliveryDecisions.list": "run",
  "runRepairTries.list": "run",
  // `:id` is a task; a grant on any run of that task reads the task.
  "tasks.get": "task",
  // `:id` is an artifact version; only one a step of the granted run produced.
  "artifactVersions.content": "artifactVersion",
  "artifactComments.list": "artifactVersion",
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
  kind: RunGrantKind,
  id: string | undefined,
): Promise<boolean> {
  // A malformed id is no grant, not a database error.
  if (id === undefined || !UUID.test(id)) return false;
  const found = kind === "artifactVersion"
    // The version has to have been produced by a step of the granted run: a
    // version of the same artifact from another run is not this run's to see.
    ? await transaction.query(
      `select 1 from bakery.run_access_grants grant_row
         join bakery.run_steps step
           on step.organization_id = grant_row.organization_id
          and step.run_id = grant_row.run_id
         join bakery.artifact_versions version
           on version.organization_id = step.organization_id
          and version.run_step_id = step.id
        where grant_row.organization_id = $1 and grant_row.principal_id = $2
          and version.id = $3::uuid and grant_row.revoked_at is null
        limit 1
        for share of grant_row`,
      [organizationId, principalId, id],
    )
    : await transaction.query(
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
        and question_id = $4::uuid and revoked_at is null
        and expires_at > now()
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

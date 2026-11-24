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
export type RunGrantKind =
  | "run"
  | "task"
  | "artifactVersion"
  | "session"
  | "outputStream";

export const RUN_GRANT_ACTIONS: Readonly<
  Partial<Record<CatalogActionName, RunGrantKind>>
> = Object.freeze({
  // `:id` is the run.
  "runs.get": "run",
  "runSteps.list": "run",
  "runSteps.given": "run",
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
  "sessions.feed": "session",
  "outputStreams.transcript": "outputStream",
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
  const found = kind === "outputStream"
    ? await transaction.query(
      `select 1 from bakery.run_access_grants grant_row
         join bakery.run_steps step
           on step.organization_id = grant_row.organization_id
          and step.run_id = grant_row.run_id
         join bakery.jobs job
           on job.organization_id = step.organization_id
          and job.run_step_id = step.id
         join bakery.session_output_streams stream
           on stream.organization_id = job.organization_id
          and stream.job_id = job.id
        where grant_row.organization_id = $1 and grant_row.principal_id = $2
          and stream.id = $3::uuid and grant_row.revoked_at is null
        limit 1
        for share of grant_row`,
      [organizationId, principalId, id],
    )
    : kind === "session"
    ? await transaction.query(
      `select 1 from bakery.run_access_grants grant_row
         join bakery.run_steps step
           on step.organization_id = grant_row.organization_id
          and step.run_id = grant_row.run_id
         join bakery.agent_sessions session
           on session.organization_id = step.organization_id
          and session.run_step_id = step.id
        where grant_row.organization_id = $1 and grant_row.principal_id = $2
          and session.id = $3::uuid and grant_row.revoked_at is null
        limit 1
        for share of grant_row`,
      [organizationId, principalId, id],
    )
    : kind === "artifactVersion"
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

export type RunPower = "approve" | "answer" | "review" | "take_over";

export type PowerTarget = "question" | "artifactVersion" | "session" | "step";

export type PowerTargetRef =
  | Readonly<
    { kind: "question" | "artifactVersion" | "session"; id: string | undefined }
  >
  | Readonly<
    { kind: "step"; runId: string | undefined; stepKey: string | undefined }
  >;

export const RUN_POWER_ACTIONS: Readonly<
  Partial<Record<CatalogActionName, { power: RunPower; target: PowerTarget }>>
> = Object.freeze({
  "approvals.get": { power: "approve", target: "question" },
  "approvals.decide": { power: "approve", target: "question" },
  "questions.get": { power: "answer", target: "question" },
  "questions.answer": { power: "answer", target: "question" },
  "artifactComments.create": { power: "review", target: "artifactVersion" },
  "sessions.steer": { power: "take_over", target: "session" },
  "runSteps.note": { power: "take_over", target: "step" },
  "runSteps.takeOver": { power: "take_over", target: "step" },
});

export async function hasLivePowerGrant(
  transaction: Pick<PgTransactionClient, "query">,
  organizationId: string,
  principalId: string,
  power: RunPower,
  target: PowerTargetRef,
): Promise<boolean> {
  const live = `grant_row.organization_id = $1 and grant_row.principal_id = $2
    and grant_row.power = $3 and grant_row.revoked_at is null
    and grant_row.expires_at > now()`;
  const base = [organizationId, principalId, power];
  let found;
  if (target.kind === "step") {
    if (
      target.runId === undefined || !UUID.test(target.runId) ||
      target.stepKey === undefined
    ) return false;
    found = await transaction.query(
      `select 1 from bakery.run_power_grants grant_row
         join bakery.run_steps step
           on step.organization_id = grant_row.organization_id
          and step.id = grant_row.run_step_id
        where ${live} and step.run_id = $4::uuid and step.step_key = $5
        limit 1
        for share of grant_row`,
      [...base, target.runId, target.stepKey],
    );
  } else {
    if (target.id === undefined || !UUID.test(target.id)) return false;
    if (target.kind === "session") {
      found = await transaction.query(
        `select 1 from bakery.run_power_grants grant_row
           join bakery.agent_sessions session
             on session.organization_id = grant_row.organization_id
            and session.run_step_id = grant_row.run_step_id
          where ${live} and session.id = $4::uuid
          limit 1
          for share of grant_row`,
        [...base, target.id],
      );
    } else {
      const column = target.kind === "question"
        ? "question_id"
        : "artifact_version_id";
      found = await transaction.query(
        `select 1 from bakery.run_power_grants grant_row
          where ${live} and grant_row.${column} = $4::uuid
          limit 1
          for share`,
        [...base, target.id],
      );
    }
  }
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
    { kind: "question", id: row.id },
  );
}

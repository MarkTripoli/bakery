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
  // `:id` is a session; only one of a step of the granted run. The feed is
  // narrowed to the session's own messages for a person with no standing
  // access (see session-feed.ts), so it never shows the whole conversation.
  "sessions.feed": "session",
  // `:id` is an output stream; only one a step of the granted run wrote. It
  // answers the published transcript's segment references, never the chat.
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
    // The stream has to belong to the job of a step of the granted run.
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
    // The session has to belong to a step of the granted run.
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

/**
 * The one things a person can be given the right to do on a run (#456 slices 2a
 * and 2b), each on exactly one row. The vocabulary is closed and lives here, not
 * in the database.
 */
export type RunPower = "approve" | "answer" | "review" | "take_over";

/**
 * What an action's path says the grant is about, and so how the grant is
 * matched. A question (an approval is one), an artifact version, a session, or
 * a step named by its run and step key.
 */
export type PowerTarget = "question" | "artifactVersion" | "session" | "step";

/** The id or ids an action named, resolved from its path. */
export type PowerTargetRef =
  | Readonly<
    { kind: "question" | "artifactVersion" | "session"; id: string | undefined }
  >
  | Readonly<
    { kind: "step"; runId: string | undefined; stepKey: string | undefined }
  >;

/**
 * The actions a power reaches, each with the power it needs and what its path
 * names. The power grant is looked up by person, power and exactly that target,
 * so it reaches no other row, run or organization. Anything not listed here
 * stays closed to a grant-holder, whatever grants they hold; approvals.revoke
 * in particular is not a power.
 */
export const RUN_POWER_ACTIONS: Readonly<
  Partial<Record<CatalogActionName, { power: RunPower; target: PowerTarget }>>
> = Object.freeze({
  "approvals.get": { power: "approve", target: "question" },
  "approvals.decide": { power: "approve", target: "question" },
  "questions.get": { power: "answer", target: "question" },
  "questions.answer": { power: "answer", target: "question" },
  // A comment on one artifact version the run produced.
  "artifactComments.create": { power: "review", target: "artifactVersion" },
  // Steer the one session of the granted step, and take that step over.
  "sessions.steer": { power: "take_over", target: "session" },
  "runSteps.note": { power: "take_over", target: "step" },
  "runSteps.takeOver": { power: "take_over", target: "step" },
});

/**
 * Whether the person holds a live, unexpired power on this one target. Read
 * `for share`, so a concurrent revoke is ordered before or after the request,
 * never in the middle; every lookup carries organization_id. A step is matched
 * by its run and step key, so the right covers every iteration of that step and
 * nothing else.
 */
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
    // A malformed id is no grant, not a database error.
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

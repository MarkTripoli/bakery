import type { PgTransactionClient } from "@bakery/persistence";
import { assignedAgentSessionSql } from "@bakery/persistence/claims";

/**
 * What a stored file version records about the agent step that produced it
 * (#448 S8a, O50): the run, step, attempt and agent session the write came
 * from and the person the run acts for. It is read once, at the write, from the
 * attempt that made the call, and stored on the version; a version read never
 * looks it up again, so a later session of the same step never becomes the
 * maker of a version an earlier one wrote.
 */
export type VersionProvenance = Readonly<{
  runId: string | null;
  runStepId: string | null;
  attemptId: string;
  agentSessionId: string | null;
  actingForPrincipalId: string | null;
}>;

/**
 * The provenance of a version an attempt is writing now, or null when the
 * attempt is not in this organization (nothing is recorded then).
 *
 * The session is the one the attempt's claim handed it (the assignment's
 * `agentSessionId`, see `assignedAgentSessionSql`): the step's admission
 * session, never a later session opened on the same step. A step with no
 * session records none (null), with its attempt still named. A caller that
 * already knows the session (the storage write names it in its audit row)
 * passes it, and so the version and its audit row cannot disagree. The person
 * the run acts for is the principal of the attempt's session credential, else
 * the run's requester; a caller writing with a person's access passes that
 * person.
 */
export async function attemptVersionProvenance(
  tx: Pick<PgTransactionClient, "query">,
  organizationId: string,
  attemptId: string,
  known: Readonly<{
    agentSessionId?: string | null;
    actingForPrincipalId?: string;
  }> = {},
): Promise<VersionProvenance | null> {
  const found = await tx.query<{
    run_id: string | null;
    run_step_id: string | null;
    agent_session_id: string | null;
    acting_for_principal_id: string | null;
  }>(
    `select step.run_id, job.run_step_id,
            ${assignedAgentSessionSql("job")} as agent_session_id,
            coalesce((select credential.acts_for_principal_id
                        from bakery.session_operation_credentials credential
                       where credential.organization_id = attempt.organization_id
                         and credential.attempt_id = attempt.id
                       order by credential.created_at desc, credential.id desc
                       limit 1), run.requested_by) as acting_for_principal_id
       from bakery.job_attempts attempt
       join bakery.jobs job
         on job.organization_id = attempt.organization_id
        and job.id = attempt.job_id
       left join bakery.run_steps step
         on step.organization_id = job.organization_id
        and step.id = job.run_step_id
       left join bakery.workflow_runs run
         on run.organization_id = step.organization_id
        and run.id = step.run_id
      where attempt.organization_id = $1 and attempt.id = $2`,
    [organizationId, attemptId],
  );
  const row = found.rows[0];
  if (row === undefined) return null;
  return {
    runId: row.run_id,
    runStepId: row.run_step_id,
    attemptId,
    agentSessionId: known.agentSessionId !== undefined
      ? known.agentSessionId
      : row.agent_session_id,
    actingForPrincipalId: known.actingForPrincipalId ??
      row.acting_for_principal_id,
  };
}

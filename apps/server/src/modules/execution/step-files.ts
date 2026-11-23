/**
 * The files section a claimed attempt's step runs with (chapter 25 section
 * 17.6, O44, O45, issue #448). The section is authored on the step, carried
 * into the compiled plan the run snapshot froze, and read here at claim so
 * the session credential is minted with exactly the scopes it grants.
 */

import {
  boundStepConnections,
  buildWorkflowPlan,
  DEFAULT_STEP_FILES,
  OMITTED_STEP_FILES_WRITE,
  parseStepKey,
  resolveStepFiles,
  type WorkflowFileReadArea,
  type WorkflowFileWriteArea,
  WorkflowSemanticDocumentSchema,
  WorkflowStepKeyError,
} from "@bakery/contracts/workflow-compiler";
import {
  carriesPlanRuntime,
  type PgTransactionClient,
} from "@bakery/persistence";

export type ResolvedStepFiles = Readonly<{
  read: readonly WorkflowFileReadArea[];
  write: readonly WorkflowFileWriteArea[];
  /**
   * The storage connections the step binds (O44, #452): the only ones its
   * agent reads under /connections. Empty means /connections stays closed
   * without a person's grant, and then `read` never names it.
   */
  connections: readonly string[];
}>;

/**
 * What a claim mints for a step that declared no files section. O44 and O45
 * describe the defaults a definition may narrow; minting them as session
 * scopes would hand every agent storage writes nobody granted. So a step with
 * no section reads the tree areas O44 names, writes only its own outputs and
 * workspace, and reaches the storage write tools only through a declared
 * section or a person's grant (#448). /connections is left out: O44 opens
 * only the connections a definition binds, and a step with no section binds
 * none.
 */
export const UNDECLARED_STEP_FILES: ResolvedStepFiles = Object.freeze({
  read: Object.freeze(
    DEFAULT_STEP_FILES.read.filter((area) => area !== "connections"),
  ),
  write: OMITTED_STEP_FILES_WRITE,
  connections: Object.freeze([]),
});

/**
 * The narrowest section: pinned inputs and declared outputs only. Used where
 * the step cannot be found in a plan that should name it, because a guess
 * would hand the session areas nobody declared.
 */
export const INPUTS_ONLY_STEP_FILES: ResolvedStepFiles = Object.freeze({
  read: Object.freeze(["inputs"] as const),
  write: Object.freeze(["outputs"] as const),
  connections: Object.freeze([]),
});

/**
 * The resolved files section of the step a run snapshot's plan declares
 * under this key. A run admitted before plans existed, or a step with no
 * section, gets {@link UNDECLARED_STEP_FILES}; a plan run whose
 * document or step cannot be read gets the inputs-only section, never the
 * defaults.
 */
export function stepFilesFromSnapshot(
  snapshot: unknown,
  stepKey: string,
): ResolvedStepFiles {
  if (!carriesPlanRuntime(snapshot)) return UNDECLARED_STEP_FILES;
  const runtime = (snapshot as { runtime?: { document?: unknown } }).runtime;
  const document = WorkflowSemanticDocumentSchema.safeParse(runtime?.document);
  if (!document.success) return INPUTS_ONLY_STEP_FILES;
  let qualifiedId: string;
  try {
    qualifiedId = parseStepKey(stepKey).qualifiedId;
  } catch (error) {
    if (error instanceof WorkflowStepKeyError) return INPUTS_ONLY_STEP_FILES;
    throw error;
  }
  const step = buildWorkflowPlan(document.data).steps.find((candidate) =>
    candidate.qualifiedId === qualifiedId
  );
  if (!step) return INPUTS_ONLY_STEP_FILES;
  if (step.files === undefined) return UNDECLARED_STEP_FILES;
  const resolved = resolveStepFiles(step.files);
  const connections = boundStepConnections(step.files);
  return {
    // /connections opens only for the connections the step binds (O44): a
    // section that names the area and binds none reads no connection.
    read: connections.length > 0
      ? resolved.read
      : resolved.read.filter((area) => area !== "connections"),
    write: resolved.write,
    connections,
  };
}

/**
 * The files section for an attempt, read in the claim transaction. An attempt
 * whose job belongs to no run step (a coordinator turn) has no tree to reach
 * and gets the inputs-only section.
 */
export async function stepFilesForAttempt(
  tx: Pick<PgTransactionClient, "query">,
  organizationId: string,
  attemptId: string,
): Promise<ResolvedStepFiles> {
  const found = await tx.query<{ step_key: string; snapshot: unknown }>(
    `select step.step_key, run.snapshot
       from bakery.job_attempts as attempt
       join bakery.jobs as job
         on job.organization_id = attempt.organization_id
        and job.id = attempt.job_id
       join bakery.run_steps as step
         on step.organization_id = job.organization_id
        and step.id = job.run_step_id
       join bakery.workflow_runs as run
         on run.organization_id = step.organization_id
        and run.id = step.run_id
      where attempt.organization_id = $1 and attempt.id = $2`,
    [organizationId, attemptId],
  );
  const row = found.rows[0];
  if (!row) return INPUTS_ONLY_STEP_FILES;
  return stepFilesFromSnapshot(row.snapshot, row.step_key);
}

import type { PgTransactionClient } from "../../platform/database.ts";

/**
 * Whether anyone steered a reviewer (chapter 25 section 9, O18, issue #413).
 *
 * Every steer, a person's or an agent's, is recorded in the decisions ledger
 * before it is delivered, so the ledger is the one place to ask. A steer reaches
 * a reviewer three ways, and each is matched: a steer of its session, a steer of
 * its step once the step row exists, and a note left for its step before it
 * started (which names the run and carries the step key). Pausing, cancelling
 * and answering its questions write no steer entry, so they never mark a review
 * steered and stay available at any time.
 */
export async function reviewerWasSteered(
  transaction: PgTransactionClient,
  input: Readonly<{
    organizationId: string;
    runId: string;
    reviewStepId: string;
    reviewerSessionId: string;
  }>,
): Promise<boolean> {
  const found = await transaction.query(
    `select 1
       from bakery.decisions_ledger as entry
      where entry.organization_id = $1 and entry.run_id = $2
        and entry.kind = 'steer'
        and (
          (entry.subject_kind = 'session' and entry.subject_id = $4::uuid)
          or (entry.subject_kind = 'step' and entry.subject_id = $3::uuid)
          or (entry.subject_kind = 'run'
              and entry.detail ->> 'stepKey' = (
                select step.step_key from bakery.run_steps as step
                 where step.organization_id = $1 and step.id = $3::uuid))
        )
      limit 1`,
    [
      input.organizationId,
      input.runId,
      input.reviewStepId,
      input.reviewerSessionId,
    ],
  );
  return found.rows.length > 0;
}

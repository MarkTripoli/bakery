import { appendAudit, appendDomainEvent } from "@bakery/persistence";
import type { PgTransactionClient } from "../../platform/database.ts";

/** The states a definition proposal moves through (#420, #421). */
export const DefinitionProposalState = Object.freeze(
  {
    Waiting: "waiting",
    Accepted: "accepted",
    Rejected: "rejected",
    Superseded: "superseded",
  } as const,
);

/**
 * Settles every proposal still waiting on a draft that is being published.
 *
 * Publishing turns the draft row into the immutable version and deletes the
 * draft, so a proposal made against that draft can never be accepted: its
 * base draft no longer exists. Leaving it waiting would make it wait forever;
 * deleting it would make it vanish. Inside the publish transaction it is
 * settled instead (issue #421, plan item 4.14): state superseded, naming the
 * published version, with one audit row and one domain event per proposal.
 * Proposals made when there was no draft (base_draft_version null) are not on
 * the deleted draft and stay waiting. The rows are locked in id order after
 * the definition and the draft, the same order a decision takes, so publish
 * and decide never deadlock.
 */
export async function supersedeWaitingProposals(
  transaction: PgTransactionClient,
  facts: Readonly<{
    organizationId: string;
    workflowId: string;
    versionId: string;
    principalId: string;
    requestId: string;
    traceId: string;
  }>,
): Promise<readonly string[]> {
  const waiting = await transaction.query<{ id: string }>(
    `select id from bakery.workflow_definition_proposals
      where organization_id = $1 and workflow_id = $2 and state = $3
        and base_draft_version is not null
      order by id
      for update`,
    [facts.organizationId, facts.workflowId, DefinitionProposalState.Waiting],
  );
  const settled: string[] = [];
  for (const { id } of waiting.rows) {
    const row = (await transaction.query<
      { id: string; version: number; conversation_id: string }
    >(
      `update bakery.workflow_definition_proposals
          set state = $4, superseded_by_version_id = $3,
              decided_at = now(), updated_at = now(), version = version + 1
        where organization_id = $1 and id = $2 and state = $5
        returning id, version, conversation_id`,
      [
        facts.organizationId,
        id,
        facts.versionId,
        DefinitionProposalState.Superseded,
        DefinitionProposalState.Waiting,
      ],
    )).rows[0];
    if (!row) throw new Error("DEFINITION_PROPOSAL_SUPERSEDE_FAILED");
    await appendAudit(transaction, {
      organizationId: facts.organizationId,
      principalId: facts.principalId,
      operation: "workflowDefinitionProposals.supersede",
      resourceType: "workflow_definition_proposal",
      resourceId: row.id,
      requestId: facts.requestId,
      traceId: facts.traceId,
      details: {
        workflowId: facts.workflowId,
        supersededByVersionId: facts.versionId,
      },
    });
    await appendDomainEvent(transaction, {
      organizationId: facts.organizationId,
      conversationId: row.conversation_id,
      eventType: "workflowDefinitionProposal.superseded",
      aggregateId: row.id,
      aggregateVersion: row.version,
      payload: { resourceId: row.id, resourceVersion: row.version },
      traceId: facts.traceId,
    });
    settled.push(row.id);
  }
  return settled;
}

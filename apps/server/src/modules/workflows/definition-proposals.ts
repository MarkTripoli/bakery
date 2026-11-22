import type { ActionContext } from "@bakery/contracts/action-registry";
import type { JsonValue } from "@bakery/contracts/contracts";
import type { CoordinatorEffect } from "@bakery/contracts/coordinator-turn";
import { requireCommandMetadata, StandardError } from "@bakery/contracts/http";
import { appendAudit, appendDomainEvent } from "@bakery/persistence";
import type { PgTransactionClient } from "../../platform/database.ts";
import { canonicalJson, sha256Hex } from "../../platform/canonical-json.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import {
  type CursorBinding,
  decodeCursor,
  encodeCursor,
} from "../../platform/cursor.ts";
import { lockConversationScope } from "../conversation/postgres.ts";
import { MAX_WORKFLOW_DEFINITION_BYTES } from "./validation.ts";
import { DefinitionProposalState } from "./proposal-supersession.ts";
import {
  assertPersonActs,
  COORDINATOR_ORIGIN_KIND,
  createWorkflowDraft,
  insertWorkflowDefinition,
  updateWorkflowDraft,
  WorkflowVisibility,
  type WorkflowWriteFacts,
} from "./postgres.ts";

/**
 * Coordinator definition proposals (chapter 25 section 13 item 13, #420).
 *
 * A coordinator turn never writes a draft. Its `definitionProposal` effect is
 * stored as a waiting proposal; a person accepting it applies the proposed
 * document through the editor's own definition and draft writers
 * (`insertWorkflowDefinition`, `createWorkflowDraft`, `updateWorkflowDraft`),
 * so there is no second writer and every guard the editor has applies.
 */

type DefinitionProposalEffect = Extract<
  CoordinatorEffect,
  { type: "definitionProposal" }
>;

export { DefinitionProposalState };

type ProposalRow = {
  id: string;
  conversation_id: string;
  turn_id: string;
  workflow_id: string | null;
  base_draft_version: number | null;
  name: string;
  definition: JsonValue;
  digest: string;
  state: string;
  decided_by: string | null;
  decided_by_name: string | null;
  decided_at: Date | string | null;
  superseded_by_version_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  version: number;
};

// The decider's current display name rides on every read and write; a
// subquery keeps it valid in a RETURNING list too.
const PROPOSAL_COLUMNS =
  `id, conversation_id, turn_id, workflow_id, base_draft_version, name,
   definition, digest, state, decided_by,
   (select principal.display_name from bakery.principals as principal
     where principal.id = decided_by) as decided_by_name,
   decided_at, superseded_by_version_id, created_at, updated_at, version`;

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function toProposal(row: ProposalRow) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    turnId: row.turn_id,
    workflowId: row.workflow_id,
    baseDraftVersion: row.base_draft_version,
    name: row.name,
    definition: row.definition,
    digest: row.digest,
    state: row.state as
      | "waiting"
      | "accepted"
      | "rejected"
      | "superseded",
    decidedBy: row.decided_by,
    decidedByName: row.decided_by_name,
    decidedAt: row.decided_at === null ? null : iso(row.decided_at),
    supersededByVersionId: row.superseded_by_version_id,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: row.version,
  };
}

function proposalEffects(
  effects: readonly CoordinatorEffect[],
): DefinitionProposalEffect[] {
  return effects.filter((effect): effect is DefinitionProposalEffect =>
    effect.type === "definitionProposal"
  );
}

type TargetRow = {
  visibility: string;
  origin_kind: string;
  origin_conversation_id: string | null;
};

/**
 * Why a turn's proposals cannot be recorded, or null. A target must be an
 * unlisted definition this same conversation's coordinator proposed; a
 * listed workflow is edited by people in the editor, never by a proposal
 * here. The document must fit the draft bound.
 */
export async function definitionProposalProblem(
  transaction: PgTransactionClient,
  facts: Readonly<{
    organizationId: string;
    conversationId: string;
    effects: readonly CoordinatorEffect[];
  }>,
): Promise<{ code: string; detail: string } | null> {
  for (const effect of proposalEffects(facts.effects)) {
    if (
      new TextEncoder().encode(canonicalJson(effect.definition)).byteLength >
        MAX_WORKFLOW_DEFINITION_BYTES
    ) {
      return {
        code: "definition_proposal_too_large",
        detail: "The proposed workflow definition exceeds the draft size bound",
      };
    }
    if (effect.workflowId === undefined) continue;
    const target = (await transaction.query<TargetRow>(
      `select visibility, origin_kind, origin_conversation_id
         from bakery.workflow_definitions
        where organization_id = $1 and id = $2`,
      [facts.organizationId, effect.workflowId],
    )).rows[0];
    if (
      !target || target.visibility !== WorkflowVisibility.Unlisted ||
      target.origin_kind !== COORDINATOR_ORIGIN_KIND ||
      target.origin_conversation_id !== facts.conversationId
    ) {
      return {
        code: "definition_proposal_target_invalid",
        detail:
          "A definition proposal may only target an unlisted definition this conversation proposed",
      };
    }
  }
  return null;
}

/** Records each `definitionProposal` effect of a completed turn as a waiting proposal. */
export async function proposeWorkflowDefinitions(
  transaction: PgTransactionClient,
  facts: Readonly<{
    organizationId: string;
    conversationId: string;
    turnId: string;
    effects: readonly CoordinatorEffect[];
  }>,
): Promise<void> {
  for (const effect of proposalEffects(facts.effects)) {
    const workflowId = effect.workflowId ?? null;
    const base = workflowId === null ? undefined : (await transaction.query<
      { version: number }
    >(
      `select version from bakery.workflow_drafts
        where organization_id = $1 and workflow_id = $2`,
      [facts.organizationId, workflowId],
    )).rows[0];
    const canonical = canonicalJson(effect.definition);
    const inserted = await transaction.query<ProposalRow>(
      `insert into bakery.workflow_definition_proposals (
         organization_id, conversation_id, turn_id, workflow_id,
         base_draft_version, name, definition, digest
       ) values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
       returning ${PROPOSAL_COLUMNS}`,
      [
        facts.organizationId,
        facts.conversationId,
        facts.turnId,
        workflowId,
        base?.version ?? null,
        effect.name,
        canonical,
        await sha256Hex(canonical),
      ],
    );
    const row = inserted.rows[0];
    if (!row) throw new Error("DEFINITION_PROPOSAL_INSERT_FAILED");
    await appendAudit(transaction, {
      organizationId: facts.organizationId,
      principalId: null,
      operation: "workflowDefinitionProposals.create",
      resourceType: "workflow_definition_proposal",
      resourceId: row.id,
      requestId: crypto.randomUUID(),
      traceId: crypto.randomUUID(),
      details: { turnId: facts.turnId, workflowId, digest: row.digest },
    });
    await appendDomainEvent(transaction, {
      organizationId: facts.organizationId,
      conversationId: facts.conversationId,
      eventType: "workflowDefinitionProposal.proposed",
      aggregateId: row.id,
      aggregateVersion: row.version,
      payload: { resourceId: row.id, resourceVersion: row.version },
      traceId: crypto.randomUUID(),
    });
  }
}

async function readProposal(
  transaction: PgTransactionClient,
  organizationId: string,
  proposalId: string,
  lock: boolean,
): Promise<ProposalRow> {
  const row = (await transaction.query<ProposalRow>(
    `select ${PROPOSAL_COLUMNS} from bakery.workflow_definition_proposals
      where organization_id = $1 and id = $2${lock ? " for update" : ""}`,
    [organizationId, proposalId],
  )).rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return row;
}

/**
 * A proposal is read and decided with its conversation: the same scope check
 * the conversation's own reads and the proposal list run, so a proposal whose
 * conversation the caller cannot reach answers as an unknown id would.
 */
async function requireProposalConversation(
  transaction: PgTransactionClient,
  organizationId: string,
  row: ProposalRow,
): Promise<void> {
  await lockConversationScope(
    transaction,
    organizationId,
    row.conversation_id,
    "share",
  );
}

export async function getWorkflowDefinitionProposal(context: ActionContext) {
  const { transaction, organizationId } = requireWorkTransaction(context);
  const proposalId = context.params.id;
  if (!proposalId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const row = await readProposal(
    transaction,
    organizationId,
    proposalId,
    false,
  );
  await requireProposalConversation(transaction, organizationId, row);
  return toProposal(row);
}

/**
 * `workflowDefinitionProposals.list`: one conversation's proposals in the
 * order they were proposed, keyset-paged. It reads exactly as the
 * conversation does: the authority runner checks conversation:read (or a
 * live mention grant on this conversation), and the scope check answers
 * 404 for a conversation the reader cannot see.
 */
export function createConversationProposalsListHandler(secret: string) {
  return async (context: ActionContext, rawInput: unknown) => {
    const { transaction, organizationId, principalId } = requireWorkTransaction(
      context,
    );
    const conversationId = context.params.id;
    if (!conversationId) {
      throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
    }
    await lockConversationScope(
      transaction,
      organizationId,
      conversationId,
      "share",
    );
    const input = rawInput as { cursor?: string; limit?: number };
    const binding: CursorBinding = {
      action: "workflowDefinitionProposals.list",
      principalId,
      organizationId,
      ordering: "createdAt:asc,id:asc",
      filters: JSON.stringify({ conversationId }),
      schemaVersion: 1,
    };
    const position = await decodeCursor(secret, input.cursor, binding);
    const limit = input.limit ?? 25;
    const result = await transaction.query<
      ProposalRow & { cursor_created_at: string }
    >(
      `select ${PROPOSAL_COLUMNS},
              to_char(created_at at time zone 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_created_at
         from bakery.workflow_definition_proposals
        where organization_id = $1 and conversation_id = $2
          and ($3::timestamptz is null
            or (created_at, id) > ($3::timestamptz, $4::uuid))
        order by created_at, id
        limit $5`,
      [
        organizationId,
        conversationId,
        position?.createdAt ?? null,
        position?.id ?? null,
        limit + 1,
      ],
    );
    const page = result.rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(toProposal),
      nextCursor: result.rows.length > limit && last
        ? await encodeCursor(secret, binding, {
          createdAt: last.cursor_created_at,
          id: last.id,
        })
        : null,
    };
  };
}

/**
 * A person accepts or rejects a waiting proposal under its version. Accepting
 * creates the unlisted definition (first proposal) or writes the proposal into
 * its draft against the draft version the proposal was made from, so a draft
 * a person changed since refuses the stale proposal with PRECONDITION_FAILED
 * and the proposal stays waiting. An agent can never decide one.
 */
export async function decideWorkflowDefinitionProposal(
  context: ActionContext,
  input: unknown,
) {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  assertPersonActs(
    context,
    principalId,
    "definition_proposal_decision_requires_person",
  );
  const { decision } = input as { decision: "accept" | "reject" };
  const proposalId = context.params.id;
  if (!proposalId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const expectedVersion = requireCommandMetadata(context).expectedVersion;
  if (expectedVersion === undefined) {
    throw new StandardError({ code: "PRECONDITION_REQUIRED" });
  }
  // Lock order is definition, then proposal: the order publish takes when it
  // settles waiting proposals, so a decision racing a publish waits instead
  // of deadlocking. workflow_id only ever moves from null to a definition, by
  // an accept, which the state check below then refuses.
  const observed = await readProposal(
    transaction,
    organizationId,
    proposalId,
    false,
  );
  await requireProposalConversation(transaction, organizationId, observed);
  const target = observed.workflow_id;
  if (target !== null) {
    await transaction.query(
      `select 1 from bakery.workflow_definitions
        where organization_id = $1 and id = $2 for update`,
      [organizationId, target],
    );
  }
  // The row is locked for update, so this one check is the proposal's
  // compare-and-set: nothing below can race it.
  const row = await readProposal(transaction, organizationId, proposalId, true);
  // A settled proposal is a conflict whatever version the caller named: a
  // decision that lost a race to another decision or to a publish learns
  // that it lost (409), not merely that its version is old (412).
  if (row.state !== DefinitionProposalState.Waiting) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: {
        reason: row.state === DefinitionProposalState.Superseded
          ? "definition_proposal_superseded"
          : "definition_proposal_decided",
      },
    });
  }
  if (row.version !== expectedVersion) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
  // Only a person reaches here, so the applied change is the person's (O50).
  const facts: WorkflowWriteFacts = {
    organizationId,
    principalId,
    requestId: context.requestId,
    traceId: context.traceId,
    actorKind: "person",
    accessTokenId: null,
  };
  let workflowId = row.workflow_id;
  if (decision === "accept") {
    const content = { definition: row.definition };
    if (workflowId === null) {
      const created = await insertWorkflowDefinition(transaction, facts, {
        slug: `proposal-${row.id}`,
        name: row.name,
        description: "",
      }, {
        visibility: WorkflowVisibility.Unlisted,
        originKind: COORDINATOR_ORIGIN_KIND,
        originConversationId: row.conversation_id,
        originTurnId: row.turn_id,
      });
      workflowId = created.id;
      await createWorkflowDraft(transaction, facts, workflowId, content);
    } else {
      const draft = (await transaction.query<{ id: string }>(
        `select id from bakery.workflow_drafts
          where organization_id = $1 and workflow_id = $2`,
        [organizationId, workflowId],
      )).rows[0];
      if (row.base_draft_version === null) {
        // Proposed when no draft existed (after a publish); one appeared since.
        if (draft) throw new StandardError({ code: "PRECONDITION_FAILED" });
        await createWorkflowDraft(transaction, facts, workflowId, content);
      } else {
        if (!draft) throw new StandardError({ code: "PRECONDITION_FAILED" });
        await updateWorkflowDraft(transaction, facts, {
          workflowId,
          versionId: draft.id,
          expectedVersion: row.base_draft_version,
        }, content);
      }
    }
  }
  const decided = (await transaction.query<ProposalRow>(
    `update bakery.workflow_definition_proposals
        set state = $3, workflow_id = $4, decided_by = $5,
            decided_at = now(), updated_at = now(), version = version + 1
      where organization_id = $1 and id = $2
      returning ${PROPOSAL_COLUMNS}`,
    [
      organizationId,
      proposalId,
      decision === "accept"
        ? DefinitionProposalState.Accepted
        : DefinitionProposalState.Rejected,
      workflowId,
      principalId,
    ],
  )).rows[0];
  if (!decided) throw new Error("DEFINITION_PROPOSAL_DECIDE_FAILED");
  await appendAudit(transaction, {
    organizationId,
    principalId,
    operation: "workflowDefinitionProposalDecisions.create",
    resourceType: "workflow_definition_proposal",
    resourceId: proposalId,
    requestId: context.requestId,
    traceId: context.traceId,
    details: { decision, workflowId },
  });
  await appendDomainEvent(transaction, {
    organizationId,
    conversationId: decided.conversation_id,
    eventType: "workflowDefinitionProposal.decided",
    aggregateId: proposalId,
    aggregateVersion: decided.version,
    payload: { resourceId: proposalId, resourceVersion: decided.version },
    traceId: context.traceId,
  });
  return toProposal(decided);
}

/**
 * Deciding a Bakery approval from a Slack button (#415).
 *
 * The perimeter first: a button press is a claim about who pressed it, and Slack's
 * signature only proves the request came from Slack. So the person is resolved from
 * an active link to a current member -- never from a handle, a display name or an
 * email resemblance -- and an unlinked or revoked Slack user is refused with a named
 * reason and nothing recorded, not recorded as a service identity.
 *
 * Then the decision itself is the store's, not this module's. `decideHumanApproval`
 * owns the compare-and-swap, the ledger entry, the wait and the named outcome, and it
 * refuses a principal who may not answer this particular approval. This module maps
 * its refusals onto the four things the Slack message can say, and does not decide
 * anything itself.
 *
 * Two things are answered here rather than delegated:
 *
 * - **A stale button.** The post carries the decision state, and a press on a post
 *   that is already settled is refused before the approval is even read, so a stale
 *   message in a long thread cannot decide twice.
 * - **The wrong workspace.** A post belongs to one installation; a press carrying a
 *   different team is refused even if that other workspace has a valid signature of
 *   its own.
 *
 * The ingress receipt is not needed to make this idempotent -- the approval's own
 * status and version already do that, and a replay arrives as a duplicate before
 * this runs -- but the receipt id travels with the decision so the record can name
 * the exact delivery that caused it.
 */
import { StandardError } from "@bakery/contracts/http";
import { type PgDatabase, withPgTransaction } from "../../platform/database.ts";
import { decideHumanApproval } from "../work/human-approval-store.ts";
import {
  findSlackIdentityLink,
  SLACK_LINK_PROVIDER,
} from "./slack-identity-links.ts";
import { resolveSlackActor } from "./slack-scope.ts";

/**
 * Why a press changed nothing, in the vocabulary the Slack message has sentences
 * for. Adding a reason means adding copy first, which is why this list is closed.
 */
export type SlackDecisionRefusal =
  | "not_linked"
  | "no_permission"
  | "already_decided"
  | "failed";

export type SlackDecisionResult =
  | Readonly<{
    kind: "decided";
    approvalId: string;
    runId: string;
    choice: "approve" | "reject";
  }>
  | Readonly<{ kind: "refused"; reason: SlackDecisionRefusal }>;

/** The milestone that carries buttons; a press on anything else refuses. */
const WAITING_MILESTONE = "waiting";

type PostRow = {
  id: string;
  organization_id: string;
  installation_team_id: string;
  run_id: string;
  step_key: string | null;
  milestone: string;
  decision_state: string | null;
};

/**
 * Applies one button press to the approval it names.
 *
 * The order is the security property: the post is read and matched to the workspace
 * before a person is looked up, the person is resolved before the approval is read,
 * and the approval is decided by the store, which enforces who may answer it. A
 * refusal writes nothing, including nothing to the post's state.
 */
export async function decideSlackApproval(
  database: PgDatabase,
  input: {
    /** The ingress receipt for this delivery, recorded on the decision. */
    readonly receiptId: string;
    /** The post whose button was pressed, from the button's value. */
    readonly decisionId: string;
    readonly choice: "approve" | "reject";
    readonly teamId: string;
    readonly userId: string;
    /** The Slack app the request arrived through; a link is unique per app. */
    readonly appId?: string;
    /** The request id, so the ledger entry points at the delivery. */
    readonly traceId: string;
  },
): Promise<SlackDecisionResult> {
  try {
    return await withPgTransaction(database, async (transaction) => {
      const loaded = await transaction.query<PostRow>(
        `select id, organization_id, installation_team_id, run_id, step_key,
                milestone, decision_state
           from bakery.slack_milestone_posts
          where id = $1
          for update`,
        [input.decisionId],
      );
      const post = loaded.rows[0];
      // An unknown post, a post from another workspace, a press on a post that was
      // never a decision, and a settled post all refuse; the last is the only one a
      // person can cause twice, so it gets its own sentence.
      if (post === undefined) return refused("failed");
      if (post.installation_team_id !== input.teamId) return refused("failed");
      if (post.milestone !== WAITING_MILESTONE) return refused("failed");
      if (post.decision_state !== "open") return refused("already_decided");

      const actor = await resolveSlackActor(
        {
          teamId: input.teamId,
          userId: input.userId,
          ...(input.appId === undefined ? {} : { appId: input.appId }),
        },
        (subject) =>
          subject.appId === undefined
            ? Promise.resolve(undefined)
            : findSlackIdentityLink(transaction, {
              organizationId: post.organization_id,
              appId: subject.appId,
              teamId: subject.teamId,
              userId: subject.userId,
            }),
      );
      // A Slack user who is not linked, whose link was revoked, or whose membership
      // has lapsed decides nothing. The refusal is named so the thread can say which.
      if (actor.kind !== "human") {
        return refused(
          actor.reason === "lookup_failed" ? "failed" : "not_linked",
        );
      }

      const approval = await transaction.query<
        { id: string; version: number; task_id: string }
      >(
        `select id, version, task_id
           from bakery.questions
          where organization_id = $1 and run_id = $2
            and step_key is not distinct from $3
            and subject_type = 'run_step' and status = 'open'
          for update`,
        [post.organization_id, post.run_id, post.step_key],
      );
      const open = approval.rows[0];
      // No open approval for this run and step: the press is stale, whether the
      // approval was answered, expired or the run was stopped.
      if (open === undefined) return refused("already_decided");

      const scope = await transaction.query<
        { application_id: string; repository_id: string | null }
      >(
        `select application_id, repository_id from bakery.tasks
          where organization_id = $1 and id = $2`,
        [post.organization_id, open.task_id],
      );
      const task = scope.rows[0];
      if (task === undefined) return refused("failed");

      await decideHumanApproval(transaction, {
        organizationId: post.organization_id,
        approvalId: open.id,
        // The linked person, never the service identity: this is the whole point of
        // resolving a link before deciding.
        principalId: actor.principalId,
        decision: input.choice === "approve" ? "approve" : "reject",
        expectedVersion: open.version,
        // A person acting for themselves, from Slack. The ledger records who; the
        // trace points at the delivery, whose receipt is the ingress's record.
        actorKind: "person",
        note: slackDecisionNote(input),
        traceId: input.traceId,
        applicationId: task.application_id,
        repositoryId: task.repository_id,
      });
      // The post is settled in the same transaction as the approval, so a thread
      // can never show an open decision that has already been answered.
      await transaction.query(
        `update bakery.slack_milestone_posts
            set decision_state = $2, updated_at = now(), version = version + 1
          where id = $1 and decision_state = 'open'`,
        [post.id, input.choice === "approve" ? "approved" : "rejected"],
      );
      return {
        kind: "decided" as const,
        approvalId: open.id,
        runId: post.run_id,
        choice: input.choice,
      };
    });
  } catch (error) {
    return refused(refusalOf(error));
  }
}

/**
 * The note a decision carries, so the ledger says where it came from.
 *
 * It names Slack and the receipt rather than the Slack user id: the person is
 * already the decision's actor, and the receipt is what makes the delivery
 * traceable back through the ingress.
 */
function slackDecisionNote(input: { readonly receiptId: string }): string {
  return `Decided from Slack (receipt ${input.receiptId})`;
}

/**
 * Maps the store's refusals onto the four sentences the message can show.
 *
 * `RESOURCE_NOT_FOUND` is the store's answer both for an approval that does not
 * exist and for a principal who may not answer it -- deliberately, so a caller
 * cannot use the answer as an oracle -- and from Slack's side those are the same
 * sentence: you may not decide this.
 */
function refusalOf(error: unknown): SlackDecisionRefusal {
  if (!(error instanceof StandardError)) return "failed";
  if (error.code === "RESOURCE_NOT_FOUND" || error.code === "AUTH_FORBIDDEN") {
    return "no_permission";
  }
  if (error.code === "STATE_CONFLICT") {
    const reason = (error.params as { reason?: string } | undefined)?.reason;
    return reason === "approval_decided" || reason === "approval_stale"
      ? "already_decided"
      : "failed";
  }
  return "failed";
}

function refused(reason: SlackDecisionRefusal): SlackDecisionResult {
  return { kind: "refused", reason };
}

/** The app id a link is scoped by, exported so a route does not invent one. */
export { SLACK_LINK_PROVIDER };

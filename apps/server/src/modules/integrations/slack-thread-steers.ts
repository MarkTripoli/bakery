/**
 * A reply in a milestone thread steers the run it belongs to (#415).
 *
 * A reply is a message from a person, so it goes through the operations a
 * person already uses rather than a Slack-shaped path of its own: a started
 * step is steered with `sessions.steer`, and a step that has not started gets a
 * note (`runSteps.note`). Both are recorded in the work item's decisions ledger
 * before delivery, which is what makes "the reply is recorded under the
 * person's linked identity" true rather than promised.
 *
 * The perimeter is the same as a button press: Slack's signature only proves the
 * request came from Slack, so the person is resolved from an active identity
 * link (never a handle or a display name), and an unlinked or revoked Slack user
 * steers nothing. A thread resolves to a run only through a post Bakery wrote,
 * so a reply in a channel Bakery never posted to has no run to steer.
 *
 * What a reply may say is bounded by the operations it uses: text only. It adds
 * no tool, grant, skill or role, and the interpreter never reads it as a
 * decision.
 */
import type { ActionContext } from "@bakery/contracts/action-registry";
import { isStorableDecisionText } from "@bakery/contracts/human-approval";
import type { AgentSpawnConfig } from "@bakery/config";
import {
  type PgDatabase,
  type PgTransactionClient,
  withPgTransaction,
} from "../../platform/database.ts";
import { resolveOrganizationActor } from "../auth/adapters/authority-postgres.ts";
import {
  principalId as toPrincipalId,
  PrincipalType,
} from "@bakery/contracts/contracts";
import { createRunStepNote } from "../execution/step-notes.ts";
import { steerAgentSession } from "../execution/sessions.ts";
import { findSlackIdentityLink } from "./slack-identity-links.ts";
import { resolveSlackActor } from "./slack-scope.ts";

/** Why a reply changed nothing, in the words a thread can be told. */
export type SlackSteerRefusal =
  | "not_linked"
  | "no_thread"
  | "no_step"
  | "no_session"
  | "failed";

export type SlackSteerResult =
  | Readonly<{
    kind: "steered";
    runId: string;
    stepKey: string;
    via: "session" | "note";
  }>
  | Readonly<{ kind: "refused"; reason: SlackSteerRefusal }>;

/** The post a thread reply hangs from: what it steers, and in which workspace. */
type ThreadPost = {
  organization_id: string;
  installation_team_id: string;
  run_id: string;
  step_key: string | null;
};

/** Slack's own bound for one message; a longer reply is refused, not cut. */
const MAX_STEER_LENGTH = 4_000;

/**
 * Resolves a thread to the post it belongs to, and that post to its run.
 *
 * `thread_ts` names the root of a thread; a milestone post that is itself a
 * reply has the root in `thread_ts` and its own timestamp in `message_ts`, and a
 * reply to the root post has the root in `message_ts`. Both are tried, so a
 * reply to either the root or a later milestone in the same thread steers.
 */
async function findThreadPost(
  transaction: PgTransactionClient,
  input: { readonly channelId: string; readonly rootTs: string },
): Promise<ThreadPost | undefined> {
  const found = await transaction.query<ThreadPost>(
    `select organization_id, installation_team_id, run_id, step_key
       from bakery.slack_milestone_posts
      where channel_id = $1
        and (thread_ts = $2 or message_ts = $2)
      order by created_at
      limit 1`,
    [input.channelId, input.rootTs],
  );
  return found.rows[0];
}

/**
 * The step a reply steers, and whether it is already running.
 *
 * A post records the step it announced; a run-wide post has no step, and a reply
 * to it has no step to steer. `status` is read here rather than inside the two
 * operations because the choice between them is this module's: a started step
 * has a session to steer, an unstarted one takes a note.
 */
async function readStep(
  transaction: PgTransactionClient,
  input: {
    readonly organizationId: string;
    readonly runId: string;
    readonly stepKey: string;
  },
): Promise<{ id: string; status: string } | undefined> {
  const step = await transaction.query<{ id: string; status: string }>(
    `select id, status from bakery.run_steps
      where organization_id = $1 and run_id = $2 and step_key = $3
      order by iteration desc
      limit 1`,
    [input.organizationId, input.runId, input.stepKey],
  );
  return step.rows[0];
}

/**
 * The session currently working on a step, when there is one.
 *
 * Only a worker session carries a run step; a step that is running without one
 * (a host-executed step) cannot be steered, and the reply is refused rather than
 * filed as a note the running step would never read.
 */
async function readSession(
  transaction: PgTransactionClient,
  input: { readonly organizationId: string; readonly runStepId: string },
): Promise<string | undefined> {
  const session = await transaction.query<{ id: string }>(
    `select session.id
       from bakery.agent_sessions session
      where session.organization_id = $1 and session.run_step_id = $2
        and session.status in ('active', 'starting')
      order by session.created_at desc
      limit 1`,
    [input.organizationId, input.runStepId],
  );
  return session.rows[0]?.id;
}

/** The context the person's own operation would have had, built from the link. */
async function personContext(
  input: {
    readonly transaction: PgTransactionClient;
    readonly organizationId: string;
    readonly principalId: string;
    readonly commandKey: string;
    readonly params: Readonly<Record<string, string>>;
  },
): Promise<ActionContext> {
  const authority = await resolveOrganizationActor(
    input.transaction,
    toPrincipalId(input.principalId) as never,
    input.organizationId as never,
  );
  return {
    transaction: input.transaction,
    params: input.params,
    // A person, not a service: the type is what makes the attribution a person's,
    // and an untyped principal would be read as an agent and refused a steer.
    principal: {
      principalId: input.principalId,
      principalType: PrincipalType.Human,
    },
    authority,
    requestId: input.commandKey,
    traceId: input.commandKey,
    signal: new AbortController().signal,
    commandMetadata: {
      operation: "sessions.steer",
      idempotencyKey: input.commandKey,
      target: input.commandKey,
    },
  } as unknown as ActionContext;
}

export async function steerFromSlackThread(
  database: PgDatabase,
  input: {
    readonly teamId: string;
    readonly userId: string;
    readonly channelId: string;
    /** The thread's root timestamp: `thread_ts`, or the message's own `ts`. */
    readonly rootTs: string;
    readonly text: string;
    /** The receipt for this delivery, so a repeated reply steers once. */
    readonly receiptId: string;
    /** The Slack app the event arrived through; a link is unique per app. */
    readonly appId?: string;
    readonly traceId: string;
    readonly limits?: AgentSpawnConfig;
    /** Where a storage fault is reported; the thread only ever sees a refusal. */
    readonly log?: (line: string) => void;
  },
): Promise<SlackSteerResult> {
  const body = input.text.trim();
  if (body.length === 0 || body.length > MAX_STEER_LENGTH) {
    return { kind: "refused", reason: "failed" };
  }
  if (!isStorableDecisionText(body)) {
    return { kind: "refused", reason: "failed" };
  }
  try {
    return await withPgTransaction(database, async (transaction) => {
      const post = await findThreadPost(transaction, {
        channelId: input.channelId,
        rootTs: input.rootTs,
      });
      // No post of Bakery's in this thread: there is no run to steer, and
      // answering a stranger's thread would be a reply Bakery owes nobody.
      if (post === undefined) return refused("no_thread");
      if (post.installation_team_id !== input.teamId) {
        return refused("no_thread");
      }
      if (post.step_key === null) return refused("no_step");

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
      // The reply is steered as the linked person, never as a service identity.
      if (actor.kind !== "human") {
        return refused(
          actor.reason === "lookup_failed" ? "failed" : "not_linked",
        );
      }

      // A compiled-plan run only writes a step's row when it dispatches it, so a
      // step with no row yet has not started: that is a note, and the note's own
      // writer checks that the run's plan declares the step. Only a row that says
      // started has a session to steer.
      const step = await readStep(transaction, {
        organizationId: post.organization_id,
        runId: post.run_id,
        stepKey: post.step_key,
      });

      const sessionId = step?.status === "started"
        ? await readSession(transaction, {
          organizationId: post.organization_id,
          runStepId: step.id,
        })
        : undefined;

      if (sessionId !== undefined) {
        const context = await personContext({
          transaction,
          organizationId: post.organization_id,
          principalId: actor.principalId,
          commandKey: `slack-steer:${input.receiptId}`,
          params: { id: sessionId },
        });
        await steerAgentSession(context, {
          body,
          mode: "steer",
          clientMessageId: `slack:${input.receiptId}`,
        }, input.limits);
        return {
          kind: "steered" as const,
          runId: post.run_id,
          stepKey: post.step_key,
          via: "session" as const,
        };
      }

      // A started step with no worker session (a host-executed step) has nothing a
      // reply could reach: a note refuses a started step, and there is no session
      // to steer, so the reply is refused rather than filed where no one reads it.
      if (step?.status === "started") return refused("no_session");

      const context = await personContext({
        transaction,
        organizationId: post.organization_id,
        principalId: actor.principalId,
        commandKey: `slack-steer:${input.receiptId}`,
        params: { id: post.run_id, stepKey: post.step_key },
      });
      await createRunStepNote(context, {
        body,
        clientNoteId: `slack:${input.receiptId}`,
      }, input.limits);
      return {
        kind: "steered" as const,
        runId: post.run_id,
        stepKey: post.step_key,
        via: "note" as const,
      };
    });
  } catch (error) {
    // A refusal is the answer the thread gets; the detail goes to the log, so
    // nothing about a person's permissions leaks back to Slack.
    input.log?.(
      `bakery: Slack thread steer failed: ${
        error instanceof Error ? error.message : "unknown"
      }`,
    );
    return { kind: "refused", reason: "failed" };
  }
}

function refused(reason: SlackSteerRefusal): SlackSteerResult {
  return { kind: "refused", reason };
}

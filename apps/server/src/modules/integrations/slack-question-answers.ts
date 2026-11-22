/**
 * Whether a press of a Slack answer button may answer a question (issue #27,
 * design 09-integrations "Bindings": buttons bind question ID, version and
 * conversation, and recheck the linked human).
 *
 * The button was posted by Bakery with the question's id and the version it had
 * then. A press is a claim, not an authority: it may arrive late, from a
 * different conversation's thread, or from someone who never linked their Slack
 * identity. Each of those is refused here, before the conversation is asked to
 * record anything. What is left is the person to answer as; the first answer
 * still wins in the question's own compare-and-swap (conversation/questions.ts
 * answerQuestion), which also checks the question's audience and expiry.
 *
 * Reads only. Every refusal is a reason code with no question text in it.
 */
import type { PgTransactionClient } from "@bakery/persistence";
import { findSlackBinding } from "./slack-bindings.ts";
import { slackLinkLookup } from "./slack-identity-links.ts";
import {
  channelCapability,
  isSlackAppId,
  isSlackTeamId,
  isSlackUserId,
  resolveSlackActor,
} from "./slack-scope.ts";
import { isSlackChannelId, isSlackTs } from "./slack-bindings.ts";
import type { SlackAdmissionSetting } from "./slack-admission.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** What a verified interaction says about the press. */
export type SlackAnswerPress = {
  readonly appId: unknown;
  readonly teamId: unknown;
  readonly channelId: unknown;
  /** The thread the button sits in. */
  readonly threadTs: unknown;
  readonly userId: unknown;
  /** From the button's value, written by Bakery when it posted the prompt. */
  readonly questionId: unknown;
  readonly version: unknown;
};

export type SlackAnswerRefusal =
  | "malformed"
  | "wrong_workspace"
  | "channel_unavailable"
  | "not_linked_thread"
  | "unknown_question"
  | "question_closed"
  | "stale_version"
  | "unlinked_presser";

export type SlackAnswerAuthorization =
  | {
    readonly ok: true;
    readonly principalId: string;
    readonly questionId: string;
    readonly conversationId: string;
  }
  | { readonly ok: false; readonly reason: SlackAnswerRefusal };

type QuestionFacts = {
  id: string;
  conversationId: string;
  kind: string;
  version: number;
  status: string;
};

const refuse = (reason: SlackAnswerRefusal): SlackAnswerAuthorization => ({
  ok: false,
  reason,
});

export async function authorizeSlackAnswerPress(
  transaction: PgTransactionClient,
  input: {
    readonly organizationId: string;
    readonly setting: SlackAdmissionSetting;
    readonly press: SlackAnswerPress;
  },
): Promise<SlackAnswerAuthorization> {
  const { organizationId, setting, press } = input;
  if (
    !UUID.test(organizationId) || typeof press !== "object" || press === null ||
    !isSlackAppId(press.appId) || !isSlackTeamId(press.teamId) ||
    !isSlackChannelId(press.channelId) || !isSlackTs(press.threadTs) ||
    !isSlackUserId(press.userId) || typeof press.questionId !== "string" ||
    !UUID.test(press.questionId) || !Number.isSafeInteger(press.version) ||
    (press.version as number) < 1
  ) return refuse("malformed");
  if (press.appId !== setting.appId || press.teamId !== setting.teamId) {
    return refuse("wrong_workspace");
  }
  const facts = setting.channelFacts(press.channelId);
  if (
    facts === undefined ||
    !channelCapability(setting.selection, facts).available
  ) return refuse("channel_unavailable");

  const binding = await findSlackBinding(transaction, organizationId, {
    appId: press.appId,
    teamId: press.teamId,
    channelId: press.channelId,
    threadTs: press.threadTs,
  });
  if (binding === undefined) return refuse("not_linked_thread");

  // The question has to belong to the conversation this thread is bound to: a
  // button copied into another thread, or a question id from another
  // conversation, finds nothing.
  const found = await transaction.query<QuestionFacts>(
    `select q.id, q.conversation_id as "conversationId", q.kind, q.version,
            case when q.status = 'open' and q.expires_at is not null
                      and q.expires_at <= now() then 'expired'
                 else q.status end as status
       from bakery.questions q
      where q.organization_id = $1 and q.id = $2 and q.conversation_id = $3`,
    [organizationId, press.questionId, binding.conversationId],
  );
  const question = found.rows[0];
  if (question === undefined || question.kind !== "question") {
    return refuse("unknown_question");
  }
  if (question.status !== "open") return refuse("question_closed");
  if (question.version !== press.version) return refuse("stale_version");

  const actor = await resolveSlackActor({
    teamId: press.teamId,
    userId: press.userId,
    appId: press.appId,
  }, slackLinkLookup(transaction, organizationId));
  if (actor.kind !== "human") return refuse("unlinked_presser");
  return {
    ok: true,
    principalId: actor.principalId,
    questionId: question.id,
    conversationId: question.conversationId,
  };
}

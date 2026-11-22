/**
 * Which Slack messages Bakery lets in, and what each becomes (issue #27,
 * design 09-integrations Q4 and "Bindings").
 *
 * An `@Bakery` mention starts a conversation in its thread; a reply in a thread
 * that is already bound to a conversation continues it. Everything else is
 * dropped before anything is stored or any model reads it: a message from a
 * bot (Bakery's own included), from someone who has not linked their Slack
 * identity, from a channel nobody selected, or a message that is addressed to no
 * one. A signature proves a request came from Slack, never that its sender may
 * act, so the sender is resolved through an active identity link every time.
 *
 * `classifySlackMessage` only reads. `admitSlackMessage` runs the classification
 * and then, for a message that is let in, binds the thread and hands the text to
 * the conversation through `post`; for the rest it writes nothing at all.
 */
import type { PgTransactionClient } from "@bakery/persistence";
import {
  bindSlackThread,
  findSlackBinding,
  isSlackChannelId,
  isSlackTs,
  type SlackBinding,
  type SlackThreadKey,
} from "./slack-bindings.ts";
import { slackLinkLookup } from "./slack-identity-links.ts";
import {
  channelCapability,
  isSlackAppId,
  isSlackTeamId,
  isSlackUserId,
  resolveSlackActor,
  type SlackChannelFacts,
  type SlackChannelSelection,
  type SlackIdentityLink,
  type SlackSubject,
} from "./slack-scope.ts";

/** The part of a Slack message event this module reads, and nothing more. */
export type SlackMessageEvent = {
  readonly appId: unknown;
  readonly teamId: unknown;
  readonly channelId: unknown;
  readonly userId?: unknown;
  readonly botId?: unknown;
  readonly subtype?: unknown;
  readonly text?: unknown;
  readonly ts: unknown;
  readonly threadTs?: unknown;
};

/** What the installation is configured with; the event never supplies it. */
export type SlackAdmissionSetting = {
  readonly appId: string;
  readonly teamId: string;
  /** Bakery's own bot user, so its echoes and mentions of it are recognised. */
  readonly botUserId: string;
  readonly selection: SlackChannelSelection;
  /** What Slack says about a channel; undefined when it is unknown. */
  readonly channelFacts: (channelId: string) => SlackChannelFacts | undefined;
};

export type SlackIgnoreReason =
  | "malformed"
  | "wrong_workspace"
  | "not_a_message"
  | "bot_echo"
  | "channel_unavailable"
  | "not_addressed"
  | "unlinked_sender";

export type SlackAdmission =
  | {
    readonly kind: "mention";
    readonly principalId: string;
    readonly key: SlackThreadKey;
    readonly text: string;
  }
  | {
    readonly kind: "linked_reply";
    readonly principalId: string;
    readonly binding: SlackBinding;
    readonly text: string;
  }
  | { readonly kind: "ignore"; readonly reason: SlackIgnoreReason };

export type SlackAdmissionLookups = {
  readonly binding: (key: SlackThreadKey) => Promise<SlackBinding | undefined>;
  readonly link: (
    subject: SlackSubject,
  ) => Promise<SlackIdentityLink | undefined>;
};

/** Only a plain message, or one also shown in its channel, is a person speaking. */
const MESSAGE_SUBTYPES: ReadonlySet<string> = new Set(["thread_broadcast"]);

/** The longest text read from one message; more is never needed to answer it. */
export const SLACK_TEXT_LIMIT = 4000;

const ignore = (reason: SlackIgnoreReason): SlackAdmission => ({
  kind: "ignore",
  reason,
});

/** Whether the text mentions this bot user: Slack writes `<@U123>` or `<@U123|name>`. */
export function mentionsBot(text: string, botUserId: string): boolean {
  return text.includes(`<@${botUserId}>`) || text.includes(`<@${botUserId}|`);
}

/** The text without the mention of the bot, trimmed. */
export function withoutBotMention(text: string, botUserId: string): string {
  return text.replace(new RegExp(`<@${botUserId}(?:\\|[^>]*)?>`, "g"), "")
    .trim();
}

export async function classifySlackMessage(
  event: SlackMessageEvent,
  setting: SlackAdmissionSetting,
  lookups: SlackAdmissionLookups,
): Promise<SlackAdmission> {
  if (
    typeof event !== "object" || event === null ||
    !isSlackAppId(event.appId) || !isSlackTeamId(event.teamId) ||
    !isSlackChannelId(event.channelId) || !isSlackTs(event.ts) ||
    (event.threadTs !== undefined && !isSlackTs(event.threadTs)) ||
    (event.userId !== undefined && !isSlackUserId(event.userId)) ||
    (event.text !== undefined && typeof event.text !== "string")
  ) return ignore("malformed");
  if (event.appId !== setting.appId || event.teamId !== setting.teamId) {
    return ignore("wrong_workspace");
  }
  // Bots first: Bakery's own post comes back as an event and must never become
  // a message of the conversation it was posted into.
  if (
    event.botId !== undefined || event.subtype === "bot_message" ||
    event.userId === setting.botUserId
  ) return ignore("bot_echo");
  if (
    event.userId === undefined ||
    (event.subtype !== undefined &&
      !(typeof event.subtype === "string" &&
        MESSAGE_SUBTYPES.has(event.subtype)))
  ) return ignore("not_a_message");
  const channelFacts = setting.channelFacts(event.channelId);
  if (
    channelFacts === undefined ||
    !channelCapability(setting.selection, channelFacts).available
  ) return ignore("channel_unavailable");

  const text = (event.text ?? "").slice(0, SLACK_TEXT_LIMIT);
  const key: SlackThreadKey = {
    appId: event.appId,
    teamId: event.teamId,
    channelId: event.channelId,
    threadTs: event.threadTs ?? event.ts,
  };
  const binding = await lookups.binding(key);
  const addressed = binding !== undefined ||
    mentionsBot(text, setting.botUserId);
  if (!addressed) return ignore("not_addressed");

  const actor = await resolveSlackActor({
    teamId: event.teamId,
    userId: event.userId,
    appId: event.appId,
  }, lookups.link);
  if (actor.kind !== "human") return ignore("unlinked_sender");

  const clean = withoutBotMention(text, setting.botUserId);
  return binding === undefined
    ? { kind: "mention", principalId: actor.principalId, key, text: clean }
    : {
      kind: "linked_reply",
      principalId: actor.principalId,
      binding,
      text: clean,
    };
}

/** What the conversation is told about an admitted message. */
export type SlackPost = {
  readonly organizationId: string;
  readonly conversationId: string;
  readonly principalId: string;
  readonly text: string;
  /** Stable per Slack message, so a retry posts nothing new. */
  readonly clientMessageId: string;
};

export type AdmitSlackMessageResult =
  | {
    readonly admitted: true;
    readonly kind: "mention" | "linked_reply";
    readonly binding: SlackBinding;
    /** True only when this message opened the conversation. */
    readonly created: boolean;
  }
  | { readonly admitted: false; readonly reason: SlackIgnoreReason };

/**
 * Lets a message in, or drops it without writing anything. Run in one
 * transaction: the binding and the post commit together, so a failed post
 * leaves no empty conversation behind.
 */
export async function admitSlackMessage(
  transaction: PgTransactionClient,
  input: {
    readonly organizationId: string;
    readonly event: SlackMessageEvent;
    readonly setting: SlackAdmissionSetting;
    readonly post: (post: SlackPost) => Promise<void>;
  },
): Promise<AdmitSlackMessageResult> {
  const { organizationId, event, setting, post } = input;
  const admission = await classifySlackMessage(event, setting, {
    binding: (key) => findSlackBinding(transaction, organizationId, key),
    link: slackLinkLookup(transaction, organizationId),
  });
  if (admission.kind === "ignore") {
    return { admitted: false, reason: admission.reason };
  }
  let binding: SlackBinding;
  let created = false;
  if (admission.kind === "mention") {
    const bound = await bindSlackThread(transaction, {
      organizationId,
      key: admission.key,
      principalId: admission.principalId,
    });
    if (!bound.ok) return { admitted: false, reason: "malformed" };
    binding = bound.binding;
    created = bound.created;
  } else {
    binding = admission.binding;
  }
  await post({
    organizationId,
    conversationId: binding.conversationId,
    principalId: admission.principalId,
    text: admission.text,
    clientMessageId: `slack:${binding.channelId}:${String(event.ts)}`,
  });
  return { admitted: true, kind: admission.kind, binding, created };
}

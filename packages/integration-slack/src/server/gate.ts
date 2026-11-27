import { z } from "zod";
import { defineAction, defineIntegration } from "@bakery/integration-sdk";

export const SLACK_GATE_ID = "bakery.slack";
export const SLACK_HOST_PROFILE = "slack-bot";
export const SLACK_WORKSPACE_KIND = "slack.workspace";

export const SLACK_DM_OPEN = { id: "slack.dm.open", version: 1 } as const;
export const SLACK_MESSAGE_POST = {
  id: "slack.message.post",
  version: 1,
} as const;
export const SLACK_MESSAGE_UPDATE = {
  id: "slack.message.update",
  version: 1,
} as const;

const OPEN_REQUEST = { id: "slack.conversations.open", version: 1 } as const;
const POST_REQUEST = { id: "slack.chat.post", version: 1 } as const;
const HISTORY_REQUEST = {
  id: "slack.conversations.history",
  version: 1,
} as const;
const UPDATE_REQUEST = { id: "slack.chat.update", version: 1 } as const;
const LIST_IMS_REQUEST = {
  id: "slack.conversations.list",
  version: 1,
} as const;
const RECONCILE_IM_LIMIT = 200;

const RECONCILE_HISTORY_LIMIT = 50;

const slackUserId = z.string().regex(/^[UW][A-Z0-9]+$/).describe(
  "The Slack user id of the person the direct message goes to.",
);
const channelId = z.string().regex(/^[CDG][A-Z0-9]+$/).describe(
  "The Slack conversation id, a direct message channel for deliveries.",
);
const messageTs = z.string().regex(/^[0-9]+\.[0-9]+$/).describe(
  "The Slack timestamp that names one message in its conversation.",
);
const messageText = z.string().min(1).max(4000).describe(
  "The message text exactly as Slack shows it to the recipient.",
);

const slackOk = z.boolean().describe(
  "False when Slack refused the call; Slack still answers HTTP 200.",
);
const slackError = z.string().describe(
  "Slack's reason code, such as channel_not_found.",
).optional().describe(
  "Slack's reason code when ok is false; absent on success.",
);
const answeredChannel = channelId.optional().describe(
  "The conversation Slack answered for; absent when the call failed.",
);
const answeredTs = messageTs.optional().describe(
  "The message timestamp Slack answered with; absent when the call failed.",
);

const openBody = z.strictObject({ users: slackUserId }).describe(
  "conversations.open arguments: the one user to open a direct message with.",
);
const openResponse = z.object({
  ok: slackOk,
  error: slackError,
  channel: z.object({ id: channelId }).describe(
    "The direct message conversation Slack opened or already had.",
  ).optional().describe(
    "The opened conversation; absent when Slack refused the call.",
  ),
}).describe("Slack's conversations.open answer, reduced to the channel id.");

const postBody = z.strictObject({ channel: channelId, text: messageText })
  .describe("chat.postMessage arguments: the conversation and the text.");
const postResponse = z.object({
  ok: slackOk,
  error: slackError,
  channel: answeredChannel,
  ts: answeredTs,
}).describe("Slack's chat.postMessage answer: where the message landed.");

const historyInput = z.strictObject({
  channel: channelId,
  limit: z.number().int().min(1).max(100).describe(
    "How many recent messages Slack returns, newest first.",
  ),
}).describe("conversations.history arguments for one recent page.");
const historyResponse = z.object({
  ok: slackOk,
  error: slackError,
  messages: z.array(
    z.object({
      ts: messageTs,
      text: z.string().describe("The message text as Slack stored it.")
        .optional().describe(
          "The message text; absent for some attachment-only messages.",
        ),
    }).describe("One recent message, reduced to its timestamp and text."),
  ).max(100).describe(
    "The newest messages in the conversation, newest first.",
  ).optional().describe(
    "The newest messages, read when a post is uncertain; absent on failure.",
  ),
}).describe("Slack's conversations.history answer for one page.");

const listImsInput = z.strictObject({
  types: z.literal("im").describe(
    "Only direct message conversations are listed.",
  ),
  limit: z.number().int().min(1).max(1000).describe(
    "How many direct message conversations Slack returns in one page.",
  ),
}).describe("conversations.list arguments for the bot's direct messages.");
const listImsResponse = z.object({
  ok: slackOk,
  error: slackError,
  channels: z.array(
    z.object({
      id: channelId,
      user: slackUserId.optional().describe(
        "The other person in the direct message; absent for other kinds.",
      ),
    }).describe("One direct message conversation and who it is with."),
  ).max(1000).describe(
    "The bot's direct message conversations on this page.",
  ).optional().describe(
    "The direct messages, read when an open is uncertain; absent on failure.",
  ),
}).describe("Slack's conversations.list answer, reduced to ids and users.");

const updateBody = z.strictObject({
  channel: channelId,
  ts: messageTs,
  text: messageText,
}).describe("chat.update arguments: the message to rewrite and its new text.");
const updateResponse = z.object({
  ok: slackOk,
  error: slackError,
  channel: answeredChannel,
  ts: answeredTs,
}).describe("Slack's chat.update answer: the message that was rewritten.");

const dmOpenInput = z.strictObject({ userId: slackUserId }).describe(
  "Open, or find, the direct message conversation with one Slack user.",
);
const dmOpenOutput = z.strictObject({ channelId }).describe(
  "The direct message conversation to post into.",
);
const postInput = z.strictObject({
  channelId,
  text: messageText,
  marker: z.string().min(8).max(200).describe(
    "A unique string the text carries, used to find the message again when a post is uncertain.",
  ),
}).describe("Post one message into a conversation the bot can write to.");
const messageRef = z.strictObject({ channelId, ts: messageTs }).describe(
  "The conversation and timestamp that name one posted message.",
);
const updateInput = z.strictObject({
  channelId,
  ts: messageTs,
  text: messageText,
}).describe("Rewrite the text of one message the bot posted.");

export class SlackApiError extends Error {
  constructor(method: string, readonly code: string) {
    super(`Slack refused ${method}: ${code}.`);
    this.name = "SlackApiError";
  }
}

const SLACK_LINK_WITH_LABEL =
  /<((?:https?:\/\/|mailto:|[@#!])[^<>|\s]*)\|([^<>]+)>/g;
const SLACK_LINK = /<((?:https?:\/\/|mailto:|[@#!])[^<>|\s]*)>/g;

export function slackShownText(text: string): string {
  return text
    .replace(SLACK_LINK_WITH_LABEL, "$2")
    .replace(SLACK_LINK, "$1")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

const dmOpen = defineAction({
  ...SLACK_DM_OPEN,
  input: dmOpenInput,
  output: dmOpenOutput,
  effect: "reconcile",
  resourceKind: SLACK_WORKSPACE_KIND,
  requests: [OPEN_REQUEST],
  reconcileRequests: [LIST_IMS_REQUEST],
  providerPermissions: { im: "write" },
  async execute(ctx, input) {
    const answer = openResponse.parse(
      await ctx.provider.request(OPEN_REQUEST, { users: input.userId }),
    );
    if (answer.channel === undefined) {
      throw new SlackApiError("conversations.open", "no_channel");
    }
    return { channelId: answer.channel.id };
  },
  async reconcile(ctx) {
    const answer = listImsResponse.parse(
      await ctx.provider.request(LIST_IMS_REQUEST, {
        types: "im",
        limit: RECONCILE_IM_LIMIT,
      }),
    );
    const found = (answer.channels ?? []).find((channel) =>
      channel.user === ctx.input.userId
    );
    return found === undefined
      ? { status: "uncertain" as const }
      : { status: "confirmed" as const, result: { channelId: found.id } };
  },
});

const messagePost = defineAction({
  ...SLACK_MESSAGE_POST,
  input: postInput,
  output: messageRef,
  effect: "reconcile",
  resourceKind: SLACK_WORKSPACE_KIND,
  requests: [POST_REQUEST],
  reconcileRequests: [HISTORY_REQUEST],
  providerPermissions: { chat: "write", im: "read" },
  async execute(ctx, input) {
    if (!input.text.includes(input.marker)) {
      throw new SlackApiError("chat.postMessage", "marker_missing");
    }
    const answer = postResponse.parse(
      await ctx.provider.request(POST_REQUEST, {
        channel: input.channelId,
        text: input.text,
      }),
    );
    if (answer.ts === undefined) {
      throw new SlackApiError("chat.postMessage", "no_ts");
    }
    return { channelId: answer.channel ?? input.channelId, ts: answer.ts };
  },
  async reconcile(ctx) {
    const answer = historyResponse.parse(
      await ctx.provider.request(HISTORY_REQUEST, {
        channel: ctx.input.channelId,
        limit: RECONCILE_HISTORY_LIMIT,
      }),
    );
    const found = (answer.messages ?? []).find((message) =>
      message.text?.includes(ctx.input.marker) ?? false
    );
    return found === undefined ? { status: "uncertain" as const } : {
      status: "confirmed" as const,
      result: { channelId: ctx.input.channelId, ts: found.ts },
    };
  },
});

const messageUpdate = defineAction({
  ...SLACK_MESSAGE_UPDATE,
  input: updateInput,
  output: messageRef,
  effect: "reconcile",
  resourceKind: SLACK_WORKSPACE_KIND,
  requests: [UPDATE_REQUEST],
  reconcileRequests: [HISTORY_REQUEST],
  providerPermissions: { chat: "write", im: "read" },
  async execute(ctx, input) {
    const answer = updateResponse.parse(
      await ctx.provider.request(UPDATE_REQUEST, {
        channel: input.channelId,
        ts: input.ts,
        text: input.text,
      }),
    );
    return {
      channelId: answer.channel ?? input.channelId,
      ts: answer.ts ?? input.ts,
    };
  },
  async reconcile(ctx) {
    const answer = historyResponse.parse(
      await ctx.provider.request(HISTORY_REQUEST, {
        channel: ctx.input.channelId,
        limit: RECONCILE_HISTORY_LIMIT,
      }),
    );
    const updated = (answer.messages ?? []).some((message) =>
      message.ts === ctx.input.ts &&
      message.text !== undefined &&
      slackShownText(message.text) === slackShownText(ctx.input.text)
    );
    return updated
      ? {
        status: "confirmed" as const,
        result: { channelId: ctx.input.channelId, ts: ctx.input.ts },
      }
      : { status: "uncertain" as const };
  },
});

const template = {
  resourceKind: SLACK_WORKSPACE_KIND,
  pathParams: {},
  refusal: {
    okField: "ok",
    codeField: "error",
    uncertainCodes: [
      "fatal_error",
      "internal_error",
      "request_timeout",
      "service_unavailable",
      "ratelimited",
    ],
  },
  maxResponseBytes: 65_536,
} as const;

export const slackGateSource = {
  sdkVersion: 1,
  id: SLACK_GATE_ID,
  version: "1.0.0",
  authenticationProfile: SLACK_HOST_PROFILE,
  bakery: { required: [], optional: [] },
  actions: [
    { ...SLACK_DM_OPEN },
    { ...SLACK_MESSAGE_POST },
    { ...SLACK_MESSAGE_UPDATE },
  ],
  resourceKinds: [SLACK_WORKSPACE_KIND],
  requests: [
    {
      ...OPEN_REQUEST,
      ...template,
      method: "POST",
      effect: "write",
      idempotent: true,
      pathTemplate: "/api/conversations.open",
      input: openBody,
      query: [],
      body: openBody,
      response: openResponse,
      providerPermissions: { im: "write" },
    },
    {
      ...POST_REQUEST,
      ...template,
      method: "POST",
      effect: "write",
      idempotent: false,
      pathTemplate: "/api/chat.postMessage",
      input: postBody,
      query: [],
      body: postBody,
      response: postResponse,
      providerPermissions: { chat: "write" },
    },
    {
      ...HISTORY_REQUEST,
      ...template,
      method: "GET",
      effect: "read",
      idempotent: true,
      pathTemplate: "/api/conversations.history",
      input: historyInput,
      query: ["channel", "limit"],
      response: historyResponse,
      providerPermissions: { im: "read" },
    },
    {
      ...LIST_IMS_REQUEST,
      ...template,
      method: "GET",
      effect: "read",
      idempotent: true,
      pathTemplate: "/api/conversations.list",
      input: listImsInput,
      query: ["types", "limit"],
      response: listImsResponse,
      providerPermissions: { im: "read" },
    },
    {
      ...UPDATE_REQUEST,
      ...template,
      method: "POST",
      effect: "write",
      idempotent: true,
      pathTemplate: "/api/chat.update",
      input: updateBody,
      query: [],
      body: updateBody,
      response: updateResponse,
      providerPermissions: { chat: "write" },
    },
  ],
  optionalFeatures: [],
  subscriptions: [],
};

export const slackGateHandlers = {
  [`${SLACK_DM_OPEN.id}@${SLACK_DM_OPEN.version}`]: dmOpen,
  [`${SLACK_MESSAGE_POST.id}@${SLACK_MESSAGE_POST.version}`]: messagePost,
  [`${SLACK_MESSAGE_UPDATE.id}@${SLACK_MESSAGE_UPDATE.version}`]: messageUpdate,
};

export const slackGate = defineIntegration(slackGateSource, slackGateHandlers);

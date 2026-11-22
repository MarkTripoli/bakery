import { assert, assertEquals } from "@std/assert";
import {
  classifySlackMessage,
  mentionsBot,
  type SlackAdmissionLookups,
  type SlackAdmissionSetting,
  type SlackMessageEvent,
  withoutBotMention,
} from "../../apps/server/src/modules/integrations/slack-admission.ts";
import type { SlackBinding } from "../../apps/server/src/modules/integrations/slack-bindings.ts";

/**
 * #27: which Slack messages are let in. Everything that is not a linked
 * person addressing Bakery in a selected channel is dropped before a single row
 * is written or a model reads it, so these cases look only at the decision.
 */

const APP = "A0BAKERY1", TEAM = "T0TEAM001", BOT = "U0BAKERY1";
const CHANNEL = "C0CHAN001", PRIVATE = "G0PRIV001", OTHER = "C0OTHER01";
const ALICE = "U0ALICE01", BOB = "U0BOB0001";
const PRINCIPAL = "00000000-0000-4000-8000-0000000000a1";
const ORG = "00000000-0000-4000-8000-0000000000b1";
const TS = "1700000000.000100", ROOT = "1700000000.000001";

const setting = (
  over: Partial<SlackAdmissionSetting> = {},
): SlackAdmissionSetting => ({
  appId: APP,
  teamId: TEAM,
  botUserId: BOT,
  selection: {
    selectedChannelIds: new Set([CHANNEL, PRIVATE]),
    privateParticipation: false,
  },
  channelFacts: (id) =>
    id === OTHER || id === CHANNEL
      ? { id, isPrivate: false, botIsMember: true }
      : id === PRIVATE
      ? { id, isPrivate: true, botIsMember: true }
      : undefined,
  ...over,
});

const bound: SlackBinding = {
  id: "00000000-0000-4000-8000-0000000000c1",
  organizationId: ORG,
  appId: APP,
  teamId: TEAM,
  channelId: CHANNEL,
  threadTs: ROOT,
  conversationId: "00000000-0000-4000-8000-0000000000d1",
  createdBy: PRINCIPAL,
  createdAt: "2026-11-22T00:00:00.000Z",
};

function lookups(
  over: Partial<SlackAdmissionLookups> & { linked?: string[] } = {},
): SlackAdmissionLookups & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    binding: over.binding ?? ((key) => {
      calls.push("binding");
      return Promise.resolve(key.threadTs === ROOT ? bound : undefined);
    }),
    link: over.link ?? ((subject) => {
      calls.push("link");
      return Promise.resolve(
        (over.linked ?? [ALICE]).includes(subject.userId)
          ? { principalId: PRINCIPAL, state: "active", memberCurrent: true }
          : undefined,
      );
    }),
  };
}

const event = (over: Partial<SlackMessageEvent> = {}): SlackMessageEvent => ({
  appId: APP,
  teamId: TEAM,
  channelId: CHANNEL,
  userId: ALICE,
  text: `<@${BOT}> what is the plan?`,
  ts: TS,
  ...over,
});

const decide = (e: SlackMessageEvent, s = setting(), l = lookups()) =>
  classifySlackMessage(e, s, l);

Deno.test("a linked person mentioning Bakery in a selected channel starts a thread binding, without the mention", async () => {
  const result = await decide(event());
  assertEquals(result, {
    kind: "mention",
    principalId: PRINCIPAL,
    key: { appId: APP, teamId: TEAM, channelId: CHANNEL, threadTs: TS },
    text: "what is the plan?",
  });
});

Deno.test("a mention inside an unbound thread binds that thread's first message", async () => {
  const result = await decide(event({ threadTs: "1700000000.000050" }));
  assertEquals(result.kind, "mention");
  if (result.kind === "mention") {
    assertEquals(result.key.threadTs, "1700000000.000050");
  }
});

Deno.test("a reply in a bound thread continues it with no mention needed", async () => {
  const result = await decide(
    event({ text: "and the tests?", threadTs: ROOT }),
  );
  assertEquals(result.kind, "linked_reply");
  if (result.kind === "linked_reply") {
    assertEquals(result.binding.conversationId, bound.conversationId);
    assertEquals(result.text, "and the tests?");
  }
});

Deno.test("Bakery's own post and any bot's message are dropped as echoes, before any lookup", async () => {
  for (
    const over of [
      { userId: BOT },
      { botId: "B0SOMEBOT", userId: undefined },
      { subtype: "bot_message" },
      { botId: "B0SOMEBOT", threadTs: ROOT },
    ] as Partial<SlackMessageEvent>[]
  ) {
    const l = lookups();
    assertEquals(await decide(event(over), setting(), l), {
      kind: "ignore",
      reason: "bot_echo",
    }, JSON.stringify(over));
    assertEquals(l.calls, [], "nothing was read");
  }
});

Deno.test("an unlinked, revoked or non-member sender is dropped, with the reason kept out of what is stored", async () => {
  assertEquals(await decide(event({ userId: BOB })), {
    kind: "ignore",
    reason: "unlinked_sender",
  });
  for (
    const link of [
      { principalId: PRINCIPAL, state: "revoked", memberCurrent: true },
      { principalId: PRINCIPAL, state: "active", memberCurrent: false },
    ] as const
  ) {
    assertEquals(
      await decide(
        event(),
        setting(),
        lookups({ link: () => Promise.resolve(link) }),
      ),
      { kind: "ignore", reason: "unlinked_sender" },
    );
  }
  assertEquals(
    await decide(
      event(),
      setting(),
      lookups({ link: () => Promise.reject(new Error("db")) }),
    ),
    { kind: "ignore", reason: "unlinked_sender" },
    "a lookup that fails never admits",
  );
});

Deno.test("a message addressed to no one is dropped, even from a linked person", async () => {
  assertEquals(await decide(event({ text: "lunch?" })), {
    kind: "ignore",
    reason: "not_addressed",
  });
  assertEquals(await decide(event({ text: undefined })), {
    kind: "ignore",
    reason: "not_addressed",
  });
  // A reply in a thread nobody bound, with no mention.
  assertEquals(
    await decide(event({ text: "hm", threadTs: "1700000000.000050" })),
    { kind: "ignore", reason: "not_addressed" },
  );
});

Deno.test("a channel nobody selected, a private one not enabled, or an unknown one is unavailable", async () => {
  for (const channelId of [OTHER, PRIVATE, "C0UNKNOWN"]) {
    assertEquals(await decide(event({ channelId })), {
      kind: "ignore",
      reason: "channel_unavailable",
    }, channelId);
  }
  assertEquals(
    await decide(
      event({ channelId: PRIVATE }),
      setting({
        selection: {
          selectedChannelIds: new Set([PRIVATE]),
          privateParticipation: true,
        },
      }),
    ),
    {
      kind: "mention",
      principalId: PRINCIPAL,
      key: { appId: APP, teamId: TEAM, channelId: PRIVATE, threadTs: TS },
      text: "what is the plan?",
    },
  );
});

Deno.test("another workspace or app is dropped, and malformed ids never reach a lookup", async () => {
  assertEquals(await decide(event({ teamId: "T0OTHER01" })), {
    kind: "ignore",
    reason: "wrong_workspace",
  });
  assertEquals(await decide(event({ appId: "A0OTHER01" })), {
    kind: "ignore",
    reason: "wrong_workspace",
  });
  for (
    const over of [
      { ts: "not-a-ts" },
      { ts: 1700000000.0001 },
      { threadTs: "x" },
      { channelId: "D0DIRECT01" },
      { userId: "alice" },
      { text: 42 },
      { teamId: undefined },
    ] as Partial<SlackMessageEvent>[]
  ) {
    const l = lookups();
    assertEquals(await decide(event(over), setting(), l), {
      kind: "ignore",
      reason: "malformed",
    }, JSON.stringify(over));
    assertEquals(l.calls, []);
  }
});

Deno.test("only a plain message or one also shown in its channel is a person speaking", async () => {
  for (
    const subtype of [
      "message_changed",
      "message_deleted",
      "channel_join",
      "file_share",
      "me_message",
    ]
  ) {
    assertEquals(await decide(event({ subtype })), {
      kind: "ignore",
      reason: "not_a_message",
    }, subtype);
  }
  assertEquals(
    (await decide(event({ subtype: "thread_broadcast" }))).kind,
    "mention",
  );
});

Deno.test("mention detection handles both forms Slack writes and removes only Bakery's", () => {
  assert(mentionsBot(`hi <@${BOT}>`, BOT));
  assert(mentionsBot(`hi <@${BOT}|bakery>`, BOT));
  assert(!mentionsBot("hi <@U0SOMEONE>", BOT));
  assert(!mentionsBot(`hi @Bakery <@${BOT}x>`, BOT));
  assertEquals(
    withoutBotMention(
      `<@${BOT}> ask <@U0SOMEONE> about <@${BOT}|bakery> this`,
      BOT,
    ),
    "ask <@U0SOMEONE> about  this",
  );
});

Deno.test("text is cut to a bounded length before it goes any further", async () => {
  const result = await decide(
    event({ text: `<@${BOT}> ${"x".repeat(10_000)}` }),
  );
  assertEquals(result.kind, "mention");
  if (result.kind === "mention") assert(result.text.length <= 4000);
});

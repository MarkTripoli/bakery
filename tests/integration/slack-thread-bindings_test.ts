import { assert, assertEquals, assertRejects } from "@std/assert";
import { cleanupAuthFixture } from "../helpers/auth.ts";
import { openSocketFixture } from "../helpers/events-socket.ts";
import { addMember, seedQuestion, seedRun } from "../helpers/run-requests.ts";
import {
  admitSlackMessage,
  type SlackAdmissionSetting,
  type SlackPost,
} from "../../apps/server/src/modules/integrations/slack-admission.ts";
import {
  bindSlackThread,
  findSlackBinding,
  type SlackThreadKey,
} from "../../apps/server/src/modules/integrations/slack-bindings.ts";
import { linkSlackIdentity } from "../../apps/server/src/modules/integrations/slack-identity-links.ts";
import {
  authorizeSlackAnswerPress,
  type SlackAnswerRefusal,
} from "../../apps/server/src/modules/integrations/slack-question-answers.ts";
import { withPgTransaction } from "../../packages/persistence/src/postgres.ts";

/**
 * #27 against real Postgres, as the application role: one thread, one
 * conversation, however many first mentions arrive together; messages that are
 * not a linked person addressing Bakery leave no trace; an answer button is
 * honoured only for the conversation it was posted in, while its question is
 * open at the version it was posted with, from a linked person.
 */

const suffix = crypto.randomUUID().replaceAll("-", "").toUpperCase();
const APP = `A${suffix.slice(0, 8)}`, TEAM = `T${suffix.slice(8, 16)}`;
const BOT = `U${suffix.slice(16, 24)}`, ALICE = `U${suffix.slice(24, 32)}`;
const BOB = `W${suffix.slice(0, 8)}`;
const CHANNEL = `C${suffix.slice(8, 16)}`, OFF = `C${suffix.slice(16, 24)}`;
let tick = 0;
const nextTs = () =>
  `17000000${String(10 + Math.floor(tick / 1000000)).padStart(2, "0")}.${
    String(100000 + ++tick)
  }`;

const setting: SlackAdmissionSetting = {
  appId: APP,
  teamId: TEAM,
  botUserId: BOT,
  selection: {
    selectedChannelIds: new Set([CHANNEL]),
    privateParticipation: false,
  },
  channelFacts: (id) =>
    id === CHANNEL || id === OFF
      ? { id, isPrivate: false, botIsMember: true }
      : undefined,
};

type Open = Awaited<ReturnType<typeof open>>;

async function open() {
  const fixture = await openSocketFixture();
  const alice = await addMember(fixture, "Alice", "developer");
  await withPgTransaction(
    fixture.runtimePgDatabase,
    (tx) =>
      linkSlackIdentity(tx, {
        organizationId: fixture.organizationId,
        principalId: alice.principalId,
        identity: { appId: APP, teamId: TEAM, userId: ALICE },
        verifiedAt: new Date(),
      }),
  );
  const posts: SlackPost[] = [];
  const admit = (
    over: Record<string, unknown>,
    post: (post: SlackPost) => Promise<void> = (p) => {
      posts.push(p);
      return Promise.resolve();
    },
  ) =>
    withPgTransaction(fixture.runtimePgDatabase, (tx) =>
      admitSlackMessage(tx, {
        organizationId: fixture.organizationId,
        setting,
        post,
        event: {
          appId: APP,
          teamId: TEAM,
          channelId: CHANNEL,
          userId: ALICE,
          text: `<@${BOT}> please look at the build`,
          ts: nextTs(),
          ...over,
        },
      }));
  const counts = async () => {
    const q = (sql: string) =>
      fixture.pgDatabase.query<{ n: number }>(sql, [fixture.organizationId])
        .then((r) => r.rows[0].n);
    return {
      links: await q(
        "select count(*)::int as n from bakery.channel_links where organization_id = $1",
      ),
      conversations: await q(
        "select count(*)::int as n from bakery.conversations where organization_id = $1",
      ),
    };
  };
  return {
    fixture,
    alice,
    posts,
    admit,
    counts,
    finish: async () => {
      await fixture.pgDatabase.query(
        "delete from bakery.channel_links where organization_id = $1",
        [fixture.organizationId],
      );
      await cleanupAuthFixture(fixture.pgDatabase, [
        fixture.email,
        alice.email,
      ]);
      await fixture.close();
    },
  };
}

async function withOpen<T>(work: (o: Open) => Promise<T>) {
  const o = await open();
  try {
    return await work(o);
  } finally {
    await o.finish();
  }
}

Deno.test("simultaneous first mentions of one thread open one conversation and one binding", () =>
  withOpen(async (o) => {
    const before = await o.counts();
    const ts = nextTs();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => o.admit({ ts })),
    );
    assert(results.every((r) => r.admitted));
    const admitted = results.filter((r) => r.admitted) as Extract<
      (typeof results)[number],
      { admitted: true }
    >[];
    assertEquals(
      admitted.filter((r) => r.created).length,
      1,
      "one call opened it",
    );
    assertEquals(
      new Set(admitted.map((r) => r.binding.conversationId)).size,
      1,
    );
    assertEquals(new Set(admitted.map((r) => r.binding.id)).size, 1);
    const after = await o.counts();
    assertEquals(after.links, before.links + 1);
    assertEquals(after.conversations, before.conversations + 1);
    // Every retry carries the same id, so the conversation records it once.
    assertEquals(new Set(o.posts.map((p) => p.clientMessageId)).size, 1);
    assertEquals(o.posts.length, 8);
    assertEquals(o.posts[0].text, "please look at the build");
    assertEquals(o.posts[0].principalId, o.alice.principalId);
  }));

Deno.test("a reply in the bound thread continues its conversation and opens nothing", () =>
  withOpen(async (o) => {
    const root = nextTs();
    const first = await o.admit({ ts: root });
    assert(first.admitted && first.kind === "mention");
    const before = await o.counts();
    const reply = await o.admit({
      ts: nextTs(),
      threadTs: root,
      text: "and the tests?",
    });
    assert(reply.admitted && reply.kind === "linked_reply" && !reply.created);
    assertEquals(reply.binding.conversationId, first.binding.conversationId);
    assertEquals(await o.counts(), before);
    assertEquals(o.posts.at(-1)?.text, "and the tests?");
    assertEquals(o.posts.at(-1)?.conversationId, first.binding.conversationId);
  }));

Deno.test("messages that are not a linked person addressing Bakery leave no trace", () =>
  withOpen(async (o) => {
    const before = await o.counts();
    const dropped = [
      [{ userId: BOB }, "unlinked_sender"],
      [{ userId: BOT }, "bot_echo"],
      [{ botId: "B0SOMEBOT", userId: undefined }, "bot_echo"],
      [{ text: "lunch anyone?" }, "not_addressed"],
      [{ channelId: OFF }, "channel_unavailable"],
      [{ teamId: "T0ELSEWHE" }, "wrong_workspace"],
    ] as const;
    for (const [over, reason] of dropped) {
      const result = await o.admit(over);
      assertEquals(result, { admitted: false, reason }, JSON.stringify(over));
    }
    assertEquals(await o.counts(), before, "no row, no conversation");
    assertEquals(o.posts.length, 0, "nothing was handed to the conversation");
  }));

Deno.test("a post that fails leaves no binding and no empty conversation behind", () =>
  withOpen(async (o) => {
    const before = await o.counts();
    const ts = nextTs();
    await assertRejects(
      () => o.admit({ ts }, () => Promise.reject(new Error("POST_FAILED"))),
      Error,
      "POST_FAILED",
    );
    assertEquals(await o.counts(), before);
    // The retry opens it once.
    const again = await o.admit({ ts });
    assert(again.admitted && again.created);
  }));

Deno.test("a thread is named only by Slack's own ids: bad ones are refused before any query", () =>
  withOpen(async (o) => {
    const key = {
      appId: APP,
      teamId: TEAM,
      channelId: CHANNEL,
      threadTs: nextTs(),
    };
    for (
      const bad of [
        { ...key, threadTs: "tomorrow" },
        { ...key, channelId: "D0DIRECT01" },
        { ...key, appId: "app" },
      ] as SlackThreadKey[]
    ) {
      const result = await withPgTransaction(
        o.fixture.runtimePgDatabase,
        (tx) =>
          bindSlackThread(tx, {
            organizationId: o.fixture.organizationId,
            key: bad,
            principalId: o.alice.principalId,
          }),
      );
      assertEquals(result, { ok: false, reason: "malformed" });
    }
  }));

Deno.test("the application role can read and add a link but never change or remove one", () =>
  withOpen(async (o) => {
    const first = await o.admit({ ts: nextTs() });
    assert(first.admitted);
    for (
      const sql of [
        "update bakery.channel_links set thread_ts = '1700000000.999999'",
        "delete from bakery.channel_links",
      ]
    ) {
      await assertRejects(
        () => o.fixture.runtimePgDatabase.query(sql),
        Error,
        "permission denied",
        sql,
      );
    }
    const found = await withPgTransaction(
      o.fixture.runtimePgDatabase,
      (tx) => findSlackBinding(tx, o.fixture.organizationId, first.binding),
    );
    assertEquals(found?.id, first.binding.id);
    // Another organization's id finds nothing: a link is read per organization.
    const other = await withPgTransaction(
      o.fixture.runtimePgDatabase,
      (tx) => findSlackBinding(tx, crypto.randomUUID(), first.binding),
    );
    assertEquals(other, undefined);
  }));

async function pressSetup(o: Open) {
  const run = await seedRun(o.fixture);
  const question = await seedQuestion(o.fixture, run, null);
  const bound = await withPgTransaction(
    o.fixture.runtimePgDatabase,
    (tx) =>
      bindSlackThread(tx, {
        organizationId: o.fixture.organizationId,
        key: {
          appId: APP,
          teamId: TEAM,
          channelId: CHANNEL,
          threadTs: nextTs(),
        },
        principalId: o.alice.principalId,
        // The thread is bound to the fixture's conversation, which owns the question.
        open: () => Promise.resolve(o.fixture.conversationId),
      }),
  );
  assert(bound.ok);
  const press = (over: Record<string, unknown> = {}) =>
    withPgTransaction(
      o.fixture.runtimePgDatabase,
      (tx) =>
        authorizeSlackAnswerPress(tx, {
          organizationId: o.fixture.organizationId,
          setting,
          press: {
            appId: APP,
            teamId: TEAM,
            channelId: CHANNEL,
            threadTs: bound.binding.threadTs,
            userId: ALICE,
            questionId: question,
            version: 1,
            ...over,
          },
        }),
    );
  return { question, bound: bound.binding, press, run };
}

Deno.test("a linked person's press on an open question of the bound conversation is honoured", () =>
  withOpen(async (o) => {
    const s = await pressSetup(o);
    assertEquals(await s.press(), {
      ok: true,
      principalId: o.alice.principalId,
      questionId: s.question,
      conversationId: o.fixture.conversationId,
    });
  }));

Deno.test("a press that is stale, closed, borrowed or from no one is refused, each with its own reason", () =>
  withOpen(async (o) => {
    const s = await pressSetup(o);
    // Another thread, bound to a different conversation, with the first one's question.
    const elsewhere = await withPgTransaction(
      o.fixture.runtimePgDatabase,
      (tx) =>
        bindSlackThread(tx, {
          organizationId: o.fixture.organizationId,
          key: {
            appId: APP,
            teamId: TEAM,
            channelId: CHANNEL,
            threadTs: nextTs(),
          },
          principalId: o.alice.principalId,
        }),
    );
    assert(
      elsewhere.ok &&
        elsewhere.binding.conversationId !== o.fixture.conversationId,
    );
    const refusals: [Record<string, unknown>, SlackAnswerRefusal][] = [
      [{ userId: BOB }, "unlinked_presser"],
      [{ version: 2 }, "stale_version"],
      [{ threadTs: elsewhere.binding.threadTs }, "unknown_question"],
      [{ threadTs: nextTs() }, "not_linked_thread"],
      [{ questionId: crypto.randomUUID() }, "unknown_question"],
      [{ teamId: "T0ELSEWHE" }, "wrong_workspace"],
      [{ channelId: OFF }, "channel_unavailable"],
      [{ questionId: "not-an-id" }, "malformed"],
      [{ version: 0 }, "malformed"],
      [{ userId: "alice" }, "malformed"],
    ];
    for (const [over, reason] of refusals) {
      assertEquals(
        await s.press(over),
        { ok: false, reason },
        JSON.stringify(over),
      );
    }
    // Once answered, or once expired, the button no longer works.
    await o.fixture.pgDatabase.query(
      "update bakery.questions set status = 'answered', version = 2 where id = $1",
      [s.question],
    );
    assertEquals(await s.press({ version: 2 }), {
      ok: false,
      reason: "question_closed",
    });
    await o.fixture.pgDatabase.query(
      "update bakery.questions set status = 'open', expires_at = now() - interval '1 minute' where id = $1",
      [s.question],
    );
    assertEquals(await s.press({ version: 2 }), {
      ok: false,
      reason: "question_closed",
    });
  }));

Deno.test("a removed member's press is refused at once, before any sweep", () =>
  withOpen(async (o) => {
    const s = await pressSetup(o);
    assert((await s.press()).ok);
    await o.fixture.pgDatabase.query(
      "update bakery.organization_memberships set status = 'inactive' where organization_id = $1 and principal_id = $2",
      [o.fixture.organizationId, o.alice.principalId],
    );
    assertEquals(await s.press(), { ok: false, reason: "unlinked_presser" });
  }));

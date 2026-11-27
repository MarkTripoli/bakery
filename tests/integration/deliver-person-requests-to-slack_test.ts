import { assert, assertEquals } from "@std/assert";
import {
  type RequestSlackOutcome,
  rewriteClosedRequestSlackMessages,
  sendDueRequestSlackMessages,
} from "../../apps/server/src/modules/work/request-slack.ts";
import { linkSlackIdentity } from "../../apps/server/src/modules/integrations/slack-identity-links.ts";
import { withPgTransaction } from "../../packages/persistence/src/postgres.ts";
import { seedRun } from "../helpers/run-requests.ts";
import {
  connectOnce,
  fakeSlack,
  open,
  type SentSlackRequest,
  slackGateDeps,
  TEAM_ID,
} from "../helpers/slack-connect.ts";

const NOTE = "Please check the migration numbers in the plan";
const DM = "D0REQUESTS";
const RECIPIENT = "U0RECIPIENT";
const BASE_URL = "https://bakery.example.test";
const MINUTE = 60_000;

type Answer = (request: SentSlackRequest) => unknown;

function slackAnswers(): { answer: Answer; posts: () => number } {
  let posts = 0;
  return {
    answer: (request) => {
      if (request.path === "/api/conversations.open") {
        return { ok: true, channel: { id: DM } };
      }
      if (request.path === "/api/chat.postMessage") {
        posts += 1;
        return { ok: true, channel: DM, ts: `1700000000.${posts}` };
      }
      if (request.path === "/api/chat.update") {
        const body = request.body as { channel: string; ts: string };
        return { ok: true, channel: body.channel, ts: body.ts };
      }
      if (request.path === "/api/conversations.history") {
        return { ok: true, messages: [] };
      }
      return { ok: false, error: "unknown_method" };
    },
    posts: () => posts,
  };
}

async function world(answer: Answer) {
  const o = await open(fakeSlack());
  const connectionId = await connectOnce(o);
  const f = o.fixture;
  const recipientId = f.developerId!;
  const applicationId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  await f.pgDatabase.query(
    `insert into bakery.applications (id, organization_id, slug, name)
     values ($1::uuid, $2, $1::text, 'Requests')`,
    [applicationId, f.organizationId],
  );
  await f.pgDatabase.query(
    `insert into bakery.conversations
       (id, organization_id, application_id, title, created_by)
     values ($1, $2, $3, 'Requests', $4)`,
    [conversationId, f.organizationId, applicationId, f.adminId],
  );
  await f.pgDatabase.query(
    `insert into bakery.tasks (id, organization_id, application_id,
       conversation_id, title, task_type, created_by)
     values ($1, $2, $3, $4, 'Ship the <release> & notes', 'feature', $5)`,
    [taskId, f.organizationId, applicationId, conversationId, f.adminId],
  );
  const run = await seedRun({
    pgDatabase: f.pgDatabase,
    organizationId: f.organizationId,
    principalId: f.adminId,
    taskId,
  });
  const gate = slackGateDeps(f.runtimePgDatabase, (request) => answer(request));
  const linkRecipient = () =>
    withPgTransaction(f.runtimePgDatabase, (tx) =>
      linkSlackIdentity(tx, {
        organizationId: f.organizationId,
        principalId: recipientId,
        identity: { appId: "A0TESTAPP", teamId: TEAM_ID, userId: RECIPIENT },
        verifiedAt: new Date(),
      }));
  const request = async (intent = "review") =>
    (await f.pgDatabase.query<{ id: string }>(
      `insert into bakery.person_requests
         (organization_id, run_id, task_id, intent, recipient_id, asked_by,
          asked_by_kind, note, expires_at)
       values ($1, $2, $3, $7, $4, $5, 'person', $6,
         now() + interval '7 days')
       returning id`,
      [
        f.organizationId,
        run.runId,
        taskId,
        recipientId,
        f.adminId,
        NOTE,
        intent,
      ],
    )).rows[0]!.id;
  const deliveries = async (requestId: string) =>
    (await f.pgDatabase.query<
      {
        state: string;
        attempts: number;
        external_ref: string | null;
        failure_code: string | null;
        delivered: boolean;
      }
    >(
      `select state, attempts, external_ref, failure_code,
              delivered_at is not null as delivered
         from bakery.person_request_deliveries
        where request_id = $1 and channel = 'slack'`,
      [requestId],
    )).rows;
  const deps = {
    database: f.runtimePgDatabase,
    publicBaseUrl: BASE_URL,
    registry: gate.deps.registry,
    providerRequests: gate.deps.providerRequests!,
  };
  const at = (offsetMinutes: number) =>
    new Date(Date.now() + offsetMinutes * MINUTE);
  const send = (offsetMinutes = 0) =>
    sendDueRequestSlackMessages({ ...deps, now: at(offsetMinutes) });
  const rewrite = (offsetMinutes = 0) =>
    rewriteClosedRequestSlackMessages({ ...deps, now: at(offsetMinutes) });
  const mine = (outcomes: readonly RequestSlackOutcome[], id: string) =>
    outcomes.filter((outcome) => outcome.requestId === id);
  const adminName = async () =>
    (await f.pgDatabase.query<{ name: string }>(
      "select display_name as name from bakery.principals where id = $1",
      [f.adminId],
    )).rows[0]!.name;
  const requestFor = async (
    recipient: string,
    stepKey: string,
    createdAt: Date,
  ) =>
    (await f.pgDatabase.query<{ id: string }>(
      `insert into bakery.person_requests
         (organization_id, run_id, task_id, step_key, intent, recipient_id,
          asked_by, asked_by_kind, note, expires_at, created_at)
       values ($1, $2, $3, $4, 'review', $5, $6, 'person', $7,
         now() + interval '7 days', $8)
       returning id`,
      [
        f.organizationId,
        run.runId,
        taskId,
        stepKey,
        recipient,
        f.adminId,
        NOTE,
        createdAt.toISOString(),
      ],
    )).rows[0]!.id;
  return {
    adminName,
    requestFor,
    o,
    f,
    connectionId,
    run,
    taskId,
    sent: gate.sent,
    linkRecipient,
    request,
    deliveries,
    send,
    rewrite,
    mine,
    finish: async () => {
      try {
        await f.pgDatabase.query(
          "delete from bakery.external_identity_links where organization_id = $1",
          [f.organizationId],
        );
        await f.pgDatabase.query(
          "delete from bakery.person_requests where organization_id = $1",
          [f.organizationId],
        );
        await f.pgDatabase.query(
          "delete from bakery.decisions_ledger where organization_id = $1",
          [f.organizationId],
        );
      } finally {
        await o.finish();
      }
    },
  };
}

Deno.test("an open request of a linked recipient is sent as one Slack DM with its marker and no note", async () => {
  const slack = slackAnswers();
  const w = await world(slack.answer);
  try {
    assert((await w.linkRecipient()).ok);
    const id = await w.request();
    assertEquals(w.mine(await w.send(), id), [
      { requestId: id, result: "delivered" },
    ]);
    assertEquals(w.sent.map((request) => request.path), [
      "/api/conversations.open",
      "/api/chat.postMessage",
    ]);
    assertEquals(w.sent[0]!.body, { users: RECIPIENT });
    const post = w.sent[1]!.body as { channel: string; text: string };
    assertEquals(post.channel, DM);
    assert(post.text.includes(`request=${id}`), post.text);
    assert(
      post.text.includes(
        `${BASE_URL}/tasks/${w.taskId}?organization=${w.f.organizationId}&request=${id}`,
      ),
      post.text,
    );
    assertEquals(
      post.text.split("\n").slice(0, 2),
      [
        "*Review requested* · Ship the &lt;release&gt; &amp; notes",
        `${await w
          .adminName()} asked you to review this work. Open Bakery to read it.`,
      ],
    );
    assert(!post.text.includes(NOTE), "the DM never carries the note");
    assertEquals(await w.deliveries(id), [{
      state: "delivered",
      attempts: 0,
      external_ref: `${DM}:1700000000.1`,
      failure_code: null,
      delivered: true,
    }]);
    assertEquals(w.mine(await w.send(20), id), []);
    assertEquals(w.sent.length, 2);
    assertEquals(slack.posts(), 1);
  } finally {
    await w.finish();
  }
});

Deno.test("a recipient with no Slack link gets nothing and nothing is recorded", async () => {
  const w = await world(slackAnswers().answer);
  try {
    const id = await w.request();
    assertEquals(w.mine(await w.send(), id), []);
    assertEquals(w.sent.length, 0);
    assertEquals(await w.deliveries(id), []);
  } finally {
    await w.finish();
  }
});

Deno.test("a Slack refusal records failed and is not tried again", async () => {
  const slack = slackAnswers();
  const w = await world((request) =>
    request.path === "/api/chat.postMessage"
      ? { ok: false, error: "invalid_auth" }
      : slack.answer(request)
  );
  try {
    assert((await w.linkRecipient()).ok);
    const id = await w.request();
    const [outcome] = w.mine(await w.send(), id);
    assertEquals(outcome!.result, "failed");
    const [row] = await w.deliveries(id);
    assertEquals([row!.state, row!.attempts], ["failed", 1]);
    assert(row!.failure_code !== null);
    const calls = w.sent.length;
    assertEquals(w.mine(await w.send(120), id), []);
    assertEquals(w.sent.length, calls);
  } finally {
    await w.finish();
  }
});

Deno.test("an uncertain send is retried after the backoff and then delivered", async () => {
  const slack = slackAnswers();
  let uncertain = true;
  let landed = "";
  const w = await world((request) =>
    request.path === "/api/chat.postMessage" && uncertain
      ? { ok: false, error: "fatal_error" }
      : request.path === "/api/conversations.history" && !uncertain
      ? {
        ok: true,
        messages: [{ ts: "1700000000.9", text: landed }],
      }
      : slack.answer(request)
  );
  try {
    assert((await w.linkRecipient()).ok);
    const id = await w.request();
    landed = `landed request=${id}`;
    assertEquals(w.mine(await w.send(), id), [
      { requestId: id, result: "retrying", code: "uncertain" },
    ]);
    assertEquals(
      (await w.deliveries(id)).map((row) => [row.state, row.attempts]),
      [["retrying", 1]],
    );
    assertEquals(w.mine(await w.send(5), id), []);
    uncertain = false;
    const retried = w.mine(await w.send(11), id);
    assertEquals(retried.length, 1);
    const [row] = await w.deliveries(id);
    assertEquals(row!.attempts, 0);
    assertEquals(row!.state, "delivered");
    assertEquals(retried, [{ requestId: id, result: "delivered" }]);
  } finally {
    await w.finish();
  }
});

Deno.test("handled, expired and withdrawn requests each rewrite their DM once", async () => {
  const slack = slackAnswers();
  const w = await world(slack.answer);
  try {
    assert((await w.linkRecipient()).ok);
    const handled = await w.request();
    await w.send();
    const expired = await w.request("approve");
    await w.send();
    const withdrawn = await w.request("answer");
    await w.send();
    const refs = new Map<string, string>();
    for (const id of [handled, expired, withdrawn]) {
      refs.set(id, (await w.deliveries(id))[0]!.external_ref!);
    }
    assertEquals(await w.rewrite(), []);
    await w.f.pgDatabase.query(
      "update bakery.person_requests set status = 'handled' where id = $1",
      [handled],
    );
    await w.f.pgDatabase.query(
      `insert into bakery.decisions_ledger (organization_id, task_id, run_id,
         kind, subject_kind, subject_id, decided_by, text, detail)
       values ($1, $2, $3, 'request_handled', 'run', $3, $4, 'review',
         jsonb_build_object('requestId', $5::text))`,
      [w.f.organizationId, w.taskId, w.run.runId, w.f.adminId, handled],
    );
    await w.f.pgDatabase.query(
      "update bakery.person_requests set expires_at = now() + interval '1 minute' where id = $1",
      [expired],
    );
    await w.f.pgDatabase.query(
      "update bakery.person_requests set status = 'withdrawn' where id = $1",
      [withdrawn],
    );
    const before = w.sent.length;
    const outcomes = await w.rewrite(5);
    for (const id of [handled, expired, withdrawn]) {
      assertEquals(w.mine(outcomes, id), [{
        requestId: id,
        result: "rewritten",
      }]);
      assertEquals((await w.deliveries(id))[0]!.state, "rewritten");
    }
    const updates = w.sent.slice(before);
    assertEquals(updates.map((request) => request.path), [
      "/api/chat.update",
      "/api/chat.update",
      "/api/chat.update",
    ]);
    const textFor = (id: string) => {
      const [channel, ts] = refs.get(id)!.split(":");
      const found = updates.find((request) => {
        const body = request.body as { channel: string; ts: string };
        return body.channel === channel && body.ts === ts;
      });
      assert(found !== undefined, `no update for ${id}`);
      return (found.body as { text: string }).text;
    };
    const names = await w.f.pgDatabase.query<{ name: string }>(
      "select display_name as name from bakery.principals where id = $1",
      [w.f.adminId],
    );
    const name = names.rows[0]!.name;
    assertEquals(
      textFor(handled).split("\n")[0],
      `*Handled by ${name}* · Ship the &lt;release&gt; &amp; notes`,
    );
    const expiredLines = textFor(expired).split("\n");
    assertEquals(
      expiredLines[0],
      "*Expired* · Ship the &lt;release&gt; &amp; notes",
    );
    assert(expiredLines[1]!.startsWith("Nobody answered by <!date^"));
    assertEquals(textFor(withdrawn).split("\n").slice(0, 2), [
      "*Withdrawn* · Ship the &lt;release&gt; &amp; notes",
      `${name} withdrew this request.`,
    ]);
    for (const id of [handled, expired, withdrawn]) {
      assert(textFor(id).includes(`request=${id}`));
      assert(!textFor(id).includes(NOTE));
    }
    assertEquals(await w.rewrite(30), []);
    assertEquals(w.sent.length, before + 3);
  } finally {
    await w.finish();
  }
});

Deno.test("an uncertain rewrite is tried three times with backoff and then recorded as rewrite_failed", async () => {
  const slack = slackAnswers();
  let updates = 0;
  const w = await world((request) => {
    if (request.path === "/api/chat.update") {
      updates += 1;
      return { ok: false, error: "fatal_error" };
    }
    return slack.answer(request);
  });
  try {
    assert((await w.linkRecipient()).ok);
    const id = await w.request();
    await w.send();
    await w.f.pgDatabase.query(
      "update bakery.person_requests set status = 'withdrawn' where id = $1",
      [id],
    );
    const row = async () => {
      const [found] = await w.deliveries(id);
      return [found!.state, found!.attempts, found!.failure_code];
    };
    assertEquals(w.mine(await w.rewrite(1), id), [
      { requestId: id, result: "retrying", code: "uncertain" },
    ]);
    assertEquals(await row(), ["delivered", 1, "uncertain"]);
    assertEquals(w.mine(await w.rewrite(5), id), []);
    assertEquals(w.mine(await w.rewrite(12), id).length, 1);
    assertEquals(await row(), ["delivered", 2, "uncertain"]);
    assertEquals(w.mine(await w.rewrite(30), id), []);
    assertEquals(w.mine(await w.rewrite(43), id), [
      { requestId: id, result: "failed", code: "uncertain" },
    ]);
    assertEquals(await row(), ["rewrite_failed", 3, "uncertain"]);
    const calls = w.sent.length;
    assertEquals(w.mine(await w.rewrite(500), id), []);
    assertEquals(w.sent.length, calls);
    assert(updates >= 1);
  } finally {
    await w.finish();
  }
});

Deno.test("a row stuck in sending past the lease is delivered on the next run without a second post", async () => {
  const slack = slackAnswers();
  const w = await world(slack.answer);
  try {
    assert((await w.linkRecipient()).ok);
    const id = await w.request();
    await w.send();
    assertEquals(slack.posts(), 1);
    await w.f.pgDatabase.query(
      `update bakery.person_request_deliveries
          set state = 'sending', attempts = 1, external_ref = null,
              delivered_at = null, updated_at = now() - interval '5 minutes'
        where request_id = $1 and channel = 'slack'`,
      [id],
    );
    assertEquals(w.mine(await w.send(), id), []);
    assertEquals((await w.deliveries(id))[0]!.state, "sending");
    assertEquals(w.mine(await w.send(6), id), [
      { requestId: id, result: "delivered" },
    ]);
    const [row] = await w.deliveries(id);
    assertEquals(row!.state, "delivered");
    assertEquals(row!.external_ref, `${DM}:1700000000.1`);
    assertEquals(slack.posts(), 1);
    assertEquals(
      w.sent.filter((request) => request.path === "/api/chat.postMessage")
        .length,
      1,
    );
  } finally {
    await w.finish();
  }
});

Deno.test("a row stuck in rewriting past the lease is rewritten on the next run without a second update", async () => {
  const slack = slackAnswers();
  const w = await world(slack.answer);
  try {
    assert((await w.linkRecipient()).ok);
    const id = await w.request();
    await w.send();
    await w.f.pgDatabase.query(
      "update bakery.person_requests set status = 'withdrawn' where id = $1",
      [id],
    );
    assertEquals(w.mine(await w.rewrite(), id), [
      { requestId: id, result: "rewritten" },
    ]);
    await w.f.pgDatabase.query(
      `update bakery.person_request_deliveries
          set state = 'rewriting', updated_at = now() - interval '5 minutes'
        where request_id = $1 and channel = 'slack'`,
      [id],
    );
    assertEquals(w.mine(await w.rewrite(), id), []);
    assertEquals(w.mine(await w.rewrite(6), id), [
      { requestId: id, result: "rewritten" },
    ]);
    assertEquals((await w.deliveries(id))[0]!.state, "rewritten");
    assertEquals(
      w.sent.filter((request) => request.path === "/api/chat.update").length,
      1,
    );
  } finally {
    await w.finish();
  }
});

Deno.test("more than a batch of older requests to unlinked people does not hold back a linked person's DM", async () => {
  const slack = slackAnswers();
  const w = await world(slack.answer);
  try {
    assert((await w.linkRecipient()).ok);
    const older = new Date(Date.now() - 60 * MINUTE);
    for (let index = 0; index < 105; index += 1) {
      await w.requestFor(w.f.adminId, `unlinked-${index}`, older);
    }
    const id = await w.request();
    assertEquals(w.mine(await w.send(), id), [
      { requestId: id, result: "delivered" },
    ]);
    assertEquals(slack.posts(), 1);
  } finally {
    await w.finish();
  }
});

Deno.test("a send left uncertain that did land is resolved and rewritten once the request closes", async () => {
  const slack = slackAnswers();
  let landed = "";
  const w = await world((request) =>
    request.path === "/api/chat.postMessage"
      ? { ok: false, error: "fatal_error" }
      : request.path === "/api/conversations.history" && landed !== ""
      ? { ok: true, messages: [{ ts: "1700000000.7", text: landed }] }
      : slack.answer(request)
  );
  try {
    assert((await w.linkRecipient()).ok);
    const id = await w.request();
    assertEquals(w.mine(await w.send(), id), [
      { requestId: id, result: "retrying", code: "uncertain" },
    ]);
    await w.f.pgDatabase.query(
      "update bakery.person_requests set status = 'withdrawn' where id = $1",
      [id],
    );
    landed = `landed request=${id}`;
    assertEquals(w.mine(await w.send(1), id), [
      { requestId: id, result: "delivered" },
    ]);
    assertEquals(
      (await w.deliveries(id))[0]!.external_ref,
      `${DM}:1700000000.7`,
    );
    assertEquals(w.mine(await w.rewrite(1), id), [
      { requestId: id, result: "rewritten" },
    ]);
    const update = w.sent.find((request) =>
      request.path === "/api/chat.update"
    );
    assertEquals((update!.body as { ts: string }).ts, "1700000000.7");
    assertEquals(
      w.sent.filter((request) => request.path === "/api/chat.postMessage")
        .length,
      1,
    );
  } finally {
    await w.finish();
  }
});

Deno.test("a send left uncertain that never landed ends failed with no new post once the request closes", async () => {
  const slack = slackAnswers();
  const w = await world((request) =>
    request.path === "/api/chat.postMessage"
      ? { ok: false, error: "fatal_error" }
      : slack.answer(request)
  );
  try {
    assert((await w.linkRecipient()).ok);
    const id = await w.request();
    await w.send();
    await w.f.pgDatabase.query(
      "update bakery.person_requests set status = 'withdrawn' where id = $1",
      [id],
    );
    assertEquals(w.mine(await w.send(1), id), [
      { requestId: id, result: "failed", code: "closed_unconfirmed" },
    ]);
    const [row] = await w.deliveries(id);
    assertEquals([row!.state, row!.failure_code], [
      "failed",
      "closed_unconfirmed",
    ]);
    assertEquals(w.mine(await w.send(60), id), []);
    assertEquals(w.mine(await w.rewrite(60), id), []);
    assertEquals(
      w.sent.filter((request) => request.path === "/api/chat.postMessage")
        .length,
      1,
    );
    assertEquals(
      w.sent.filter((request) => request.path === "/api/chat.update").length,
      0,
    );
  } finally {
    await w.finish();
  }
});

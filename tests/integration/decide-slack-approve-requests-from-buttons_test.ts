import { assert, assertEquals } from "@std/assert";
import { Hono } from "hono";
import { cleanupAuthFixture } from "../helpers/auth.ts";
import { problemResponse } from "../../packages/contracts/src/http.ts";
import { withPgTransaction } from "../../packages/persistence/src/postgres.ts";
import { requestHumanApproval } from "../../apps/server/src/modules/work/human-approval-store.ts";
import { sendDueRequestSlackMessages } from "../../apps/server/src/modules/work/request-slack.ts";
import {
  SLACK_PRESS_NO_PERMISSION,
  SLACK_PRESS_NOT_LINKED,
} from "../../apps/server/src/modules/work/request-slack-press.ts";
import { linkSlackIdentity } from "../../apps/server/src/modules/integrations/slack-identity-links.ts";
import {
  mountSlackInteractionRoute,
  SLACK_INTERACTIONS_PATH,
} from "../../apps/server/src/modules/integrations/slack-intake-routes.ts";
import type { AuthVariables } from "../../apps/server/src/modules/auth/middleware.ts";
import { addMember, seedRun } from "../helpers/run-requests.ts";
import {
  APP_ID,
  connectOnce,
  fakeSlack,
  open,
  type SentSlackRequest,
  slackGateDeps,
  TEAM_ID,
} from "../helpers/slack-connect.ts";

const SIGNING_SECRET = "slack-signing-secret-buttons";
const DM = "D0BUTTONS";
const RECIPIENT = "U0RECIPIENT";
const SECOND = "U0SECOND";
const STRANGER = "U0STRANGER";
const BASE_URL = "https://bakery.example.test";
const encoder = new TextEncoder();

type Answer = (request: SentSlackRequest) => unknown;

function slackAnswer(): Answer {
  let posts = 0;
  return (request) => {
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
    if (request.path === "/api/chat.postEphemeral") {
      return { ok: true, message_ts: "1700000099.1" };
    }
    if (request.path === "/api/conversations.history") {
      return { ok: true, messages: [] };
    }
    return { ok: false, error: "unknown_method" };
  };
}

async function sign(timestamp: string, body: string, secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(`v0:${timestamp}:${body}`),
    ),
  );
  return `v0=${
    [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")
  }`;
}

type Press = Readonly<{
  requestId: string;
  action: "approve" | "reject";
  userId: string;
  signature?: "missing" | "wrong" | "old";
}>;

async function seedTask(
  pg: { query: (sql: string, values: unknown[]) => Promise<unknown> },
  organizationId: string,
  adminId: string,
) {
  const applicationId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  await pg.query(
    `insert into bakery.applications (id, organization_id, slug, name)
     values ($1::uuid, $2, $1::text, 'Buttons')`,
    [applicationId, organizationId],
  );
  await pg.query(
    `insert into bakery.conversations
       (id, organization_id, application_id, title, created_by)
     values ($1, $2, $3, 'Buttons', $4)`,
    [conversationId, organizationId, applicationId, adminId],
  );
  await pg.query(
    `insert into bakery.tasks (id, organization_id, application_id,
       conversation_id, title, task_type, created_by)
     values ($1, $2, $3, $4, 'Ship the release', 'feature', $5)`,
    [taskId, organizationId, applicationId, conversationId, adminId],
  );
  return { applicationId, conversationId, taskId };
}

async function world() {
  const o = await open(fakeSlack(), { signingSecret: SIGNING_SECRET });
  try {
    return await worldIn(o);
  } catch (error) {
    await o.finish();
    throw error;
  }
}

async function worldIn(o: Awaited<ReturnType<typeof open>>) {
  await connectOnce(o);
  const f = o.fixture;
  const recipientId = f.developerId!;
  const pg = f.pgDatabase;
  const otherOrganizationId = crypto.randomUUID();
  const second = await addMember(f, "Second Member", "developer");
  const stranger = await addMember(f, "Stranger Member", "developer");
  const secondId = second.principalId;
  const strangerId = stranger.principalId;
  const extraEmails = [second.email, stranger.email];
  const task = await seedTask(pg, f.organizationId, f.adminId);
  const run = await seedRun({
    pgDatabase: pg,
    organizationId: f.organizationId,
    principalId: f.adminId,
    taskId: task.taskId,
  });
  const gate = slackGateDeps(f.runtimePgDatabase, slackAnswer());
  const deferred: Promise<void>[] = [];
  const deps = {
    database: f.runtimePgDatabase,
    publicBaseUrl: BASE_URL,
    registry: gate.deps.registry,
    providerRequests: gate.deps.providerRequests!,
  };
  const app = new Hono<{ Variables: AuthVariables }>();
  app.onError((error, context) =>
    problemResponse(context, error, { publicBaseUrl: BASE_URL })
  );
  mountSlackInteractionRoute(app, {
    ...deps,
    secretsKey: o.secretsKey,
    defer: (work) => {
      deferred.push(work);
    },
  });
  const link = (principalId: string, userId: string) =>
    withPgTransaction(f.runtimePgDatabase, (tx) =>
      linkSlackIdentity(tx, {
        organizationId: f.organizationId,
        principalId,
        identity: { appId: APP_ID, teamId: TEAM_ID, userId },
        verifiedAt: new Date(),
      }));
  const ask = async (
    audience?: readonly string[],
    target = {
      organizationId: f.organizationId,
      runId: run.runId,
      ...task,
    },
  ) => {
    const asked = await withPgTransaction(
      pg,
      (transaction) =>
        requestHumanApproval(transaction, {
          organizationId: target.organizationId,
          runId: target.runId,
          taskId: target.taskId,
          conversationId: target.conversationId,
          stepKey: "human.approval",
          prompt: "Ship it?",
          audience: audience ?? [recipientId],
          ownerPrincipalId: recipientId,
          traceId: crypto.randomUUID(),
          applicationId: target.applicationId,
          repositoryId: null,
        }),
    );
    const requests = (await pg.query<{ id: string; recipient_id: string }>(
      `select id, recipient_id from bakery.person_requests
        where organization_id = $1 and target_id = $2 order by recipient_id`,
      [target.organizationId, asked.approvalId],
    )).rows;
    return { approvalId: asked.approvalId, requests };
  };
  const requestOf = (
    asked: Awaited<ReturnType<typeof ask>>,
    principalId = recipientId,
  ) => asked.requests.find((row) => row.recipient_id === principalId)!.id;
  const press = async (input: Press) => {
    const body = new URLSearchParams({
      payload: JSON.stringify({
        type: "block_actions",
        api_app_id: APP_ID,
        team: { id: TEAM_ID },
        user: { id: input.userId },
        channel: { id: DM },
        container: { message_ts: "1700000000.1" },
        response_url: "https://hooks.slack.com/actions/T0/1/abc",
        actions: [{
          action_id: input.action,
          block_id: "request",
          type: "button",
          value: input.requestId,
          action_ts: `17000000${Math.floor(Math.random() * 1e6)}.1`,
        }],
      }),
    }).toString();
    const seconds = Math.floor(Date.now() / 1000) -
      (input.signature === "old" ? 600 : 0);
    const timestamp = String(seconds);
    const headers = new Headers({
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": timestamp,
    });
    if (input.signature !== "missing") {
      headers.set(
        "x-slack-signature",
        await sign(
          timestamp,
          body,
          input.signature === "wrong" ? "not-the-secret" : SIGNING_SECRET,
        ),
      );
    }
    const response = await app.fetch(
      new Request(`${BASE_URL}${SLACK_INTERACTIONS_PATH}`, {
        method: "POST",
        headers,
        body,
      }),
    );
    await Promise.all(deferred.splice(0));
    return response;
  };
  const approval = async (
    approvalId: string,
    organizationId = f.organizationId,
  ) =>
    (await pg.query<
      { status: string; decision: string | null; decided_by: string | null }
    >(
      `select status, decision, decided_by from bakery.questions
        where organization_id = $1 and id = $2`,
      [organizationId, approvalId],
    )).rows[0]!;
  const decisions = async (approvalId: string) =>
    (await pg.query<{ kind: string; decided_by: string }>(
      `select kind, decided_by from bakery.decisions_ledger
        where subject_id = $1 and kind in ('approval', 'rejection')`,
      [approvalId],
    )).rows;
  const name = async (principalId: string) =>
    (await pg.query<{ name: string }>(
      "select display_name as name from bakery.principals where id = $1",
      [principalId],
    )).rows[0]!.name;
  const deliver = () =>
    sendDueRequestSlackMessages({ ...deps, now: new Date() });
  const sentTo = (path: string) =>
    gate.sent.filter((request) => request.path === path);
  const otherOrganization = async () => {
    await pg.query(
      `insert into bakery.organizations (id, name, slug, created_at, updated_at)
       values ($1, 'Other', $2, now(), now())`,
      [otherOrganizationId, `other-${otherOrganizationId}`],
    );
    await pg.query(
      `insert into bakery.organization_memberships
         (id, organization_id, principal_id, role, status, joined_at,
          created_at, updated_at, version)
       values ($1, $2, $3, 'developer', 'active', now(), now(), now(), 1),
              ($4, $2, $5, 'admin', 'active', now(), now(), now(), 1)`,
      [
        crypto.randomUUID(),
        otherOrganizationId,
        recipientId,
        crypto.randomUUID(),
        f.adminId,
      ],
    );
    const other = await seedTask(pg, otherOrganizationId, f.adminId);
    const otherRun = await seedRun({
      pgDatabase: pg,
      organizationId: otherOrganizationId,
      principalId: f.adminId,
      taskId: other.taskId,
    });
    return await ask(undefined, {
      organizationId: otherOrganizationId,
      runId: otherRun.runId,
      ...other,
    });
  };
  return {
    f,
    recipientId,
    secondId,
    strangerId,
    otherOrganizationId,
    link,
    ask,
    requestOf,
    press,
    approval,
    decisions,
    name,
    deliver,
    sentTo,
    otherOrganization,
    finish: async () => {
      try {
        for (const organizationId of [f.organizationId, otherOrganizationId]) {
          for (
            const table of [
              "external_identity_links",
              "person_request_deliveries",
              "run_power_grants",
              "person_requests",
              "decisions_ledger",
            ]
          ) {
            await pg.query(
              `delete from bakery.${table} where organization_id = $1`,
              [organizationId],
            );
          }
        }
        await cleanupAuthFixture(pg, extraEmails);
      } finally {
        await o.finish();
      }
    },
  };
}

type Ephemeral = { channel: string; user: string; text: string };

Deno.test("a press with a missing, wrong or old signature is refused and decides nothing", async () => {
  const w = await world();
  try {
    assert((await w.link(w.recipientId, RECIPIENT)).ok);
    const asked = await w.ask();
    for (const signature of ["missing", "wrong", "old"] as const) {
      const response = await w.press({
        requestId: w.requestOf(asked),
        action: "approve",
        userId: RECIPIENT,
        signature,
      });
      assertEquals(response.status, 401, signature);
      await response.body?.cancel();
    }
    assertEquals((await w.approval(asked.approvalId)).status, "open");
    assertEquals(await w.decisions(asked.approvalId), []);
    assertEquals(w.sentTo("/api/chat.postEphemeral"), []);
  } finally {
    await w.finish();
  }
});

Deno.test("an unlinked Slack user gets the not-linked note with a link button and nothing is decided", async () => {
  const w = await world();
  try {
    const asked = await w.ask();
    const response = await w.press({
      requestId: w.requestOf(asked),
      action: "approve",
      userId: STRANGER,
    });
    assertEquals(response.status, 200);
    assertEquals((await w.approval(asked.approvalId)).status, "open");
    const [note] = w.sentTo("/api/chat.postEphemeral");
    const body = note!.body as Ephemeral & {
      blocks: {
        type: string;
        elements?: { text: { text: string }; url: string }[];
      }[];
    };
    assertEquals([body.channel, body.user, body.text], [
      DM,
      STRANGER,
      SLACK_PRESS_NOT_LINKED,
    ]);
    const button = body.blocks[1]!.elements![0]!;
    assertEquals(button.text.text, "Link your account");
    assertEquals(
      button.url,
      `${BASE_URL}/settings/profile?organization=${w.f.organizationId}`,
    );
  } finally {
    await w.finish();
  }
});

Deno.test("a linked member the approval is not addressed to gets the no-permission note", async () => {
  const w = await world();
  try {
    assert((await w.link(w.strangerId, STRANGER)).ok);
    const asked = await w.ask();
    const response = await w.press({
      requestId: w.requestOf(asked),
      action: "approve",
      userId: STRANGER,
    });
    assertEquals(response.status, 200);
    assertEquals((await w.approval(asked.approvalId)).status, "open");
    assertEquals(await w.decisions(asked.approvalId), []);
    assertEquals(
      w.sentTo("/api/chat.postEphemeral").map((note) =>
        (note.body as Ephemeral).text
      ),
      [SLACK_PRESS_NO_PERMISSION],
    );
  } finally {
    await w.finish();
  }
});

Deno.test("Approve decides the request once as the linked person and rewrites the DM without buttons", async () => {
  const w = await world();
  try {
    assert((await w.link(w.recipientId, RECIPIENT)).ok);
    const asked = await w.ask();
    await w.deliver();
    const posted = w.sentTo("/api/chat.postMessage")[0]!.body as {
      blocks: { type: string; elements?: { action_id: string }[] }[];
    };
    assertEquals(
      posted.blocks[1]!.elements!.map((element) => element.action_id),
      ["approve", "reject", "open"],
    );
    const response = await w.press({
      requestId: w.requestOf(asked),
      action: "approve",
      userId: RECIPIENT,
    });
    assertEquals(response.status, 200);
    assertEquals(await w.approval(asked.approvalId), {
      status: "answered",
      decision: "approve",
      decided_by: w.recipientId,
    });
    assertEquals(await w.decisions(asked.approvalId), [
      { kind: "approval", decided_by: w.recipientId },
    ]);
    const updates = w.sentTo("/api/chat.update");
    assertEquals(updates.length, 1);
    const update = updates[0]!.body as {
      text: string;
      blocks: { type: string; elements?: { action_id: string }[] }[];
    };
    assert(
      update.text.startsWith(`*Handled by ${await w.name(w.recipientId)}*`),
      update.text,
    );
    assertEquals(
      update.blocks[1]!.elements!.map((element) => element.action_id),
      ["open"],
    );
    assertEquals(w.sentTo("/api/chat.postEphemeral"), []);
  } finally {
    await w.finish();
  }
});

Deno.test("Reject decides the request once and a second press is told it is already decided", async () => {
  const w = await world();
  try {
    assert((await w.link(w.recipientId, RECIPIENT)).ok);
    const asked = await w.ask();
    await w.deliver();
    const first = await w.press({
      requestId: w.requestOf(asked),
      action: "reject",
      userId: RECIPIENT,
    });
    assertEquals(first.status, 200);
    const second = await w.press({
      requestId: w.requestOf(asked),
      action: "approve",
      userId: RECIPIENT,
    });
    assertEquals(second.status, 200);
    assertEquals(await w.approval(asked.approvalId), {
      status: "answered",
      decision: "reject",
      decided_by: w.recipientId,
    });
    assertEquals(await w.decisions(asked.approvalId), [
      { kind: "rejection", decided_by: w.recipientId },
    ]);
    assertEquals(w.sentTo("/api/chat.update").length, 1);
    assertEquals(
      w.sentTo("/api/chat.postEphemeral").map((note) =>
        (note.body as Ephemeral).text
      ),
      [`Nothing changed. ${await w.name(w.recipientId)} already decided this.`],
    );
  } finally {
    await w.finish();
  }
});

Deno.test("when one of several approvers decides, another member's press names the first", async () => {
  const w = await world();
  try {
    assert((await w.link(w.recipientId, RECIPIENT)).ok);
    assert((await w.link(w.secondId, SECOND)).ok);
    const asked = await w.ask([w.recipientId, w.secondId]);
    assertEquals(asked.requests.length, 2);
    await w.deliver();
    assertEquals(w.sentTo("/api/chat.postMessage").length, 2);
    const first = await w.press({
      requestId: w.requestOf(asked, w.secondId),
      action: "approve",
      userId: SECOND,
    });
    assertEquals(first.status, 200);
    assertEquals(w.sentTo("/api/chat.update").length, 2);
    const late = await w.press({
      requestId: w.requestOf(asked),
      action: "approve",
      userId: RECIPIENT,
    });
    assertEquals(late.status, 200);
    assertEquals((await w.approval(asked.approvalId)).decided_by, w.secondId);
    assertEquals(await w.decisions(asked.approvalId), [
      { kind: "approval", decided_by: w.secondId },
    ]);
    assertEquals(w.sentTo("/api/chat.update").length, 2);
    assertEquals(
      w.sentTo("/api/chat.postEphemeral").map((note) =>
        (note.body as Ephemeral).text
      ),
      ["Nothing changed. Second Member already decided this."],
    );
  } finally {
    await w.finish();
  }
});

Deno.test("a press signed for this workspace cannot decide a request of another organization", async () => {
  const w = await world();
  try {
    assert((await w.link(w.recipientId, RECIPIENT)).ok);
    const foreign = await w.otherOrganization();
    const response = await w.press({
      requestId: w.requestOf(foreign),
      action: "approve",
      userId: RECIPIENT,
    });
    assertEquals(response.status, 200);
    assertEquals(
      (await w.approval(foreign.approvalId, w.otherOrganizationId)).status,
      "open",
    );
    assertEquals(await w.decisions(foreign.approvalId), []);
    assertEquals(
      w.sentTo("/api/chat.postEphemeral").map((note) =>
        (note.body as Ephemeral).text
      ),
      [SLACK_PRESS_NO_PERMISSION],
    );
  } finally {
    await w.finish();
  }
});

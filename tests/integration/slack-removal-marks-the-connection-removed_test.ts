import { assertEquals } from "@std/assert";
import { call } from "../helpers/installation-settings.ts";
import {
  APP_ID,
  connectOnce,
  fakeSlack,
  open,
  outcome,
  slackCallback,
  startAttempt,
  TEAM_ID,
} from "../helpers/slack-connect.ts";
import { postSlackEvent } from "../helpers/slack-events.ts";

const SIGNING_SECRET = "slack-signing-secret-one";
type Opened = Awaited<ReturnType<typeof open>>;

function removal(
  eventId: string,
  event: Record<string, unknown>,
  teamId = TEAM_ID,
  eventTime = Math.floor(Date.now() / 1000),
) {
  return {
    type: "event_callback",
    api_app_id: APP_ID,
    team_id: teamId,
    event_id: eventId,
    event_time: eventTime,
    event,
  };
}

async function send(o: Opened, payload: unknown) {
  const response = await postSlackEvent(o.fixture, SIGNING_SECRET, payload);
  const status = response.status;
  await response.body?.cancel();
  return status;
}

async function state(o: Opened, connectionId: string) {
  const row = (await o.fixture.pgDatabase.query<
    { status: string; problem: string | null }
  >(
    `select status, last_problem_code as problem
       from bakery.integration_connections
      where organization_id = $1 and id = $2`,
    [o.fixture.organizationId, connectionId],
  )).rows[0]!;
  const audits = (await o.fixture.pgDatabase.query<{ n: number }>(
    `select count(*)::int as n from bakery.audit_events
      where organization_id = $1 and resource_id = $2
        and operation = 'integrationConnections.providerRemoved'`,
    [o.fixture.organizationId, connectionId],
  )).rows[0]!.n;
  return { ...row, audits };
}

async function read(o: Opened, connectionId: string) {
  const response = await call(
    o.fixture,
    "GET",
    `/v1/integration-connections/${connectionId}`,
    o.fixture.adminCookie,
    { headers: { "Bakery-Organization-Id": o.fixture.organizationId } },
  );
  assertEquals(response.status, 200, await response.clone().text());
  return await response.json() as { status: string; removedBy: string | null };
}

Deno.test("Slack uninstalling the app marks the connection removed by Slack, once, with an audit", async () => {
  const o = await open(fakeSlack(), { signingSecret: SIGNING_SECRET });
  try {
    const connectionId = await connectOnce(o);
    assertEquals((await read(o, connectionId)).removedBy, null);
    const event = removal("EvUNINSTALL1", { type: "app_uninstalled" });
    assertEquals(await send(o, event), 200);
    assertEquals(await state(o, connectionId), {
      status: "revoked",
      problem: "provider_removed",
      audits: 1,
    });
    const removed = await read(o, connectionId);
    assertEquals([removed.status, removed.removedBy], ["revoked", "provider"]);
    assertEquals(await send(o, event), 401);
    assertEquals(await state(o, connectionId), {
      status: "revoked",
      problem: "provider_removed",
      audits: 1,
    });
  } finally {
    await o.finish();
  }
});

Deno.test("revoking another bot's token leaves the connection; revoking this bot's token removes it", async () => {
  const o = await open(fakeSlack(), { signingSecret: SIGNING_SECRET });
  try {
    const connectionId = await connectOnce(o);
    assertEquals(
      await send(
        o,
        removal("EvTOKENSOTHER", {
          type: "tokens_revoked",
          tokens: { oauth: ["U0SOMEONE"], bot: ["U0OTHERBOT"] },
        }),
      ),
      200,
    );
    assertEquals((await state(o, connectionId)).status, "enabled");
    assertEquals(
      await send(
        o,
        removal("EvTOKENSOURS", {
          type: "tokens_revoked",
          tokens: { bot: ["U0TESTBOT"] },
        }),
      ),
      200,
    );
    assertEquals((await state(o, connectionId)).status, "revoked");
  } finally {
    await o.finish();
  }
});

Deno.test("an uninstall for a workspace this installation does not hold changes nothing", async () => {
  const o = await open(fakeSlack(), { signingSecret: SIGNING_SECRET });
  try {
    const connectionId = await connectOnce(o);
    const status = await send(
      o,
      removal("EvFOREIGN1", { type: "app_uninstalled" }, "T0FOREIGN"),
    );
    assertEquals(status === 200, false);
    assertEquals(await state(o, connectionId), {
      status: "enabled",
      problem: null,
      audits: 0,
    });
  } finally {
    await o.finish();
  }
});

Deno.test("a check that Slack answers token_revoked records the connection as removed by Slack", async () => {
  const slack = fakeSlack();
  const o = await open(slack, { signingSecret: SIGNING_SECRET });
  try {
    const connectionId = await connectOnce(o);
    slack.answers.authTest = () =>
      Response.json({ ok: false, error: "token_revoked" });
    const response = await call(
      o.fixture,
      "POST",
      `/v1/integration-connections/${connectionId}/checks`,
      o.fixture.adminCookie,
      {
        body: {},
        headers: {
          "Bakery-Organization-Id": o.fixture.organizationId,
          "Idempotency-Key": crypto.randomUUID(),
        },
      },
    );
    assertEquals(response.status, 200, await response.clone().text());
    await response.body?.cancel();
    assertEquals((await state(o, connectionId)).problem, "provider_removed");
  } finally {
    await o.finish();
  }
});

Deno.test("a removal dated before the workspace connected again leaves the new connection", async () => {
  const o = await open(fakeSlack(), { signingSecret: SIGNING_SECRET });
  try {
    const connectionId = await connectOnce(o);
    const uninstalledAt = Math.floor(Date.now() / 1000);
    assertEquals(
      await send(
        o,
        removal("EvLATE1", { type: "app_uninstalled" }, TEAM_ID, uninstalledAt),
      ),
      200,
    );
    assertEquals((await state(o, connectionId)).status, "revoked");
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const attempt = await startAttempt(o.fixture);
    const again = await slackCallback(o.fixture, {
      code: "slack-code-again",
      state: attempt.url.searchParams.get("state")!,
    });
    assertEquals(outcome(again), "refreshed");
    assertEquals((await state(o, connectionId)).status, "enabled");
    assertEquals(
      await send(
        o,
        removal(
          "EvLATE2",
          { type: "tokens_revoked", tokens: { bot: ["U0TESTBOT"] } },
          TEAM_ID,
          uninstalledAt,
        ),
      ),
      200,
    );
    assertEquals((await state(o, connectionId)).status, "enabled");
  } finally {
    await o.finish();
  }
});

Deno.test("a connection the provider's installation removal revoked reads removed by the provider", async () => {
  const o = await open(fakeSlack(), { signingSecret: SIGNING_SECRET });
  try {
    const connectionId = await connectOnce(o);
    await o.fixture.pgDatabase.query(
      `update bakery.integration_connections
          set status = 'revoked', last_problem_code = 'installation_revoked'
        where organization_id = $1 and id = $2`,
      [o.fixture.organizationId, connectionId],
    );
    assertEquals((await read(o, connectionId)).removedBy, "provider");
    await o.fixture.pgDatabase.query(
      `update bakery.integration_connections set last_problem_code = null
        where organization_id = $1 and id = $2`,
      [o.fixture.organizationId, connectionId],
    );
    assertEquals((await read(o, connectionId)).removedBy, "admin");
  } finally {
    await o.finish();
  }
});

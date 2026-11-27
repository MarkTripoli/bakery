import { assertEquals } from "@std/assert";
import { call } from "../helpers/installation-settings.ts";
import {
  connectOnce,
  fakeSlack,
  open,
  outcome,
  slackCallback,
} from "../helpers/slack-connect.ts";
import { SLACK_BOT_SCOPES } from "../../packages/integration-slack/src/server/provider.ts";

type Opened = Awaited<ReturnType<typeof open>>;

async function read(o: Opened, connectionId: string) {
  const response = await call(
    o.fixture,
    "GET",
    `/v1/integration-connections/${connectionId}`,
    o.fixture.adminCookie,
    { headers: { "Bakery-Organization-Id": o.fixture.organizationId } },
  );
  assertEquals(response.status, 200, await response.clone().text());
  return await response.json() as {
    status: string;
    health: string;
    grantedScopeNames: string[] | null;
  };
}

async function check(o: Opened, connectionId: string) {
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
}

async function reconnect(o: Opened, connectionId: string) {
  const response = await call(
    o.fixture,
    "POST",
    "/v1/integration-auth-attempts",
    o.fixture.adminCookie,
    {
      body: { provider: "slack", reconnectConnectionId: connectionId },
      headers: {
        "Bakery-Organization-Id": o.fixture.organizationId,
        "Idempotency-Key": crypto.randomUUID(),
      },
    },
  );
  assertEquals(response.status, 201, await response.clone().text());
  const created = await response.json() as { authorizationUrl: string };
  return outcome(
    await slackCallback(o.fixture, {
      code: "slack-code-reconnect",
      state: new URL(created.authorizationUrl).searchParams.get("state")!,
    }),
  );
}

const [missingScope, ...keptScopes] = SLACK_BOT_SCOPES;

Deno.test("a Slack connection reads back its health and the exact scope names Slack granted", async () => {
  const slack = fakeSlack();
  const o = await open(slack);
  try {
    const connectionId = await connectOnce(o);
    const connected = await read(o, connectionId);
    assertEquals(
      [connected.status, connected.health, connected.grantedScopeNames],
      ["enabled", "unknown", [...SLACK_BOT_SCOPES]],
    );
    await check(o, connectionId);
    assertEquals((await read(o, connectionId)).health, "healthy");
  } finally {
    await o.finish();
  }
});

Deno.test("a Slack connect missing a requested scope reads degraded, and a healthy check keeps it degraded until a full reconnect", async () => {
  const slack = fakeSlack({
    tokenResponse: { scope: keptScopes.join(",") },
  });
  const o = await open(slack);
  try {
    const connectionId = await connectOnce(o);
    const limited = await read(o, connectionId);
    assertEquals(
      [limited.status, limited.health, limited.grantedScopeNames],
      ["enabled", "degraded", keptScopes],
    );
    await check(o, connectionId);
    assertEquals((await read(o, connectionId)).health, "degraded");
    slack.answers.authTest = () => new Response(null, { status: 503 });
    await check(o, connectionId);
    slack.answers.authTest = null;
    await check(o, connectionId);
    assertEquals((await read(o, connectionId)).health, "degraded");
    slack.answers.authTest = () =>
      Response.json({ ok: false, error: "invalid_auth" });
    await check(o, connectionId);
    assertEquals((await read(o, connectionId)).health, "auth_required");
    slack.answers.authTest = null;
    await check(o, connectionId);
    assertEquals((await read(o, connectionId)).health, "degraded");
    const link = await call(
      o.fixture,
      "GET",
      "/v1/me/slack-link",
      o.fixture.adminCookie,
      { headers: { "Bakery-Organization-Id": o.fixture.organizationId } },
    );
    const linkBody = await link.json() as Record<string, unknown>;
    assertEquals(
      JSON.stringify(linkBody).includes("not_working"),
      false,
      JSON.stringify(linkBody),
    );
    slack.answers.tokenResponse = {};
    assertEquals(await reconnect(o, connectionId), "refreshed");
    await check(o, connectionId);
    const full = await read(o, connectionId);
    assertEquals(
      [full.health, full.grantedScopeNames],
      ["healthy", [missingScope, ...keptScopes]],
    );
  } finally {
    await o.finish();
  }
});

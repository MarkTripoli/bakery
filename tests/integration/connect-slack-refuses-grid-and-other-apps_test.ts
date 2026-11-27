import { assertEquals } from "@std/assert";
import { call } from "../helpers/installation-settings.ts";
import {
  connectOnce,
  fakeSlack,
  open,
  outcome,
  slackCallback,
  startAttempt,
} from "../helpers/slack-connect.ts";

async function slackRows(o: Awaited<ReturnType<typeof open>>) {
  return (await o.fixture.pgDatabase.query<
    { connections: number; installations: number; secrets: number }
  >(
    `select
       (select count(*)::int from bakery.integration_connections
         where provider = 'slack') as connections,
       (select count(*)::int from bakery.integration_installations
         where provider = 'slack') as installations,
       (select count(*)::int from bakery.slack_installations) as secrets`,
  )).rows[0]!;
}

async function connectAttempt(o: Awaited<ReturnType<typeof open>>) {
  const attempt = await startAttempt(o.fixture);
  return await slackCallback(o.fixture, {
    code: "slack-code-refused",
    state: attempt.url.searchParams.get("state")!,
  });
}

Deno.test("an install for a whole Enterprise Grid organization is refused and stores nothing", async () => {
  const slack = fakeSlack({
    tokenResponse: {
      is_enterprise_install: true,
      team: null,
      enterprise: { id: "E0TESTGRID", name: "Test Grid" },
    },
  });
  const o = await open(slack);
  try {
    assertEquals(outcome(await connectAttempt(o)), "enterprise_install");
    assertEquals(await slackRows(o), {
      connections: 0,
      installations: 0,
      secrets: 0,
    });
  } finally {
    await o.finish();
  }
});

Deno.test("a workspace still connected through another Slack app refuses a second app and stores nothing", async () => {
  const slack = fakeSlack();
  const o = await open(slack);
  try {
    await connectOnce(o);
    const before = await slackRows(o);
    slack.answers.tokenResponse = { app_id: "A0OTHERAPP" };
    assertEquals(outcome(await connectAttempt(o)), "wrong_app");
    assertEquals(await slackRows(o), before);
  } finally {
    await o.finish();
  }
});

Deno.test("after its connection is removed, the workspace connects through a replacement Slack app", async () => {
  const slack = fakeSlack();
  const o = await open(slack);
  try {
    const connectionId = await connectOnce(o);
    const headers = { "Bakery-Organization-Id": o.fixture.organizationId };
    const current = await call(
      o.fixture,
      "GET",
      `/v1/integration-connections/${connectionId}`,
      o.fixture.adminCookie,
      { headers },
    );
    const { version } = await current.json() as { version: number };
    const removed = await call(
      o.fixture,
      "POST",
      `/v1/integration-connections/${connectionId}/removal`,
      o.fixture.adminCookie,
      {
        headers: {
          ...headers,
          "If-Match": `"${version}"`,
          "Idempotency-Key": crypto.randomUUID(),
        },
      },
    );
    assertEquals(removed.status, 200, await removed.clone().text());
    slack.answers.tokenResponse = { app_id: "A0OTHERAPP" };
    assertEquals(outcome(await connectAttempt(o)), "refreshed");
  } finally {
    await o.finish();
  }
});

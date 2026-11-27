import { assertEquals } from "@std/assert";
import { call } from "../helpers/installation-settings.ts";
import { connectOnce, fakeSlack, open } from "../helpers/slack-connect.ts";

async function check(
  o: Awaited<ReturnType<typeof open>>,
  connectionId: string,
) {
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
  return await response.json() as { health: string; healthy: boolean };
}

async function stored(
  o: Awaited<ReturnType<typeof open>>,
  connectionId: string,
) {
  return (await o.fixture.pgDatabase.query<{
    health: string;
    last_problem_code: string | null;
    checked: boolean;
  }>(
    `select health, last_problem_code, last_checked_at is not null as checked
       from bakery.integration_connections
      where organization_id = $1 and id = $2`,
    [o.fixture.organizationId, connectionId],
  )).rows[0]!;
}

Deno.test("checking a Slack connection asks Slack who the bot is and records it working", async () => {
  const slack = fakeSlack();
  const o = await open(slack);
  try {
    const connectionId = await connectOnce(o);
    const before = slack.calls.length;
    const result = await check(o, connectionId);
    assertEquals([result.health, result.healthy], ["healthy", true]);
    assertEquals(
      slack.calls.slice(before).map((entry) => entry.url),
      ["https://slack.com/api/auth.test"],
    );
    assertEquals(await stored(o, connectionId), {
      health: "healthy",
      last_problem_code: null,
      checked: true,
    });
  } finally {
    await o.finish();
  }
});

Deno.test("a Slack token Slack refuses makes the connection need signing in again", async () => {
  const slack = fakeSlack();
  const o = await open(slack);
  try {
    const connectionId = await connectOnce(o);
    slack.issued.token = "xoxb-a-different-token";
    const result = await check(o, connectionId);
    assertEquals([result.health, result.healthy], ["auth_required", false]);
    assertEquals(await stored(o, connectionId), {
      health: "auth_required",
      last_problem_code: "token_rejected",
      checked: true,
    });
  } finally {
    await o.finish();
  }
});

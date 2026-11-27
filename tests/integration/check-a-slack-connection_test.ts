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

async function checkResponse(
  o: Awaited<ReturnType<typeof open>>,
  connectionId: string,
) {
  return await call(
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
}

Deno.test("a Slack error page or empty answer is an outage: health stays, the fault is redacted", async () => {
  const slack = fakeSlack();
  const o = await open(slack);
  try {
    const connectionId = await connectOnce(o);
    for (
      const answer of [
        () =>
          new Response("<html>Service Unavailable</html>", {
            status: 503,
            headers: { "content-type": "text/html" },
          }),
        () => new Response(null, { status: 502 }),
      ]
    ) {
      slack.answers.authTest = answer;
      const response = await checkResponse(o, connectionId);
      assertEquals(response.status, 200, await response.clone().text());
      const body = await response.json() as {
        healthy: boolean;
        fault: { code: string } | null;
      };
      assertEquals(body.healthy, false);
      assertEquals(body.fault?.code, "DEPENDENCY_UNAVAILABLE");
      assertEquals(
        (await stored(o, connectionId)).last_problem_code,
        "dependency_unavailable",
      );
    }
  } finally {
    await o.finish();
  }
});

Deno.test("an inactive account or an expired token asks to sign in again", async () => {
  for (const error of ["account_inactive", "token_expired"]) {
    const slack = fakeSlack();
    const o = await open(slack);
    try {
      const connectionId = await connectOnce(o);
      slack.answers.authTest = () => Response.json({ ok: false, error });
      const result = await check(o, connectionId);
      assertEquals(
        [result.health, result.healthy],
        ["auth_required", false],
        error,
      );
    } finally {
      await o.finish();
    }
  }
});

Deno.test("a Slack rate limit records its wait, and the next check waits without calling Slack", async () => {
  const slack = fakeSlack();
  const o = await open(slack);
  try {
    const connectionId = await connectOnce(o);
    slack.answers.authTest = () =>
      new Response(JSON.stringify({ ok: false, error: "ratelimited" }), {
        status: 429,
        headers: { "retry-after": "120", "content-type": "application/json" },
      });
    const limited = await checkResponse(o, connectionId);
    assertEquals(limited.status, 429, await limited.clone().text());
    await limited.body?.cancel();
    const waited = await o.fixture.pgDatabase.query<{ seconds: number }>(
      `select extract(epoch from next_allowed_at - now())::int as seconds
         from bakery.integration_connections
        where organization_id = $1 and id = $2`,
      [o.fixture.organizationId, connectionId],
    );
    const seconds = waited.rows[0]!.seconds;
    assertEquals(seconds > 100 && seconds <= 120, true, String(seconds));
    const before = slack.calls.length;
    const again = await checkResponse(o, connectionId);
    assertEquals(again.status, 429);
    await again.body?.cancel();
    assertEquals(slack.calls.length, before);
  } finally {
    await o.finish();
  }
});

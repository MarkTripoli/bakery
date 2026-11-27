import { assertEquals } from "@std/assert";
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

Deno.test("a token for a different Slack app than the installation uses is refused and stores nothing", async () => {
  const slack = fakeSlack();
  const o = await open(slack);
  try {
    await connectOnce(o);
    const before = await slackRows(o);
    slack.answer.tokenResponse = { app_id: "A0OTHERAPP" };
    const refused = await connectAttempt(o);
    assertEquals(outcome(refused), "wrong_app");
    assertEquals(await slackRows(o), before);
  } finally {
    await o.finish();
  }
});

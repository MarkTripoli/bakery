import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { call } from "../helpers/installation-settings.ts";
import {
  APP_ID,
  BOT_TOKEN,
  CLIENT_SECRET,
  connectOnce,
  fakeSlack,
  open,
  outcome,
  slackCallback,
  TEAM_ID,
} from "../helpers/slack-connect.ts";
import { openInstallationSecret } from "../../apps/server/src/modules/secrets/installation-secrets.ts";

const SIGNING_SECRET = "slack-signing-secret-one";
const NEXT_SIGNING_SECRET = "slack-signing-secret-two";
const encoder = new TextEncoder();

type Opened = Awaited<ReturnType<typeof open>>;

type Credentials = {
  configured: boolean;
  clientSecretSavedAt: string | null;
  signingSecretSavedAt: string | null;
  version: number;
};

async function readCredentials(o: Opened): Promise<Credentials> {
  const response = await call(
    o.fixture,
    "GET",
    "/v1/integration-client-credentials/slack",
    o.fixture.adminCookie,
  );
  assertEquals(response.status, 200, await response.clone().text());
  const text = await response.text();
  assert(!text.includes(SIGNING_SECRET));
  assert(!text.includes(NEXT_SIGNING_SECRET));
  return JSON.parse(text) as Credentials;
}

function saveCredentials(
  o: Opened,
  body: Record<string, string>,
  version?: number,
) {
  return call(
    o.fixture,
    "PUT",
    "/v1/integration-client-credentials/slack",
    o.fixture.adminCookie,
    {
      body: { clientId: "1234.5678", clientSecret: CLIENT_SECRET, ...body },
      headers: {
        "Idempotency-Key": crypto.randomUUID(),
        ...(version === undefined ? {} : { "If-Match": `"${version}"` }),
      },
    },
  );
}

async function signingSecretRow(o: Opened) {
  return (await o.fixture.pgDatabase.query<{
    secret_id: string | null;
    revision: number | null;
    versions: number;
  }>(
    `select registration.webhook_secret_id as secret_id,
            secret.active_version_revision as revision,
            (select count(*)::int from bakery.secret_versions version
              where version.secret_id = registration.webhook_secret_id)
              as versions
       from bakery.integration_app_registrations registration
       left join bakery.secrets secret
         on secret.id = registration.webhook_secret_id
      where registration.provider = 'slack'`,
  )).rows[0]!;
}

async function installations(o: Opened) {
  return (await o.fixture.pgDatabase.query<{
    organization_id: string;
    team_id: string;
    bot_user_id: string;
    signing_secret_id: string | null;
    status: string;
  }>(
    `select organization_id, team_id, bot_user_id, signing_secret_id, status
       from bakery.slack_installations where app_id = $1`,
    [APP_ID],
  )).rows;
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
  return await slackCallback(o.fixture, {
    code: "slack-code-reconnect",
    state: new URL(created.authorizationUrl).searchParams.get("state")!,
  });
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

async function postEvent(o: Opened, secret: string): Promise<Response> {
  const body = JSON.stringify({
    type: "event_callback",
    event_id: `Ev${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`,
    api_app_id: APP_ID,
    team_id: TEAM_ID,
    authorizations: [{ team_id: TEAM_ID, user_id: "U0TESTBOT" }],
    event: {
      type: "app_mention",
      channel: "C0TESTCHAN",
      user: "U0TESTUSER",
      ts: "1800000000.000100",
      text: "<@U0TESTBOT> hello",
    },
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  return await o.fixture.app.fetch(
    new Request(
      `${o.fixture.config.publicBaseUrl}/v1/webhooks/slack/events`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-slack-request-timestamp": timestamp,
          "x-slack-signature": await sign(timestamp, body, secret),
        },
        body,
      },
    ),
  );
}

Deno.test("the Slack signing secret is sealed with the app registration, replaced as the next revision and kept when left out", async () => {
  const o = await open(fakeSlack(), { signingSecret: SIGNING_SECRET });
  try {
    const first = await readCredentials(o);
    assert(first.signingSecretSavedAt !== null);
    const saved = await signingSecretRow(o);
    assert(saved.secret_id !== null);
    assertEquals(saved.revision, 1);
    assertEquals(
      await openInstallationSecret(
        o.fixture.pgDatabase,
        o.secretsKey,
        saved.secret_id,
      ),
      SIGNING_SECRET,
    );
    const raw = await o.fixture.pgDatabase.query<{ text: string }>(
      `select encode(ciphertext, 'escape') as text from bakery.secret_versions
        where secret_id = $1`,
      [saved.secret_id],
    );
    assert(!raw.rows[0]!.text.includes(SIGNING_SECRET));

    const missingVersion = await saveCredentials(o, {
      signingSecret: NEXT_SIGNING_SECRET,
    });
    assertEquals(missingVersion.status, 428);
    const stale = await saveCredentials(
      o,
      { signingSecret: NEXT_SIGNING_SECRET },
      first.version + 5,
    );
    assertEquals(stale.status, 412);
    assertEquals(await signingSecretRow(o), saved);

    const replaced = await saveCredentials(
      o,
      { signingSecret: NEXT_SIGNING_SECRET },
      first.version,
    );
    assertEquals(replaced.status, 200, await replaced.clone().text());
    const replacedText = await replaced.text();
    assert(!replacedText.includes(NEXT_SIGNING_SECRET));
    const afterReplace = await signingSecretRow(o);
    assertEquals(afterReplace.secret_id, saved.secret_id);
    assertEquals(afterReplace.revision, 2);
    assertEquals(afterReplace.versions, 2);
    assertEquals(
      await openInstallationSecret(
        o.fixture.pgDatabase,
        o.secretsKey,
        saved.secret_id,
      ),
      NEXT_SIGNING_SECRET,
    );

    const second = await readCredentials(o);
    const kept = await saveCredentials(o, {}, second.version);
    assertEquals(kept.status, 200, await kept.clone().text());
    assertEquals(await signingSecretRow(o), afterReplace);
    assertEquals(
      (await readCredentials(o)).signingSecretSavedAt,
      second.signingSecretSavedAt,
    );

    const audits = await o.fixture.pgDatabase.query<{ details: string }>(
      `select details::text from bakery.audit_events
        where operation = 'integrationClientCredentials.put'
          and details ->> 'provider' = 'slack'
        order by created_at`,
    );
    assertEquals(audits.rows.length, 3);
    for (const row of audits.rows) {
      assert(!row.details.includes(SIGNING_SECRET));
      assert(!row.details.includes(NEXT_SIGNING_SECRET));
    }
    assertEquals(
      audits.rows.map((row) => {
        const details = JSON.parse(row.details);
        return [details.signingSecretReplaced, details.signingSecretRevision];
      }),
      [[true, 1], [true, 2], [false, 2]],
    );
  } finally {
    await o.finish();
  }
});

Deno.test("a provider that declares no signing secret refuses one and stores nothing", async () => {
  const o = await open(fakeSlack());
  try {
    const response = await call(
      o.fixture,
      "PUT",
      "/v1/integration-client-credentials/linear",
      o.fixture.adminCookie,
      {
        body: {
          clientId: "linear-client",
          clientSecret: "linear-secret",
          signingSecret: SIGNING_SECRET,
        },
        headers: { "Idempotency-Key": crypto.randomUUID() },
      },
    );
    assertEquals(response.status, 422, await response.clone().text());
    const stored = await o.fixture.pgDatabase.query<{ n: number }>(
      `select count(*)::int as n from bakery.integration_app_registrations
        where provider = 'linear'`,
    );
    assertEquals(stored.rows[0]!.n, 0);
  } finally {
    await o.fixture.pgDatabase.query(
      "delete from bakery.audit_events where details ->> 'provider' = 'linear'",
    );
    await o.finish();
  }
});

Deno.test("connecting Slack records the installation with the saved signing secret, and a reconnect updates it without a second row", async () => {
  const o = await open(fakeSlack());
  try {
    const connectionId = await connectOnce(o);
    const unsigned = await installations(o);
    assertEquals(unsigned, [{
      organization_id: o.fixture.organizationId,
      team_id: TEAM_ID,
      bot_user_id: "U0TESTBOT",
      signing_secret_id: null,
      status: "active",
    }]);

    const before = await readCredentials(o);
    const saved = await saveCredentials(
      o,
      { signingSecret: SIGNING_SECRET },
      before.version,
    );
    assertEquals(saved.status, 200, await saved.clone().text());
    const secret = await signingSecretRow(o);
    assertEquals(outcome(await reconnect(o, connectionId)), "refreshed");
    const signed = await installations(o);
    assertEquals(signed.length, 1);
    assertEquals(signed[0]!.signing_secret_id, secret.secret_id);

    assertEquals(outcome(await reconnect(o, connectionId)), "refreshed");
    assertEquals(await installations(o), signed);

    const audits = await o.fixture.pgDatabase.query<{ details: string }>(
      `select details::text from bakery.audit_events
        where operation = 'integrationAuth.providerCallback'
          and resource_id = $1
        order by created_at`,
      [connectionId],
    );
    assertEquals(
      audits.rows.map((row) => {
        const details = JSON.parse(row.details);
        return [details.signedEvents, details.signingSecretSaved];
      }),
      [["recorded", false], ["recorded", true], ["recorded", true]],
    );
    for (const row of audits.rows) {
      assert(!row.details.includes(SIGNING_SECRET));
      assert(!row.details.includes(BOT_TOKEN));
    }
  } finally {
    await o.finish();
  }
});

Deno.test("a workspace another organization already holds still connects, and the claim is recorded instead", async () => {
  const o = await open(fakeSlack(), { signingSecret: SIGNING_SECRET });
  const otherId = crypto.randomUUID();
  try {
    await o.fixture.pgDatabase.query(
      `insert into bakery.organizations (id, name, slug, metadata, created_at,
         updated_at, version)
       values ($1, 'Other', $2, '{}'::jsonb, now(), now(), 1)`,
      [otherId, `other-${otherId}`],
    );
    await o.fixture.pgDatabase.query(
      `insert into bakery.slack_installations (
         id, organization_id, app_id, team_id, bot_user_id, status)
       values ($1, $2, $3, $4, 'U0OTHERBOT', 'active')`,
      [crypto.randomUUID(), otherId, APP_ID, TEAM_ID],
    );
    const connectionId = await connectOnce(o);
    const rows = await installations(o);
    assertEquals(rows.length, 1);
    assertEquals(rows[0]!.organization_id, otherId);
    assertEquals(rows[0]!.signing_secret_id, null);
    const audit = await o.fixture.pgDatabase.query<{ details: string }>(
      `select details::text from bakery.audit_events
        where operation = 'integrationAuth.providerCallback'
          and resource_id = $1`,
      [connectionId],
    );
    assertEquals(
      JSON.parse(audit.rows[0]!.details).signedEvents,
      "claimed_elsewhere",
    );
  } finally {
    await o.finish();
    await o.fixture.pgDatabase.query(
      "delete from bakery.organizations where id = $1",
      [otherId],
    ).catch(() => undefined);
  }
});

Deno.test("after a real connect the events intake accepts an event signed with the saved secret and refuses any other", async () => {
  const o = await open(fakeSlack(), { signingSecret: SIGNING_SECRET });
  try {
    await connectOnce(o);
    const accepted = await postEvent(o, SIGNING_SECRET);
    assertEquals(accepted.status, 200, await accepted.clone().text());
    const refused = await postEvent(o, "some-other-signing-secret");
    assertNotEquals(refused.status, 200);
    assertEquals(refused.status, 401, await refused.clone().text());

    const current = await readCredentials(o);
    const replaced = await saveCredentials(
      o,
      { signingSecret: NEXT_SIGNING_SECRET },
      current.version,
    );
    assertEquals(replaced.status, 200, await replaced.clone().text());
    assertEquals((await postEvent(o, NEXT_SIGNING_SECRET)).status, 200);
    assertEquals((await postEvent(o, SIGNING_SECRET)).status, 401);
  } finally {
    await o.finish();
  }
});

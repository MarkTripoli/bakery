import { assert, assertEquals } from "@std/assert";
import {
  call,
  openInstallationFixture,
} from "../helpers/installation-settings.ts";
import { pkceChallenge } from "../../apps/server/src/modules/integrations/auth-attempts.ts";
import { decodeSecretSlots } from "../../apps/server/src/modules/integrations/provider-credential-port.ts";
import { openInstallationSecret } from "../../apps/server/src/modules/secrets/installation-secrets.ts";
import { SLACK_BOT_SCOPES } from "../../packages/integration-slack/src/server/provider.ts";

const BOT_TOKEN = "xoxb-test-bot-token";
const CLIENT_SECRET = "slack-client-secret-one";
const TEAM_ID = "T0TESTTEAM";

type SlackCall = { url: string; body: string; authorization: string | null };

function fakeSlack(options: { tokenOk?: boolean } = {}) {
  const calls: SlackCall[] = [];
  const issued = { token: BOT_TOKEN };
  const respond = (input: URL, init: RequestInit): Response => {
    const headers = new Headers(init.headers);
    const body = init.body instanceof URLSearchParams
      ? init.body.toString()
      : init.body === undefined || init.body === null
      ? ""
      : new TextDecoder().decode(init.body as Uint8Array);
    calls.push({
      url: input.href,
      body,
      authorization: headers.get("authorization"),
    });
    if (input.href === "https://slack.com/api/oauth.v2.access") {
      if (options.tokenOk === false) {
        return Response.json({ ok: false, error: "invalid_code" });
      }
      return Response.json({
        ok: true,
        access_token: issued.token,
        token_type: "bot",
        scope: SLACK_BOT_SCOPES.join(","),
        bot_user_id: "U0TESTBOT",
        app_id: "A0TESTAPP",
        team: { id: TEAM_ID, name: "Test Workspace" },
        enterprise: null,
        authed_user: { id: "U0TESTUSER" },
      });
    }
    if (input.href === "https://slack.com/api/auth.test") {
      return Response.json({
        ok: headers.get("authorization") === `Bearer ${issued.token}`,
        team_id: TEAM_ID,
        team: "Test Workspace",
        bot_id: "B0TESTBOT",
      });
    }
    return new Response("not found", { status: 404 });
  };
  const fetch = (input: URL, init: RequestInit) =>
    Promise.resolve(respond(input, init));
  return { calls, fetch, issued };
}

async function open(slack: ReturnType<typeof fakeSlack>) {
  const directory = await Deno.makeTempDir({ prefix: "bakery-slack-connect-" });
  const file = `${directory}/key`;
  await Deno.writeFile(file, crypto.getRandomValues(new Uint8Array(32)), {
    mode: 0o600,
  });
  const secretsKey = { file, keyId: "slack-connect-key-v1" };
  const fixture = await openInstallationFixture(true, {
    secretsKey,
    oauth2Fetch: slack.fetch,
  });
  await clear(fixture);
  const saved = await call(
    fixture,
    "PUT",
    "/v1/integration-client-credentials/slack",
    fixture.adminCookie,
    {
      body: { clientId: "1234.5678", clientSecret: CLIENT_SECRET },
      headers: { "Idempotency-Key": crypto.randomUUID() },
    },
  );
  assertEquals(saved.status, 200, await saved.clone().text());
  return {
    fixture,
    secretsKey,
    finish: async () => {
      try {
        await clear(fixture);
      } finally {
        try {
          await fixture.finish();
        } finally {
          await Deno.remove(directory, { recursive: true });
        }
      }
    },
  };
}

type Fixture = Awaited<ReturnType<typeof openInstallationFixture>>;

async function clear(fixture: Fixture) {
  const pg = fixture.pgDatabase;
  await pg.query(
    "delete from bakery.integration_auth_attempts where provider = 'slack'",
  );
  await pg.query(
    "delete from bakery.integration_connections where provider = 'slack'",
  );
  await pg.query(
    "delete from bakery.integration_installations where provider = 'slack'",
  );
  await pg.query(
    "delete from bakery.integration_app_registrations where provider = 'slack'",
  );
  await pg.query(
    "update bakery.secrets set active_version_id = null where provider = 'slack'",
  );
  await pg.query(
    `delete from bakery.secret_versions where secret_id in
       (select id from bakery.secrets where provider = 'slack')`,
  );
  await pg.query("delete from bakery.secrets where provider = 'slack'");
}

async function startAttempt(fixture: Fixture) {
  const response = await call(
    fixture,
    "POST",
    "/v1/integration-auth-attempts",
    fixture.adminCookie,
    {
      body: { provider: "slack" },
      headers: {
        "Bakery-Organization-Id": fixture.organizationId,
        "Idempotency-Key": crypto.randomUUID(),
      },
    },
  );
  assertEquals(response.status, 201, await response.clone().text());
  const created = await response.json() as {
    id: string;
    authorizationUrl: string;
    installationUrl?: string;
  };
  return { ...created, url: new URL(created.authorizationUrl) };
}

function slackCallback(fixture: Fixture, query: Record<string, string>) {
  return call(
    fixture,
    "GET",
    `/v1/integration-auth/slack/callback?${new URLSearchParams(query)}`,
    fixture.adminCookie,
  );
}

Deno.test("connecting Slack sends the admin to Slack's authorize page with the bot scopes and this callback", async () => {
  const slack = fakeSlack();
  const o = await open(slack);
  try {
    const attempt = await startAttempt(o.fixture);
    assertEquals(attempt.installationUrl, undefined);
    assertEquals(
      `${attempt.url.origin}${attempt.url.pathname}`,
      "https://slack.com/oauth/v2/authorize",
    );
    const query = attempt.url.searchParams;
    assertEquals(query.get("client_id"), "1234.5678");
    assertEquals(query.get("scope"), SLACK_BOT_SCOPES.join(","));
    assert(
      query.get("redirect_uri")!.endsWith(
        "/v1/integration-auth/slack/callback",
      ),
    );
    assertEquals(query.get("code_challenge_method"), "S256");
    assert((query.get("state") ?? "").length >= 43);
    assertEquals(slack.calls.length, 0);
  } finally {
    await o.finish();
  }
});

Deno.test("the Slack callback stores the bot token sealed and enables one connection for the workspace", async () => {
  const slack = fakeSlack();
  const o = await open(slack);
  try {
    const attempt = await startAttempt(o.fixture);
    const state = attempt.url.searchParams.get("state")!;
    const response = await slackCallback(o.fixture, {
      code: "slack-code-1",
      state,
    });
    assertEquals(response.status, 303);
    const location = new URL(response.headers.get("location")!, "https://x");
    assertEquals(location.searchParams.get("slackConnection"), "connected");
    const connectionId = location.searchParams.get("connectionId")!;

    const exchange = new URLSearchParams(slack.calls[0]!.body);
    assertEquals(slack.calls[0]!.url, "https://slack.com/api/oauth.v2.access");
    assertEquals(exchange.get("code"), "slack-code-1");
    assertEquals(exchange.get("client_secret"), CLIENT_SECRET);
    assertEquals(
      await pkceChallenge(exchange.get("code_verifier")!),
      attempt.url.searchParams.get("code_challenge"),
    );
    assertEquals(slack.calls[1]!.url, "https://slack.com/api/auth.test");
    assertEquals(slack.calls[1]!.authorization, `Bearer ${BOT_TOKEN}`);

    const pg = o.fixture.pgDatabase;
    const connection = (await pg.query<{
      organization_id: string;
      status: string;
      external_account_id: string;
      label: string;
      secret_id: string;
    }>(
      `select connection.organization_id, connection.status,
         connection.external_account_id, connection.label,
         installation.credential_secret_id as secret_id
         from bakery.integration_connections connection
         join bakery.integration_installations installation
           on installation.id = connection.installation_id
        where connection.id = $1 and connection.provider = 'slack'`,
      [connectionId],
    )).rows[0]!;
    assertEquals(connection.organization_id, o.fixture.organizationId);
    assertEquals(connection.status, "enabled");
    assertEquals(connection.external_account_id, TEAM_ID);
    assertEquals(connection.label, "Test Workspace");

    const stored = await openInstallationSecret(
      pg,
      o.secretsKey,
      connection.secret_id,
    );
    const slots = decodeSecretSlots(stored, ["access_token"]);
    assertEquals(new TextDecoder().decode(slots.access_token), BOT_TOKEN);
    const raw = await pg.query<{ text: string }>(
      `select encode(ciphertext, 'escape') as text from bakery.secret_versions
        where secret_id = $1`,
      [connection.secret_id],
    );
    assert(!raw.rows[0]!.text.includes(BOT_TOKEN));

    const attemptRow = (await pg.query<{
      status: string;
      result_connection_id: string;
    }>(
      `select status, result_connection_id from bakery.integration_auth_attempts
        where id = $1`,
      [attempt.id],
    )).rows[0]!;
    assertEquals(attemptRow, {
      status: "completed",
      result_connection_id: connectionId,
    });
    const audits = await pg.query<{ details: string }>(
      `select details::text from bakery.audit_events
        where operation = 'integrationAuth.providerCallback'
          and resource_id = $1`,
      [connectionId],
    );
    assertEquals(audits.rows.length, 1);
    assert(!audits.rows[0]!.details.includes(BOT_TOKEN));
    assert(!audits.rows[0]!.details.includes(CLIENT_SECRET));

    const replay = await slackCallback(o.fixture, {
      code: "slack-code-1",
      state,
    });
    assertEquals(
      new URL(replay.headers.get("location")!, "https://x").searchParams.get(
        "slackConnection",
      ),
      "state_rejected",
    );
    assertEquals(slack.calls.length, 2);
  } finally {
    await o.finish();
  }
});

Deno.test("a refused Slack exchange or a denied authorization stores no connection and no token", async () => {
  const slack = fakeSlack({ tokenOk: false });
  const o = await open(slack);
  try {
    const refused = await startAttempt(o.fixture);
    const failed = await slackCallback(o.fixture, {
      code: "slack-code-bad",
      state: refused.url.searchParams.get("state")!,
    });
    assertEquals(
      new URL(failed.headers.get("location")!, "https://x").searchParams.get(
        "slackConnection",
      ),
      "exchange_failed",
    );
    const denied = await startAttempt(o.fixture);
    const cancelled = await slackCallback(o.fixture, {
      error: "access_denied",
      state: denied.url.searchParams.get("state")!,
    });
    assertEquals(
      new URL(cancelled.headers.get("location")!, "https://x").searchParams
        .get("slackConnection"),
      "authorization_denied",
    );
    assertEquals(slack.calls.length, 1);
    const pg = o.fixture.pgDatabase;
    const counts =
      (await pg.query<{ connections: number; installations: number }>(
        `select
         (select count(*)::int from bakery.integration_connections
           where provider = 'slack') as connections,
         (select count(*)::int from bakery.integration_installations
           where provider = 'slack') as installations`,
      )).rows[0]!;
    assertEquals(counts, { connections: 0, installations: 0 });
  } finally {
    await o.finish();
  }
});

async function storedToken(
  o: Awaited<ReturnType<typeof open>>,
): Promise<{ token: string; status: string; revision: number }> {
  const pg = o.fixture.pgDatabase;
  const row = (await pg.query<
    { secret_id: string; status: string; revision: number }
  >(
    `select installation.credential_secret_id as secret_id, installation.status,
       secret.active_version_revision as revision
       from bakery.integration_installations installation
       join bakery.secrets secret on secret.id = installation.credential_secret_id
      where installation.provider = 'slack'
        and installation.external_authorization_id = $1`,
    [TEAM_ID],
  )).rows[0]!;
  const slots = decodeSecretSlots(
    await openInstallationSecret(pg, o.secretsKey, row.secret_id),
    ["access_token"],
  );
  return {
    token: new TextDecoder().decode(slots.access_token),
    status: row.status,
    revision: row.revision,
  };
}

function outcome(response: Response): string | null {
  return new URL(response.headers.get("location")!, "https://x").searchParams
    .get("slackConnection");
}

async function connectOnce(o: Awaited<ReturnType<typeof open>>) {
  const attempt = await startAttempt(o.fixture);
  const response = await slackCallback(o.fixture, {
    code: "slack-code-first",
    state: attempt.url.searchParams.get("state")!,
  });
  assertEquals(outcome(response), "connected");
  return new URL(response.headers.get("location")!, "https://x").searchParams
    .get("connectionId")!;
}

Deno.test("an already connected workspace refuses a second connect and keeps the stored token", async () => {
  const slack = fakeSlack();
  const o = await open(slack);
  try {
    await connectOnce(o);
    const before = await storedToken(o);
    slack.issued.token = "xoxb-second-token";
    const again = await startAttempt(o.fixture);
    const refused = await slackCallback(o.fixture, {
      code: "slack-code-second",
      state: again.url.searchParams.get("state")!,
    });
    assertEquals(outcome(refused), "already_connected");
    assertEquals(await storedToken(o), before);
  } finally {
    await o.finish();
  }
});

Deno.test("a reconnect whose connection is gone stores nothing and leaves the installation as it was", async () => {
  const slack = fakeSlack();
  const o = await open(slack);
  try {
    const connectionId = await connectOnce(o);
    slack.issued.token = "xoxb-reconnect-token";
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
    const pg = o.fixture.pgDatabase;
    await pg.query(
      "update bakery.integration_connections set archived_at = now() where id = $1",
      [connectionId],
    );
    await pg.query(
      "update bakery.integration_installations set status = 'disabled' where provider = 'slack'",
    );
    const before = await storedToken(o);
    const refused = await slackCallback(o.fixture, {
      code: "slack-code-reconnect",
      state: new URL(created.authorizationUrl).searchParams.get("state")!,
    });
    assertEquals(outcome(refused), "reconnect_unavailable");
    assertEquals(await storedToken(o), before);
    assertEquals(before.status, "disabled");
  } finally {
    await o.finish();
  }
});

Deno.test("a connected Slack workspace reads back through the connection list, get and its auth attempt", async () => {
  const slack = fakeSlack();
  const o = await open(slack);
  try {
    const attempt = await startAttempt(o.fixture);
    const connected = await slackCallback(o.fixture, {
      code: "slack-code-list",
      state: attempt.url.searchParams.get("state")!,
    });
    assertEquals(outcome(connected), "connected");
    const connectionId = new URL(
      connected.headers.get("location")!,
      "https://x",
    ).searchParams.get("connectionId")!;
    const headers = { "Bakery-Organization-Id": o.fixture.organizationId };
    const listed = await call(
      o.fixture,
      "GET",
      "/v1/integration-connections",
      o.fixture.adminCookie,
      { headers },
    );
    assertEquals(listed.status, 200, await listed.clone().text());
    const list = await listed.json() as {
      items: { id: string; provider: string }[];
    };
    assertEquals(
      list.items.filter((item) => item.id === connectionId).map((item) =>
        item.provider
      ),
      ["slack"],
    );
    const one = await call(
      o.fixture,
      "GET",
      `/v1/integration-connections/${connectionId}`,
      o.fixture.adminCookie,
      { headers },
    );
    assertEquals(one.status, 200, await one.clone().text());
    assertEquals((await one.json() as { provider: string }).provider, "slack");
    const read = await call(
      o.fixture,
      "GET",
      `/v1/integration-auth-attempts/${attempt.id}`,
      o.fixture.adminCookie,
      { headers },
    );
    assertEquals(read.status, 200, await read.clone().text());
    assertEquals((await read.json() as { provider: string }).provider, "slack");
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
    assert(removed.ok, await removed.clone().text());
    const audited = await o.fixture.pgDatabase.query<{ provider: string }>(
      `select details ->> 'provider' as provider from bakery.audit_events
        where operation = 'integrationConnections.remove' and resource_id = $1`,
      [connectionId],
    );
    assertEquals(audited.rows, [{ provider: "slack" }]);
  } finally {
    await o.finish();
  }
});

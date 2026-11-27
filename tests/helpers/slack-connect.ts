import { assertEquals } from "@std/assert";
import { call, openInstallationFixture } from "./installation-settings.ts";
import {
  SLACK_BOT_SCOPES,
  slackServerProvider,
} from "../../packages/integration-slack/src/server/provider.ts";
import { slackGate } from "../../packages/integration-slack/src/server/gate.ts";
import { slackProviderManifest } from "../../packages/integration-slack/src/manifest.ts";
import { activateDeployedIntegrations } from "../../apps/server/src/modules/catalog/integration-gate.ts";
import { HOST_AUTH_PROFILES } from "../../apps/server/src/modules/catalog/integration-gate-profiles.ts";
import { createBrokerForTesting } from "../../apps/server/src/modules/catalog/integration-gate-broker-testing.ts";
import { createPostgresAuthorityPort } from "../../apps/server/src/modules/catalog/authority-snapshot-postgres.ts";
import type { IntegrationInvokeDeps } from "../../apps/server/src/modules/catalog/integration-invoke.ts";
import {
  createProviderCredentialPort,
  encodeSecretSlots,
} from "../../apps/server/src/modules/integrations/provider-credential-port.ts";
import type { PgDatabase } from "../../apps/server/src/platform/database.ts";

export const BOT_TOKEN = "xoxb-test-bot-token";
export const CLIENT_SECRET = "slack-client-secret-one";
export const TEAM_ID = "T0TESTTEAM";
export const APP_ID = "A0TESTAPP";

type SlackCall = { url: string; body: string; authorization: string | null };

export function fakeSlack(options: { tokenOk?: boolean } = {}) {
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
        app_id: APP_ID,
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

export async function open(
  slack: ReturnType<typeof fakeSlack>,
  options: { signingSecret?: string } = {},
) {
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
      body: {
        clientId: "1234.5678",
        clientSecret: CLIENT_SECRET,
        ...(options.signingSecret === undefined
          ? {}
          : { signingSecret: options.signingSecret }),
      },
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

export type Fixture = Awaited<ReturnType<typeof openInstallationFixture>>;

export async function clear(fixture: Fixture) {
  const pg = fixture.pgDatabase;
  await pg.query(
    `delete from bakery.external_effects where integration_connection_id in
       (select id from bakery.integration_connections where provider = 'slack')`,
  );
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
    `delete from bakery.audit_events
      where operation = 'integrationClientCredentials.put'
        and details ->> 'provider' = 'slack'`,
  );
  await pg.query(
    `delete from bakery.slack_installations
      where app_id = $1 or signing_secret_id in
        (select id from bakery.secrets where provider = 'slack')`,
    [APP_ID],
  );
  await pg.query(
    "update bakery.secrets set active_version_id = null where provider = 'slack'",
  );
  await pg.query(
    `delete from bakery.secret_versions where secret_id in
       (select id from bakery.secrets where provider = 'slack')`,
  );
  await pg.query("delete from bakery.secrets where provider = 'slack'");
  await pg.query(
    `delete from bakery.delivery_principals where principal_id in
       (select id from bakery.principals
         where principal_type = 'service' and display_name = $1)`,
    [DELIVERY_PRINCIPAL_NAME],
  );
  await pg.query(
    `delete from bakery.permission_grants where principal_id in
       (select id from bakery.principals
         where principal_type = 'service' and display_name = $1)`,
    [DELIVERY_PRINCIPAL_NAME],
  );
  await pg.query(
    `delete from bakery.principals principal
      where principal.principal_type = 'service' and principal.display_name = $1
        and not exists (
          select 1 from bakery.organization_memberships membership
           where membership.principal_id = principal.id
        )`,
    [DELIVERY_PRINCIPAL_NAME],
  );
}

export const DELIVERY_PRINCIPAL_NAME = "Slack delivery";

export async function startAttempt(fixture: Fixture) {
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

export function slackCallback(fixture: Fixture, query: Record<string, string>) {
  return call(
    fixture,
    "GET",
    `/v1/integration-auth/slack/callback?${new URLSearchParams(query)}`,
    fixture.adminCookie,
  );
}

export function outcome(response: Response): string | null {
  return new URL(response.headers.get("location")!, "https://x").searchParams
    .get("slackConnection");
}

export async function connectOnce(o: Awaited<ReturnType<typeof open>>) {
  const attempt = await startAttempt(o.fixture);
  const response = await slackCallback(o.fixture, {
    code: "slack-code-first",
    state: attempt.url.searchParams.get("state")!,
  });
  assertEquals(outcome(response), "connected");
  return new URL(response.headers.get("location")!, "https://x").searchParams
    .get("connectionId")!;
}

export type DeliveryIds = Readonly<{
  connectionId: string;
  resourceId: string;
  principalId: string;
}>;

export async function deliveryIds(
  fixture: Fixture,
  connectionId: string,
): Promise<DeliveryIds> {
  const row = (await fixture.pgDatabase.query<
    { resource_id: string; principal_id: string }
  >(
    `select distinct grant_row.resource_id, grant_row.subject_principal_id
            as principal_id
       from bakery.integration_grants grant_row
      where grant_row.connection_id = $1 and grant_row.revoked_at is null`,
    [connectionId],
  )).rows;
  assertEquals(row.length, 1);
  return {
    connectionId,
    resourceId: row[0]!.resource_id,
    principalId: row[0]!.principal_id,
  };
}

export type SentSlackRequest = Readonly<{
  method: string;
  path: string;
  query: string;
  authorization: string | null;
  body: unknown;
}>;

export function slackGateDeps(
  database: PgDatabase,
  answer: (request: SentSlackRequest) => unknown,
) {
  const sent: SentSlackRequest[] = [];
  const registry = activateDeployedIntegrations(
    [],
    undefined,
    [slackProviderManifest],
    [slackGate],
  );
  const port = createPostgresAuthorityPort(database, registry);
  const broker = createBrokerForTesting({
    registry,
    credentials: createProviderCredentialPort({
      providers: { providers: [slackServerProvider] },
      readStoredSlots: () =>
        Promise.resolve(encodeSecretSlots({ access_token: BOT_TOKEN })),
    }),
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const text = init?.body === undefined || init.body === null
        ? ""
        : await new Response(init.body).text();
      const request = {
        method: init?.method ?? "GET",
        path: url.pathname,
        query: url.search,
        authorization: new Headers(init?.headers).get("authorization"),
        body: text === "" ? undefined : JSON.parse(text),
      };
      sent.push(request);
      return Response.json(answer(request));
    },
    snapshotPort: port,
    generationOf: () => 0,
    profiles: HOST_AUTH_PROFILES,
  });
  const deps: IntegrationInvokeDeps = {
    database,
    registry,
    snapshots: port,
    snapshotsFor: () => port,
    providerRequests: broker,
  };
  return { deps, sent };
}

export async function changeConnection(
  o: Awaited<ReturnType<typeof open>>,
  connectionId: string,
  change: "off" | "on" | "remove",
) {
  const headers = { "Bakery-Organization-Id": o.fixture.organizationId };
  const current = await call(
    o.fixture,
    "GET",
    `/v1/integration-connections/${connectionId}`,
    o.fixture.adminCookie,
    { headers },
  );
  const { version } = await current.json() as { version: number };
  const response = await call(
    o.fixture,
    change === "remove" ? "POST" : "PATCH",
    change === "remove"
      ? `/v1/integration-connections/${connectionId}/removal`
      : `/v1/integration-connections/${connectionId}`,
    o.fixture.adminCookie,
    {
      ...(change === "remove" ? {} : { body: { enabled: change === "on" } }),
      headers: {
        ...headers,
        "If-Match": `"${version}"`,
        "Idempotency-Key": crypto.randomUUID(),
      },
    },
  );
  if (!response.ok) {
    throw new Error(`${change} failed: ${await response.text()}`);
  }
}

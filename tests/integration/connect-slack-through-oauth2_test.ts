import { assert, assertEquals } from "@std/assert";
import { call } from "../helpers/installation-settings.ts";
import {
  BOT_TOKEN,
  CLIENT_SECRET,
  connectOnce,
  DELIVERY_PRINCIPAL_NAME,
  fakeSlack,
  open,
  outcome,
  slackCallback,
  startAttempt,
  TEAM_ID,
} from "../helpers/slack-connect.ts";
import { pkceChallenge } from "../../apps/server/src/modules/integrations/auth-attempts.ts";
import { decodeSecretSlots } from "../../apps/server/src/modules/integrations/provider-credential-port.ts";
import { openInstallationSecret } from "../../apps/server/src/modules/secrets/installation-secrets.ts";
import { SLACK_BOT_SCOPES } from "../../packages/integration-slack/src/server/provider.ts";

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

async function deliveryState(o: Awaited<ReturnType<typeof open>>) {
  const pg = o.fixture.pgDatabase;
  const resources = await pg.query<
    {
      id: string;
      kind: string;
      external_id: string;
      selected: boolean;
      available: boolean;
      binding: unknown;
    }
  >(
    `select resource.id, resource.kind, resource.external_id,
            resource.selected, resource.available,
            resource.capability_snapshot -> 'binding' as binding
       from bakery.integration_resources resource
       join bakery.integration_connections connection
         on connection.id = resource.connection_id
      where connection.provider = 'slack'
        and connection.organization_id = $1`,
    [o.fixture.organizationId],
  );
  const principals = await pg.query<
    {
      id: string;
      provider_user_id: string | null;
      memberships: number;
      capabilities: string[];
    }
  >(
    `select principal.id, principal.provider_user_id,
            (select count(*)::int from bakery.organization_memberships m
              where m.principal_id = principal.id) as memberships,
            array(select capability from bakery.permission_grants g
                   where g.principal_id = principal.id
                     and g.revoked_at is null order by capability)
              as capabilities
       from bakery.principals principal
      where principal.principal_type = 'service'
        and principal.display_name = $1
        and exists (
          select 1 from bakery.permission_grants g
           where g.principal_id = principal.id and g.organization_id = $2
        )`,
    [DELIVERY_PRINCIPAL_NAME, o.fixture.organizationId],
  );
  const grants = await pg.query<
    {
      subject_principal_id: string;
      resource_id: string;
      direction: string;
      capability: string;
      action_version: number;
    }
  >(
    `select grant_row.subject_principal_id, grant_row.resource_id,
            grant_row.direction, grant_row.capability, grant_row.action_version
       from bakery.integration_grants grant_row
       join bakery.integration_connections connection
         on connection.id = grant_row.connection_id
      where connection.provider = 'slack'
        and connection.organization_id = $1
        and grant_row.revoked_at is null
      order by grant_row.capability`,
    [o.fixture.organizationId],
  );
  return {
    resources: resources.rows,
    principals: principals.rows,
    grants: grants.rows,
  };
}

Deno.test("connecting Slack records the workspace, one delivery principal and its grants, and a reconnect adds none", async () => {
  const slack = fakeSlack();
  const o = await open(slack);
  try {
    const connectionId = await connectOnce(o);
    const first = await deliveryState(o);
    assertEquals(first.resources.length, 1);
    const resource = first.resources[0]!;
    assertEquals(resource.kind, "slack.workspace");
    assertEquals(resource.external_id, TEAM_ID);
    assertEquals(resource.selected, true);
    assertEquals(resource.available, true);
    assertEquals(resource.binding, { teamId: TEAM_ID, botUserId: "U0TESTBOT" });
    assertEquals(first.principals.length, 1);
    const principal = first.principals[0]!;
    assertEquals(principal.provider_user_id, null);
    assertEquals(principal.memberships, 0);
    assertEquals(principal.capabilities, ["integrationConnections.invoke"]);
    const keyed = await o.fixture.pgDatabase.query<{ principal_id: string }>(
      `select principal_id from bakery.delivery_principals
        where organization_id = $1 and purpose = 'slack.delivery'`,
      [o.fixture.organizationId],
    );
    assertEquals(keyed.rows.map((row) => row.principal_id), [principal.id]);
    assertEquals(
      first.grants,
      ["slack.dm.open", "slack.message.post", "slack.message.update"].map(
        (capability) => ({
          subject_principal_id: principal.id,
          resource_id: resource.id,
          direction: "out_of_bakery",
          capability,
          action_version: 1,
        }),
      ),
    );
    const permissions = await o.fixture.pgDatabase.query<
      { granted_permissions: Record<string, string> }
    >(
      "select granted_permissions from bakery.integration_connections where id = $1",
      [connectionId],
    );
    assertEquals(permissions.rows[0]!.granted_permissions, {
      app_mentions: "read",
      channels: "read",
      chat: "write",
      commands: "read",
      im: "write",
    });

    slack.issued.token = "xoxb-refreshed-token";
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
    const refreshed = await slackCallback(o.fixture, {
      code: "slack-code-refresh",
      state: new URL(created.authorizationUrl).searchParams.get("state")!,
    });
    assertEquals(outcome(refreshed), "refreshed");
    assertEquals(await deliveryState(o), first);
  } finally {
    await o.finish();
  }
});

Deno.test("a reconnect leaves an admin's revocation of a delivery grant standing and adds no grant", async () => {
  const slack = fakeSlack();
  const o = await open(slack);
  try {
    const connectionId = await connectOnce(o);
    await o.fixture.pgDatabase.query(
      `update bakery.integration_grants set revoked_at = now(), revoked_by = $2
        where connection_id = $1 and capability = 'slack.message.post'`,
      [connectionId, o.fixture.adminId],
    );
    const grantsOf = async () =>
      (await o.fixture.pgDatabase.query<
        { id: string; capability: string; revoked: boolean }
      >(
        `select id, capability, revoked_at is not null as revoked
           from bakery.integration_grants where connection_id = $1
          order by capability, id`,
        [connectionId],
      )).rows;
    const revoked = await grantsOf();
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
    const refreshed = await slackCallback(o.fixture, {
      code: "slack-code-refresh",
      state: new URL(created.authorizationUrl).searchParams.get("state")!,
    });
    assertEquals(outcome(refreshed), "refreshed");
    assertEquals(await grantsOf(), revoked);
    assertEquals(
      revoked.map(({ capability, revoked }) => [capability, revoked]),
      [
        ["slack.dm.open", false],
        ["slack.message.post", true],
        ["slack.message.update", false],
      ],
    );
  } finally {
    await o.finish();
  }
});

import { assert, assertEquals } from "@std/assert";
import {
  authRequest,
  openInstallationFixture,
} from "../helpers/installation-settings.ts";

/**
 * The positive path end to end: a granted Developer writes through the REAL
 * route on a REAL Postgres, and the ledger row is real.
 *
 * The unit suite proves the door admits a granted call, but it stops at a stub
 * database. This proves the whole thing: `createApp` boots, the session
 * middleware resolves the caller, the action registry authorizes the policy, the
 * authority snapshot is loaded from the catalog tables, the grant is matched, the
 * provider is resolved by gate id, and the effect ledger writes a row that can be
 * read back.
 *
 * Two things are deliberately real and one is not:
 * - real: the app, the database, the session, the route, the ledger.
 * - not real: the provider HTTP call. The route receives its provider request
 *   port from the app, and no production `CredentialPort` exists yet (that is
 *   the next slice), so the app's default refuses provider requests. That is
 *   fine for what this asserts: a write's `externalEffectId` is the LEDGER's id
 *   and comes from the prepared effect, and `result` stays null until the effect
 *   is confirmed. If the response waited on the provider, this test would not be
 *   the honest check it is.
 */

const ACTION = "github.issue.comment.create";
const ACTION_VERSION = 1;

type Seeded = {
  connectionId: string;
  resourceId: string;
  installationId: string;
  grantId: string;
};

/**
 * The rows `loadSnapshot` reads, written as the owner.
 *
 * This mirrors `seedAuthority` in the ticket e2e helpers rather than importing
 * it: that helper is coupled to the e2e `Stack` (psql over a container) and to
 * ticket sources, neither of which this lane has. The row shapes are the same,
 * because they are what the production snapshot query joins.
 */
export async function seedIntegration(
  pgDatabase: Parameters<typeof openInstallationFixture>[1] extends never
    ? never
    : {
      query: <T>(sql: string, args?: unknown[]) => Promise<{ rows: T[] }>;
    },
  organizationId: string,
  principalId: string,
): Promise<Seeded> {
  const registrationId = crypto.randomUUID();
  const installationId = crypto.randomUUID();
  const connectionId = crypto.randomUUID();
  const resourceId = crypto.randomUUID();
  const grantId = crypto.randomUUID();
  for (
    const [id, name] of [
      [crypto.randomUUID(), "GitHub App client secret"],
      [crypto.randomUUID(), "GitHub App private key"],
      [crypto.randomUUID(), "GitHub App webhook secret"],
    ] as const
  ) {
    await pgDatabase.query(
      `insert into bakery.secrets (id, name, provider, allowed_principals, allowed_actions)
       values ($1, $2, 'github', '[]'::jsonb, '[]'::jsonb)`,
      [id, name],
    );
  }
  const [clientSecret, privateKey, webhookSecret] = (
    await pgDatabase.query<{ id: string }>(
      `select id from bakery.secrets where provider = 'github'
        and name in ('GitHub App client secret', 'GitHub App private key',
                     'GitHub App webhook secret')
        order by name`,
    )
  ).rows.map((row) => row.id);
  await pgDatabase.query(
    `insert into bakery.integration_app_registrations (
       id, provider, external_app_id, slug, name, client_id, owner_login,
       owner_id, owner_type, html_url, permissions, events, client_secret_id,
       private_key_secret_id, webhook_secret_id, status, registered_by,
       bot_user_id
     ) values ($1, 'github', 1, 'bakery-invoke', 'Bakery invoke',
       'Iv1.invoke', 'bakery-invoke', 1, 'Organization',
       'https://github.com/apps/bakery-invoke', '{}'::jsonb,
       '["issues"]'::jsonb, $2, $3, $4, 'registered', $5, 4242)`,
    [
      registrationId,
      clientSecret,
      privateKey,
      webhookSecret,
      principalId,
    ],
  );
  await pgDatabase.query(
    `insert into bakery.integration_installations (
       id, provider, registration_id, external_authorization_id,
       external_account_id, account_login, account_type, repository_selection,
       granted_permissions, status
     ) values ($1, 'github', $2, '98765432', '4242', 'bakery-invoke',
       'Organization', 'selected', '{"issues":"write"}'::jsonb, 'enabled')`,
    [installationId, registrationId],
  );
  await pgDatabase.query(
    `insert into bakery.integration_connections (
       id, organization_id, provider, installation_id,
       external_authorization_id, external_account_id, label, adapter_version,
       granted_permissions, status, health, created_by
     ) values ($1, $2, 'github', $3, '98765432', '4242', 'bakery-invoke',
       'github@1', '{"issues":"write"}'::jsonb, 'enabled', 'healthy', $4)`,
    [connectionId, organizationId, installationId, principalId],
  );
  await pgDatabase.query(
    `insert into bakery.integration_resources (
       id, organization_id, connection_id, installation_id, kind, external_id,
       display_name, selected, enabled, last_discovery_generation
     ) values ($1, $2, $3, $4, 'repository', '123456789',
       'bakery-invoke/hello', true, true, 1)`,
    [resourceId, organizationId, connectionId, installationId],
  );
  await pgDatabase.query(
    `insert into bakery.integration_grants (
       id, organization_id, connection_id, subject_type, subject_principal_id,
       direction, capability, action_version, resource_id, granted_by
     ) values ($1, $2, $3, 'principal', $4, 'out_of_bakery', $5, $6, $7, $8)`,
    [
      grantId,
      organizationId,
      connectionId,
      principalId,
      ACTION,
      ACTION_VERSION,
      resourceId,
      principalId,
    ],
  );
  return { connectionId, resourceId, installationId, grantId };
}

function invokeRequest(
  connectionId: string,
  cookie: string,
  organizationId: string,
  resourceId: string,
): Request {
  return authRequest(
    `/v1/integration-connections/${connectionId}/actions`,
    {
      action: ACTION,
      arguments: { issueNumber: 7, body: "hello from the ledger", resourceId },
    },
    {
      cookie,
      headers: {
        "Bakery-Organization-Id": organizationId,
        "Idempotency-Key": crypto.randomUUID(),
      },
    },
  );
}

Deno.test("a granted Developer's write reaches the real ledger and reports its effect id", async () => {
  const fixture = await openInstallationFixture(true);
  try {
    const seeded = await seedIntegration(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.developerId!,
    );
    const response = await fixture.app.fetch(
      invokeRequest(
        seeded.connectionId,
        fixture.developerCookie,
        fixture.organizationId,
        seeded.resourceId,
      ),
    );
    const body = await response.json().catch(() => null);
    assertEquals(
      response.status,
      200,
      `expected the granted write to be accepted, got ${response.status} ${
        JSON.stringify(body)
      }`,
    );
    // The write arm: the ledger's id, and no result until the effect is proven.
    assert(
      typeof body.externalEffectId === "string" &&
        body.externalEffectId.length > 0,
      `expected a real externalEffectId, got ${JSON.stringify(body)}`,
    );
    assertEquals(body.accepted, true);
    assertEquals(body.operation, ACTION);
    assertEquals(
      body.result,
      null,
      "an unreconciled write must not report a result",
    );

    // The row is real, and it belongs to the caller's organization and the
    // grant, which is what makes this a ledger write rather than a number.
    const effect = (await fixture.pgDatabase.query<{
      id: string;
      organizationId: string;
      connectionId: string;
      grantId: string;
      operation: string;
      status: string;
      requestingPrincipalId: string;
    }>(
      `select id, organization_id as "organizationId",
              integration_connection_id as "connectionId",
              integration_grant_id as "grantId",
              operation, status,
              requesting_principal_id as "requestingPrincipalId"
         from bakery.external_effects where id = $1`,
      [body.externalEffectId],
    )).rows[0];
    assert(effect, "the ledger must hold a row for the reported effect id");
    assertEquals(effect.organizationId, fixture.organizationId);
    assertEquals(effect.connectionId, seeded.connectionId);
    assertEquals(effect.grantId, seeded.grantId);
    assertEquals(effect.operation, ACTION);
    assertEquals(effect.requestingPrincipalId, fixture.developerId);
    assertEquals(
      effect.status === "confirmed",
      false,
      "the provider was never called, so the effect cannot be confirmed",
    );
  } finally {
    await fixture.finish();
  }
});

Deno.test("without a grant the same Developer's write is refused and writes no ledger row", async () => {
  // The must-fail control against the real route and the real database. Without
  // it the test above would pass even if grants were never checked.
  const fixture = await openInstallationFixture(true);
  try {
    const seeded = await seedIntegration(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.developerId!,
    );
    await fixture.pgDatabase.query(
      `delete from bakery.integration_grants where id = $1`,
      [seeded.grantId],
    );
    const before = (await fixture.pgDatabase.query<{ count: string }>(
      `select count(*)::text as count from bakery.external_effects
        where organization_id = $1`,
      [fixture.organizationId],
    )).rows[0]!.count;
    const response = await fixture.app.fetch(
      invokeRequest(
        seeded.connectionId,
        fixture.developerCookie,
        fixture.organizationId,
        seeded.resourceId,
      ),
    );
    const refused = await response.json().catch(() => null) as
      | { code?: string }
      | null;
    assertEquals(
      response.status,
      403,
      `an ungranted write must be refused, got ${response.status}`,
    );
    // The exact refusal the action-grant guard throws. A 403 from a broken
    // session or a missing header would satisfy a status-only assertion while
    // proving nothing about grants, so the code is pinned here.
    assertEquals(refused?.code, "AUTH_FORBIDDEN");
    const after = (await fixture.pgDatabase.query<{ count: string }>(
      `select count(*)::text as count from bakery.external_effects
        where organization_id = $1`,
      [fixture.organizationId],
    )).rows[0]!.count;
    assertEquals(
      after,
      before,
      "a refused invocation must not write to the effect ledger",
    );
  } finally {
    await fixture.finish();
  }
});

Deno.test("an Admin without a grant is refused too: the grant is what admits, not the role", async () => {
  // Invoking is `Developer+action grant`. Rank alone must not open the door, or
  // the grant check would be decorative for the most powerful member.
  const fixture = await openInstallationFixture(true);
  try {
    const seeded = await seedIntegration(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.adminId,
    );
    await fixture.pgDatabase.query(
      `delete from bakery.integration_grants where id = $1`,
      [seeded.grantId],
    );
    const response = await fixture.app.fetch(
      invokeRequest(
        seeded.connectionId,
        fixture.adminCookie,
        fixture.organizationId,
        seeded.resourceId,
      ),
    );
    const refused = await response.json().catch(() => null) as
      | { code?: string }
      | null;
    assertEquals(
      response.status,
      403,
      `an ungranted Admin must be refused, got ${response.status}`,
    );
    assertEquals(
      refused?.code,
      "AUTH_FORBIDDEN",
      "rank alone must not open the door: the grant is the condition",
    );
  } finally {
    await fixture.finish();
  }
});

import { assertEquals, assertRejects } from "@std/assert";
import { StandardError } from "../../packages/contracts/src/http.ts";
import type {
  OrganizationId,
  PrincipalId,
} from "../../packages/contracts/src/contracts.ts";
import { adminJson } from "../helpers/access-tokens.ts";
import {
  connectOnce,
  deliveryIds,
  fakeSlack,
  open,
  slackGateDeps,
} from "../helpers/slack-connect.ts";
import { invokeIntegration } from "../../apps/server/src/modules/catalog/integration-invoke.ts";
import { resolveOrganizationActor } from "../../apps/server/src/modules/auth/adapters/authority-postgres.ts";
import { organizationPermissions } from "../../apps/server/src/modules/auth/application/authorize.ts";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";

Deno.test("the Slack delivery principal has no sign-in identity and the database refuses to give it one", async () => {
  const o = await open(fakeSlack());
  const userId = crypto.randomUUID();
  try {
    const ids = await deliveryIds(o.fixture, await connectOnce(o));
    const row = (await o.fixture.pgDatabase.query<
      { principal_type: string; provider_user_id: string | null }
    >(
      "select principal_type, provider_user_id from bakery.principals where id = $1",
      [ids.principalId],
    )).rows[0]!;
    assertEquals(row, { principal_type: "service", provider_user_id: null });
    await o.fixture.pgDatabase.query(
      `insert into public."user" (id, name, email, "emailVerified",
         "createdAt", "updatedAt")
       values ($1, 'Impostor', $2, true, now(), now())`,
      [userId, `impostor-${userId}@example.test`],
    );
    await assertRejects(
      () =>
        o.fixture.runtimePgDatabase.query(
          "update bakery.principals set provider_user_id = $2 where id = $1",
          [ids.principalId, userId],
        ),
      Error,
      "principals_provider_user_scope",
    );
  } finally {
    await o.fixture.pgDatabase.query(
      'delete from public."user" where id = $1',
      [userId],
    );
    await o.finish();
  }
});

Deno.test("an admin cannot mint a token for, edit, or widen the Slack delivery principal", async () => {
  const o = await open(fakeSlack());
  try {
    const f = o.fixture;
    const ids = await deliveryIds(f, await connectOnce(o));
    const token = await adminJson(f, "POST", "/v1/access-tokens", {
      principalId: ids.principalId,
      name: "delivery",
      scopes: ["bakery:read"],
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    assertEquals(token.status, 404, await token.clone().text());
    const edited = await adminJson(
      f,
      "PATCH",
      `/v1/principals/${ids.principalId}`,
      { displayName: "Renamed" },
      { "If-Match": '"v1"' },
    );
    assertEquals(edited.status, 404, await edited.clone().text());
    const widened = await adminJson(f, "POST", "/v1/permission-grants", {
      principalId: ids.principalId,
      capability: "applications.list",
    });
    assertEquals(widened.status, 404, await widened.clone().text());
    const stored = await f.pgDatabase.query<
      { tokens: number; capabilities: string[] }
    >(
      `select
         (select count(*)::int from bakery.access_tokens
           where principal_id = $1) as tokens,
         array(select capability from bakery.permission_grants
                where principal_id = $1 and revoked_at is null
                order by capability) as capabilities`,
      [ids.principalId],
    );
    assertEquals(stored.rows[0], {
      tokens: 0,
      capabilities: ["integrationConnections.invoke"],
    });
    const actor = await withPgTransaction(
      f.runtimePgDatabase,
      (tx) =>
        resolveOrganizationActor(
          tx,
          ids.principalId as PrincipalId,
          f.organizationId as OrganizationId,
        ),
    );
    assertEquals(actor.role, undefined);
    assertEquals(organizationPermissions(actor), [
      "integrationConnection:invoke",
    ]);
  } finally {
    await o.finish();
  }
});

Deno.test("the Slack delivery principal acts only through the grants it holds", async () => {
  const o = await open(fakeSlack());
  try {
    const f = o.fixture;
    const connectionId = await connectOnce(o);
    const ids = await deliveryIds(f, connectionId);
    const { deps, sent } = slackGateDeps(
      f.runtimePgDatabase,
      () => ({ ok: true, channel: "D0DELIVERY", ts: "1700000000.000100" }),
    );
    await f.pgDatabase.query(
      `update bakery.integration_grants set revoked_at = now(), revoked_by = $2
        where connection_id = $1 and capability = 'slack.message.post'`,
      [connectionId, f.adminId],
    );
    const refused = await assertRejects(
      () =>
        invokeIntegration(deps, {
          organizationId: f.organizationId,
          actorRef: ids.principalId,
          connectionId,
          input: {
            actionId: "slack.message.post",
            actionVersion: 1,
            resourceId: ids.resourceId,
            arguments: {
              channelId: "D0DELIVERY",
              text: "Hello [bkr-00000003]",
              marker: "[bkr-00000003]",
            },
          },
          idempotencyKey: "slack-security-post",
        }),
      StandardError,
    );
    assertEquals(refused.code, "AUTH_FORBIDDEN");
    const foreign = await assertRejects(
      () =>
        invokeIntegration(deps, {
          organizationId: crypto.randomUUID(),
          actorRef: ids.principalId,
          connectionId,
          input: {
            actionId: "slack.dm.open",
            actionVersion: 1,
            resourceId: ids.resourceId,
            arguments: { userId: "U0RECIPIENT" },
          },
          idempotencyKey: "slack-security-foreign",
        }),
      StandardError,
    );
    assertEquals(foreign.code, "RESOURCE_NOT_FOUND");
    assertEquals(sent.length, 0);
  } finally {
    await o.finish();
  }
});

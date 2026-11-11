import { assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import {
  completeFlow,
  connectionFlow,
  connectionText,
  type GitHubAppFixture,
  openGitHubAppFixture,
  resourceRows,
} from "../helpers/github-app-registration.ts";
import { fakeRepositories } from "../helpers/fake-github-app.ts";

async function withFixture(run: (f: GitHubAppFixture) => Promise<void>) {
  const f = await openGitHubAppFixture();
  try {
    await run(f);
  } finally {
    await f.finish();
  }
}

/**
 * SYNTHETIC: a confirmed effect row the executor would have written through
 * `connectionId` and `resourceId`, with the external identities it pinned.
 */
async function seedEffect(
  f: GitHubAppFixture,
  connectionId: string,
  resourceId: string,
): Promise<string> {
  const id = crypto.randomUUID();
  await f.pgDatabase.query(
    `insert into bakery.external_effects (
       id, organization_id, operation, action_version, target,
       integration_connection_id, integration_resource_id,
       integration_install_id, requesting_principal_id, actor_ref,
       idempotency_key, request_digest, external_account_id,
       external_resource_id, adapter_version, authorization_revision, status,
       remote_id
     )
     select $1, connection.organization_id, 'github.issue.comment.create', 1,
       'resource:' || resource.id, connection.id, resource.id, 'inst-1', $4,
       $5, $6, repeat('a', 64), connection.external_account_id,
       resource.external_id, 'github@2026-03-10',
       connection.authorization_revision, 'confirmed', '42'
       from bakery.integration_connections connection
       join bakery.integration_resources resource
         on resource.connection_id = connection.id
      where connection.id = $2 and resource.id = $3`,
    [id, connectionId, resourceId, f.adminId, f.adminId, `recovery-${id}`],
  );
  return id;
}

async function effectText(f: GitHubAppFixture, id: string): Promise<string> {
  const result = await f.pgDatabase.query<{ row: string }>(
    "select e::text as row from bakery.external_effects e where id = $1",
    [id],
  );
  return result.rows[0].row;
}

async function sqlState(run: () => Promise<unknown>): Promise<string> {
  const error = await assertRejects(run);
  return String(Reflect.get(error as object, "code"));
}

Deno.test("effect rows keep their connection, resource and external identities across suspend, revoke and account change", async () => {
  await withFixture(async (f) => {
    const first = await connectionFlow(f, {
      repositories: () => fakeRepositories(2, ["admin"]),
    });
    const original = (await completeFlow(f, first)).connectionId!;
    const [resource] = await resourceRows(f, original);
    const effectId = await seedEffect(f, original, resource.id);
    const effect = await effectText(f, effectId);
    const unchanged = async (step: string) =>
      assertEquals(await effectText(f, effectId), effect, step);

    // Suspension blocks the installation; the ledger row is untouched.
    await f.pgDatabase.query(
      `update bakery.integration_installations set status = 'suspended'
        where id = (select installation_id from bakery.integration_connections
                     where id = $1)`,
      [original],
    );
    await unchanged("suspend");
    // Provider revocation.
    await f.pgDatabase.query(
      "update bakery.integration_connections set status = 'revoked' where id = $1",
      [original],
    );
    await unchanged("revoke");
    // A reconnect for another account creates a new connection.
    const swapped = await connectionFlow(f, {
      app: first.app,
      attempt: {
        body: { provider: "github", reconnectConnectionId: original },
      },
    });
    const replacement = await completeFlow(f, swapped);
    assertEquals(replacement.outcome, "pending");
    assertNotEquals(replacement.connectionId, original);
    await unchanged("account change");
    // A same-account reinstall moves the original connection; the effect
    // still names it, its resource and the same account.
    const before = await connectionText(f, original);
    const reinstalled = f.github.addInstallation(first.app, {
      account: { ...first.installations[0].account },
    });
    const moved = await connectionFlow(f, {
      app: first.app,
      existing: [reinstalled],
      attempt: {
        body: { provider: "github", reconnectConnectionId: original },
      },
    });
    assertEquals(await completeFlow(f, moved), {
      outcome: "refreshed",
      connectionId: original,
    });
    assertNotEquals(await connectionText(f, original), before);
    await unchanged("same-account reinstall");

    // History cannot be deleted out from under the ledger.
    assertEquals(
      await sqlState(() =>
        f.pgDatabase.query(
          "delete from bakery.integration_resources where id = $1",
          [resource.id],
        )
      ),
      "23503",
    );
    assertEquals(
      await sqlState(() =>
        f.pgDatabase.query(
          "delete from bakery.integration_connections where id = $1",
          [original],
        )
      ),
      "23503",
    );
    await unchanged("refused deletes");
    // An effect cannot name another connection's resource.
    assertEquals(
      await sqlState(() =>
        f.pgDatabase.query(
          `update bakery.external_effects set integration_connection_id = $2
            where id = $1`,
          [effectId, replacement.connectionId],
        )
      ),
      "23503",
    );
    await unchanged("cross-connection resource");
  });
});

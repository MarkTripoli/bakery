import { assert, assertEquals, assertRejects } from "@std/assert";
import { StandardError } from "../../packages/contracts/src/http.ts";
import type { TokenTarget } from "../../apps/server/src/modules/integrations/token-broker.ts";
import { fakeAppKey } from "../helpers/fake-github-app.ts";
import {
  enabledConnection,
  type GitHubAppFixture,
  openGitHubAppFixture,
  pendingConnection,
  postDiscovery,
  readInstallations,
  secondOrganization,
} from "../helpers/github-app-registration.ts";

async function withFixture(run: (f: GitHubAppFixture) => Promise<void>) {
  const f = await openGitHubAppFixture();
  try {
    await run(f);
  } finally {
    await f.finish();
  }
}

async function installationRowId(f: GitHubAppFixture, connectionId: string) {
  return (await f.pgDatabase.query<{ id: string }>(
    `select installation_id as id from bakery.integration_connections
      where id = $1`,
    [connectionId],
  )).rows[0].id;
}

/** A complete target for the connection; only the statuses vary. */
function target(
  f: GitHubAppFixture,
  connectionId: string,
  installationId: number,
  repositoryIds: number[],
  installationStatus: string,
): TokenTarget {
  return {
    connectionId,
    generation: f.broker.generation(connectionId),
    status: "enabled",
    installationStatus,
    appId: 1,
    // Never opened: the refusal comes before the key is decrypted.
    privateKey: {
      secretId: crypto.randomUUID(),
      revision: 1,
      keyId: f.secretsKey.keyId,
      ciphertext: new Uint8Array(16),
      nonce: new Uint8Array(12),
    },
    installationId,
    repositoryIds,
    permissions: { metadata: "read" },
  };
}

Deno.test("AC1 security: a suspended or revoked installation is refused a token before the App key is opened or GitHub is called, and the refusal creates no broker state", async () => {
  await withFixture(async (f) => {
    const { connectionId, installation, selected } = await enabledConnection(
      f,
    );
    const ids = selected.map((row) => Number(row.external_id));
    const size = f.broker.size;
    for (const status of ["suspended", "revoked", "pending"]) {
      const error = await assertRejects(() =>
        f.broker.token(
          target(f, crypto.randomUUID(), installation.id, ids, status),
          new AbortController().signal,
        )
      );
      assert(error instanceof StandardError);
      assertEquals(error.code, "STATE_CONFLICT");
      assertEquals(error.params, { reason: "installation_unavailable" });
    }
    assertEquals(f.broker.size, size, "refusals add no namespace");
    assertEquals(f.github.calls.length, 0);
    // The same through the connection the reconcile suspended.
    f.github.setInstallationState(installation.id, "suspended");
    await f.reconcile(await installationRowId(f, connectionId));
    f.github.calls.length = 0;
    const refused = await assertRejects(() =>
      f.broker.token(
        target(f, connectionId, installation.id, ids, "suspended"),
        new AbortController().signal,
      )
    );
    assert(refused instanceof StandardError);
    assertEquals(f.github.calls.length, 0);
  });
});

Deno.test("reconciliation audit and events carry only safe identifiers and codes", async () => {
  await withFixture(async (f) => {
    const { connectionId, installation } = await enabledConnection(f);
    f.github.setInstallationState(installation.id, "deleted");
    const rowId = await installationRowId(f, connectionId);
    assertEquals((await f.reconcile(rowId)).kind, "transitioned");
    const audit = (await f.pgDatabase.query<{ details: unknown }>(
      `select details from bakery.audit_events
        where operation = 'integrationInstallations.reconcile'
          and resource_id = any($1::text[])`,
      [[rowId, connectionId]],
    )).rows;
    assertEquals(audit.length, 2);
    const events = (await f.pgDatabase.query<{ payload: unknown }>(
      `select payload from bakery.domain_events where aggregate_id = $1`,
      [connectionId],
    )).rows;
    const text = JSON.stringify({ audit, events });
    for (const secret of [fakeAppKey.pem, "ghs_", "BEGIN", "PRIVATE KEY"]) {
      assert(!text.includes(secret), `leaked ${secret.slice(0, 12)}`);
    }
    assert(!text.includes(installation.account.login), "no account login");
  });
});

Deno.test("a discovery's receipt, row, audit and events never carry the scan token or another organization's data", async () => {
  await withFixture(async (f) => {
    const { connectionId } = await enabledConnection(f);
    const response = await postDiscovery(f, connectionId);
    const receipt = await response.text();
    assertEquals(response.status, 202, receipt);
    const { discoveryId } = JSON.parse(receipt);
    const result = await f.discover(discoveryId);
    assertEquals(result.kind === "finished" && result.status, "completed");
    const stored = JSON.stringify({
      receipt,
      rows: (await f.pgDatabase.query(
        "select * from bakery.integration_discoveries where id = $1",
        [discoveryId],
      )).rows,
      audit: (await f.pgDatabase.query(
        "select details from bakery.audit_events where resource_id = $1",
        [discoveryId],
      )).rows,
      events: (await f.pgDatabase.query(
        `select payload from bakery.domain_events
          where aggregate_id::text = $1`,
        [discoveryId],
      )).rows,
    });
    for (const token of f.github.issuedTokens) {
      assert(!stored.includes(token), "an issued token leaked");
    }
    assert(!stored.includes("ghs_"));
    assert(!stored.includes(fakeAppKey.pem.slice(40, 80)));
  });
});

Deno.test("AC5 security: installation reads carry no credential, account login, organization id or resource, and only installation administrators may read them", async () => {
  await withFixture(async (f) => {
    const { connectionId, installation, resources, app } =
      await enabledConnection(f);
    // Another organization connects the same installation.
    const secondId = await secondOrganization(f);
    const other = await pendingConnection(f, {
      app,
      existing: installation,
      attempt: { organizationId: secondId },
    });
    const rowId = await installationRowId(f, connectionId);
    const one = await readInstallations(f, { id: rowId });
    const list = await readInstallations(f);
    const text = (await one.text()) + (await list.text());
    assertEquals(one.status, 200);
    assertEquals(list.status, 200);
    const forbidden = [
      installation.account.login,
      f.organizationId,
      secondId,
      connectionId,
      other.connectionId,
      ...resources.flatMap((
        row,
      ) => [row.id, row.external_id, row.display_name]),
      ...other.resources.flatMap((row) => [row.id, row.display_name]),
      fakeAppKey.pem.slice(40, 80),
      "ghs_",
      "secret",
      "ciphertext",
    ];
    for (const value of forbidden) {
      assert(!text.includes(value), `leaked ${value}`);
    }
    // A Developer of the organization is not an installation administrator.
    for (
      const response of [
        await readInstallations(f, { cookie: f.developerCookie }),
        await readInstallations(f, { id: rowId, cookie: f.developerCookie }),
      ]
    ) {
      const body = await response.text();
      assertEquals(response.status, 403, body);
      assertEquals(JSON.parse(body).code, "AUTH_FORBIDDEN");
      assert(!body.includes(rowId));
    }
  });
});

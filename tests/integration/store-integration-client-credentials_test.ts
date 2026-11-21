import { assert, assertEquals, assertRejects } from "@std/assert";
import { StandardError } from "../../packages/contracts/src/http.ts";
import type { ActionContext } from "../../packages/contracts/src/action-registry.ts";
import { PrincipalType } from "../../packages/contracts/src/contracts.ts";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";
import {
  decryptInstallationSecret,
  loadSecretKey,
  SecretCipherSchema,
} from "../../apps/server/src/modules/secrets/crypto.ts";
import {
  getClientCredentials,
  putClientCredentials,
} from "../../apps/server/src/modules/integrations/client-credentials.ts";
import { openCoordinationFixture } from "../helpers/coordination-fixture.ts";

/**
 * #410 against a real database: provider OAuth client credentials, written as the
 * application role.
 *
 * What only a database can show, and what these pin:
 *
 *  - the secret is sealed (the stored bytes decrypt to what was sent and contain
 *    nothing readable) and never appears in a response, an audit row or a log;
 *  - a replacement is the next revision of the same secret, with the earlier
 *    revision kept, and a stale or missing version changes nothing;
 *  - two first saves cannot both win, and the loser leaves nothing behind;
 *  - a provider's row sits beside GitHub's in the one shared table, which GitHub
 *    never reads, and the application role holds only the grants it needs.
 */

type Fixture = Awaited<ReturnType<typeof openCoordinationFixture>>;

const BASE = "https://bakery.example";
const SECRET = "lin_oauth_secret_one";
const NEXT_SECRET = "lin_oauth_secret_two";

async function keyFile(): Promise<{ file: string; keyId: string }> {
  const file = await Deno.makeTempFile({ prefix: "bakery-test-key-" });
  await Deno.writeFile(file, crypto.getRandomValues(new Uint8Array(32)));
  return { file, keyId: "test-key-1" };
}

function context(
  fixture: Fixture,
  transaction: unknown,
  options: { expectedVersion?: number } = {},
): ActionContext {
  const principalId = fixture.admin.principalId;
  return {
    params: { provider: "linear" },
    signal: new AbortController().signal,
    requestId: "request-1",
    traceId: "trace-1",
    transaction,
    principal: { principalId },
    authority: {
      installationAdministrator: true,
      subject: { principalId, principalType: PrincipalType.Human },
    },
    commandMetadata: {
      operation: "integrationClientCredentials.put",
      idempotencyKey: crypto.randomUUID(),
      target: "linear",
      ...(options.expectedVersion === undefined
        ? {}
        : { expectedVersion: options.expectedVersion }),
    },
  } as unknown as ActionContext;
}

const put = (
  fixture: Fixture,
  dependencies: Parameters<typeof putClientCredentials>[2],
  input: { clientId: string; clientSecret: string },
  options: { expectedVersion?: number } = {},
) =>
  withPgTransaction(fixture.appPg, (transaction) =>
    putClientCredentials(
      context(fixture, transaction, options),
      input,
      dependencies,
    ));

const get = (fixture: Fixture) =>
  withPgTransaction(
    fixture.appPg,
    (transaction) =>
      getClientCredentials(context(fixture, transaction), {
        secretsKey: undefined,
        publicBaseUrl: BASE,
      }),
  );

async function counts(fixture: Fixture) {
  const pg = fixture.ownerPg;
  const one = async (sql: string) => (await pg.query(sql)).rows[0].n as number;
  return {
    registrations: await one(
      "select count(*)::int as n from bakery.integration_app_registrations where provider = 'linear'",
    ),
    secrets: await one(
      "select count(*)::int as n from bakery.secrets where provider = 'linear'",
    ),
    versions: await one(
      `select count(*)::int as n from bakery.secret_versions v
         join bakery.secrets s on s.id = v.secret_id where s.provider = 'linear'`,
    ),
    audit: await one(
      `select count(*)::int as n from bakery.audit_events
        where operation = 'integrationClientCredentials.put'`,
    ),
  };
}

async function cleanup(fixture: Fixture) {
  const pg = fixture.ownerPg;
  const providers = "('linear', 'github-test')";
  await pg.query(
    `delete from bakery.integration_app_registrations where provider in ${providers}`,
  );
  // A secret points at its active version and a version at its secret: break the
  // first link before deleting either.
  await pg.query(
    `update bakery.secrets set active_version_id = null where provider in ${providers}`,
  );
  await pg.query(
    `delete from bakery.secret_versions where secret_id in
       (select id from bakery.secrets where provider in ${providers})`,
  );
  await pg.query(`delete from bakery.secrets where provider in ${providers}`);
  await pg.query(
    "delete from bakery.audit_events where operation = 'integrationClientCredentials.put'",
  );
}

Deno.test("client credentials: a first save seals the secret, and nothing readable or secret is returned or audited", async () => {
  const fixture = await openCoordinationFixture();
  const secretsKey = await keyFile();
  try {
    const result = await put(
      fixture,
      { secretsKey, publicBaseUrl: BASE },
      { clientId: "linear-client", clientSecret: SECRET },
    );
    assertEquals(result.configured, true);
    assertEquals(result.clientId, "linear-client");
    assertEquals(result.version, 1);
    assertEquals(
      result.callbackUrl,
      `${BASE}/v1/integration-auth/linear/callback`,
    );
    assert(result.clientSecretSavedAt !== null);
    assertEquals(JSON.stringify(result).includes(SECRET), false);

    const pg = fixture.ownerPg;
    const row = (await pg.query(
      `select r.*, s.organization_id as secret_org, s.application_id as secret_app,
              s.active_version_revision as revision, s.name as secret_name
         from bakery.integration_app_registrations r
         join bakery.secrets s on s.id = r.client_secret_id
        where r.provider = 'linear'`,
    )).rows[0];
    // The columns that describe a GitHub App are left empty for another provider.
    for (
      const column of [
        "external_app_id",
        "slug",
        "owner_login",
        "owner_id",
        "owner_type",
        "html_url",
        "permissions",
        "events",
        "private_key_secret_id",
        "webhook_secret_id",
      ]
    ) assertEquals(row[column], null, column);
    assertEquals(row.status, "registered");
    assertEquals(row.registered_by, fixture.admin.principalId);
    assertEquals(row.revision, 1);
    // An installation secret: no organization, no application.
    assertEquals(row.secret_org, null);
    assertEquals(row.secret_app, null);

    // The stored bytes decrypt to exactly what was sent, and hold nothing readable.
    const version = (await pg.query(
      `select v.ciphertext, v.nonce, v.key_id, v.revision, v.secret_id
         from bakery.secret_versions v where v.id =
           (select active_version_id from bakery.secrets where id = $1)`,
      [row.client_secret_id],
    )).rows[0];
    const cipher = SecretCipherSchema.parse({
      ciphertext: version.ciphertext,
      nonce: version.nonce,
    });
    const key = await loadSecretKey(secretsKey);
    const plain = await decryptInstallationSecret(
      key,
      {
        secretId: version.secret_id,
        revision: version.revision,
        keyId: version.key_id,
      },
      cipher,
    );
    assertEquals(new TextDecoder().decode(plain), SECRET);
    assertEquals(
      JSON.stringify(version.ciphertext).includes(SECRET) ||
        String(version.ciphertext).includes(SECRET),
      false,
    );

    // The audit row names the provider and a revision, and never the secret.
    const audit = (await pg.query(
      `select details::text as details, resource_id from bakery.audit_events
        where operation = 'integrationClientCredentials.put'`,
    )).rows;
    assertEquals(audit.length, 1);
    assertEquals(audit[0].details.includes(SECRET), false);
    assertEquals(audit[0].details.includes("linear-client"), false);
    const details = JSON.parse(audit[0].details);
    assertEquals(details.provider, "linear");
    assertEquals(details.replaced, false);
    assertEquals(details.secretRevision, 1);

    // And a read shows the same thing: the ID and when, never the secret.
    const read = await get(fixture);
    assertEquals(read.clientId, "linear-client");
    assertEquals(read.clientSecretSavedAt, result.clientSecretSavedAt);
    assertEquals(read.version, 1);
    assertEquals(JSON.stringify(read).includes(SECRET), false);
  } finally {
    try {
      await cleanup(fixture);
    } finally {
      await Deno.remove(secretsKey.file);
      await fixture.close();
    }
  }
});

Deno.test("client credentials: a replacement is the next revision of the same secret, and the earlier one is kept", async () => {
  const fixture = await openCoordinationFixture();
  const secretsKey = await keyFile();
  const dependencies = { secretsKey, publicBaseUrl: BASE };
  try {
    const first = await put(fixture, dependencies, {
      clientId: "linear-client",
      clientSecret: SECRET,
    });
    const before = (await fixture.ownerPg.query(
      `select id, generation, invalidation_generation, active_version_revision
         from bakery.secrets where provider = 'linear'`,
    )).rows[0];
    const second = await put(
      fixture,
      dependencies,
      { clientId: "linear-client-2", clientSecret: NEXT_SECRET },
      { expectedVersion: first.version },
    );
    assertEquals(second.version, 2);
    assertEquals(second.clientId, "linear-client-2");
    assert(
      new Date(second.clientSecretSavedAt!).getTime() >=
        new Date(first.clientSecretSavedAt!).getTime(),
    );

    const pg = fixture.ownerPg;
    const after = (await pg.query(
      `select id, generation, invalidation_generation, active_version_revision
         from bakery.secrets where provider = 'linear'`,
    )).rows[0];
    // The same secret, advanced: anything that cached the old value invalidates.
    assertEquals(after.id, before.id);
    assertEquals(after.active_version_revision, 2);
    assertEquals(after.generation, before.generation + 1);
    assertEquals(
      after.invalidation_generation,
      before.invalidation_generation + 1,
    );
    const versions = (await pg.query(
      `select revision, ciphertext, nonce, key_id from bakery.secret_versions
        where secret_id = $1 order by revision`,
      [after.id],
    )).rows;
    assertEquals(versions.map((row) => row.revision), [1, 2]);
    const key = await loadSecretKey(secretsKey);
    const decrypted: string[] = [];
    for (const version of versions) {
      decrypted.push(
        new TextDecoder().decode(
          await decryptInstallationSecret(
            key,
            {
              secretId: after.id,
              revision: version.revision,
              keyId: version.key_id,
            },
            SecretCipherSchema.parse({
              ciphertext: version.ciphertext,
              nonce: version.nonce,
            }),
          ),
        ),
      );
    }
    assertEquals(decrypted, [SECRET, NEXT_SECRET]);
    assertEquals(
      await counts(fixture),
      { registrations: 1, secrets: 1, versions: 2, audit: 2 },
    );
  } finally {
    try {
      await cleanup(fixture);
    } finally {
      await Deno.remove(secretsKey.file);
      await fixture.close();
    }
  }
});

Deno.test("client credentials: a stale, missing or unexpected version changes nothing", async () => {
  const fixture = await openCoordinationFixture();
  const secretsKey = await keyFile();
  const dependencies = { secretsKey, publicBaseUrl: BASE };
  try {
    const refused = async (
      expectedVersion: number | undefined,
      code: string,
      input = { clientId: "other", clientSecret: "other-secret" },
    ) => {
      const before = await counts(fixture);
      const error = await assertRejects(
        () =>
          put(
            fixture,
            dependencies,
            input,
            expectedVersion === undefined ? {} : { expectedVersion },
          ),
        StandardError,
      );
      assertEquals(error.code, code);
      assertEquals(await counts(fixture), before);
    };
    // Nothing registered: a version has nothing to hold the caller to.
    await refused(1, "PRECONDITION_FAILED");
    await put(fixture, dependencies, {
      clientId: "linear-client",
      clientSecret: SECRET,
    });
    // Registered: the version is required, and it must be current.
    await refused(undefined, "PRECONDITION_REQUIRED");
    await refused(0, "PRECONDITION_FAILED");
    await refused(2, "PRECONDITION_FAILED");
    // An invalid credential is refused and writes nothing either.
    const error = await assertRejects(
      () =>
        put(
          fixture,
          dependencies,
          { clientId: " padded", clientSecret: SECRET },
          { expectedVersion: 1 },
        ),
      StandardError,
    );
    assertEquals(error.code, "UNPROCESSABLE");
    assertEquals(
      await counts(fixture),
      { registrations: 1, secrets: 1, versions: 1, audit: 1 },
    );
    assertEquals((await get(fixture)).clientId, "linear-client");
  } finally {
    try {
      await cleanup(fixture);
    } finally {
      await Deno.remove(secretsKey.file);
      await fixture.close();
    }
  }
});

Deno.test("client credentials: two first saves cannot both win, and the loser leaves nothing behind", async () => {
  const fixture = await openCoordinationFixture();
  const secretsKey = await keyFile();
  const dependencies = { secretsKey, publicBaseUrl: BASE };
  try {
    const results = await Promise.allSettled([
      put(fixture, dependencies, {
        clientId: "a-client",
        clientSecret: "secret-a",
      }),
      put(fixture, dependencies, {
        clientId: "b-client",
        clientSecret: "secret-b",
      }),
      put(fixture, dependencies, {
        clientId: "c-client",
        clientSecret: "secret-c",
      }),
    ]);
    const won = results.filter((result) => result.status === "fulfilled");
    assertEquals(won.length, 1);
    for (const result of results) {
      if (result.status === "rejected") {
        const error = result.reason as StandardError;
        assert(error instanceof StandardError, String(result.reason));
        assertEquals(error.code, "PRECONDITION_FAILED");
      }
    }
    // One registration, one secret, one version, one audit row: the losers rolled
    // back whole, including the secret they had already inserted.
    assertEquals(
      await counts(fixture),
      { registrations: 1, secrets: 1, versions: 1, audit: 1 },
    );
  } finally {
    try {
      await cleanup(fixture);
    } finally {
      await Deno.remove(secretsKey.file);
      await fixture.close();
    }
  }
});

Deno.test("client credentials: without an installation key nothing is written", async () => {
  const fixture = await openCoordinationFixture();
  try {
    const before = await counts(fixture);
    const error = await assertRejects(
      () =>
        put(
          fixture,
          { secretsKey: undefined, publicBaseUrl: BASE },
          { clientId: "linear-client", clientSecret: SECRET },
        ),
      StandardError,
    );
    assertEquals(error.code, "STATE_CONFLICT");
    assertEquals(await counts(fixture), before);
  } finally {
    try {
      await cleanup(fixture);
    } finally {
      await fixture.close();
    }
  }
});

Deno.test("client credentials: a provider's row sits beside GitHub's in the shared table and neither sees the other", async () => {
  const fixture = await openCoordinationFixture();
  const secretsKey = await keyFile();
  const pg = fixture.ownerPg;
  try {
    // A complete GitHub-shaped registration, as the GitHub flow writes it.
    const secretIds = [crypto.randomUUID(), crypto.randomUUID()];
    for (const id of secretIds) {
      await pg.query(
        `insert into bakery.secrets (id, organization_id, application_id, name,
           provider, allowed_principals, allowed_actions)
         values ($1, null, null, 'GitHub test secret', 'github-test', '[]'::jsonb, '[]'::jsonb)`,
        [id],
      );
    }
    await pg.query(
      `insert into bakery.integration_app_registrations (
         id, provider, external_app_id, slug, name, client_id, owner_login,
         owner_id, owner_type, html_url, permissions, events, client_secret_id,
         private_key_secret_id, status, registered_by
       ) values ($1, 'github-test', 42, 'test-app', 'Test App', 'gh-client', 'octo',
         7, 'Organization', 'https://github.example/apps/test-app', '{}'::jsonb,
         '[]'::jsonb, $2, $3, 'registered', $4)`,
      [
        crypto.randomUUID(),
        secretIds[0],
        secretIds[1],
        fixture.admin.principalId,
      ],
    );
    const githubBefore = JSON.stringify(
      (await pg.query(
        "select * from bakery.integration_app_registrations where provider = 'github-test'",
      )).rows,
    );

    await put(fixture, { secretsKey, publicBaseUrl: BASE }, {
      clientId: "linear-client",
      clientSecret: SECRET,
    });

    // The GitHub row is byte-for-byte what it was, still complete, and the
    // provider's row is a separate one: one per provider.
    assertEquals(
      JSON.stringify(
        (await pg.query(
          "select * from bakery.integration_app_registrations where provider = 'github-test'",
        )).rows,
      ),
      githubBefore,
    );
    assertEquals(
      (await pg.query(
        "select count(*)::int as n from bakery.integration_app_registrations where provider in ('linear', 'github-test')",
      )).rows[0].n,
      2,
    );
    // GitHub's readers filter by provider, so a provider row without an App id or
    // private key is invisible to the join GitHub's callback runs.
    const visibleToGitHubJoin = (await pg.query(
      `select r.provider from bakery.integration_app_registrations r
         join bakery.secrets pk on pk.id = r.private_key_secret_id
        where r.provider in ('linear', 'github-test')`,
    )).rows.map((row) => row.provider);
    assertEquals(visibleToGitHubJoin, ["github-test"]);
  } finally {
    try {
      await cleanup(fixture);
    } finally {
      await Deno.remove(secretsKey.file);
      await fixture.close();
    }
  }
});

Deno.test("client credentials: the application role holds exactly the grants the save needs", async () => {
  const fixture = await openCoordinationFixture();
  try {
    const can = async (sql: string, ...values: unknown[]) =>
      (await fixture.ownerPg.query(sql, values)).rows[0].ok as boolean;
    const update = (table: string, column: string) =>
      can(
        "select has_column_privilege('bakery_app', $1, $2, 'update') as ok",
        `bakery.${table}`,
        column,
      );
    // What a replacement changes is writable...
    for (const column of ["client_id", "updated_at", "version"]) {
      assertEquals(
        await update("integration_app_registrations", column),
        true,
        column,
      );
    }
    // ...and what must never move is not: which provider a row is for, which
    // secret it points at, and who registered it.
    for (
      const column of [
        "provider",
        "client_secret_id",
        "registered_by",
        "private_key_secret_id",
        "id",
      ]
    ) {
      assertEquals(
        await update("integration_app_registrations", column),
        false,
        column,
      );
    }
    assertEquals(
      await can(
        "select has_table_privilege('bakery_app', 'bakery.integration_app_registrations', 'delete') as ok",
      ),
      false,
    );
  } finally {
    await fixture.close();
  }
});

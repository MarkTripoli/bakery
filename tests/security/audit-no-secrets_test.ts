import { assert, assertEquals } from "@std/assert";
import { SECRET_SHAPES } from "../helpers/secret-shapes.ts";
import {
  call,
  openInstallationFixture,
} from "../helpers/installation-settings.ts";
import { authTestOrigin, cleanupAuthFixture } from "../helpers/auth.ts";
import {
  MATRIX_SSO_SECRETS,
  MATRIX_TOKEN_SECRETS,
  matrixScimSecrets,
  matrixSecretsKey,
  runAuditMatrix,
  runSsoAuditMatrix,
} from "../helpers/audit-matrix.ts";

Deno.test("no audit row produced by an auth mutation carries a secret", async () => {
  const key = await matrixSecretsKey();
  const f = await openInstallationFixture(true, {
    secretsKey: key.secretsKey,
    githubAppClient: key.githubAppClient,
    skillStorageProbe: key.skillStorageProbe,
    backupDestinationProbe: key.backupDestinationProbe,
  });
  try {
    const rows = await runAuditMatrix(f);
    rows.push(...await runSsoAuditMatrix(f));
    // The runner's read of the off-site settings releases the credentials the
    // matrix saved; the audit row that read writes is scanned like the rest.
    const issued = await call(
      f,
      "POST",
      "/v1/installation/backup-runner/credential",
      f.adminCookie,
      { body: {} },
    );
    assertEquals(issued.status, 201, await issued.clone().text());
    const runnerCredential =
      (await issued.json() as { credential: string }).credential;
    // Another file's fixture may have left runner reads in the shared
    // database; this test owns only the release it causes below.
    const releasesBefore = new Set(
      (await f.pgDatabase.query<{ id: string }>(
        `select id from bakery.audit_events
          where operation = 'backupRunner.settings'`,
      )).rows.map((row) => row.id),
    );
    const released = await f.app.fetch(
      new Request(`${authTestOrigin}/v1/backup-runner/settings`, {
        headers: {
          authorization: `Bearer ${runnerCredential}`,
          origin: authTestOrigin,
        },
      }),
    );
    assertEquals(released.status, 200, await released.clone().text());
    const releasedBody = await released.json() as {
      offsiteSecretAccessKey: string | null;
    };
    assertEquals(releasedBody.offsiteSecretAccessKey, "audit-matrix-secret");
    const runnerRowsAfter = (await f.pgDatabase.query<
      {
        id: string;
        organizationId: string | null;
        principalId: string | null;
        operation: string;
        resourceType: string;
        resourceId: string;
        outcome: string;
        requestId: string;
        traceId: string;
        details: unknown;
      }
    >(
      `select id, organization_id as "organizationId", principal_id as "principalId",
              operation, resource_type as "resourceType", resource_id as "resourceId",
              outcome, request_id as "requestId", trace_id as "traceId", details
         from bakery.audit_events where operation = 'backupRunner.settings'`,
    )).rows;
    const runnerRows = runnerRowsAfter.filter((row) =>
      !releasesBefore.has(row.id)
    );
    assertEquals(runnerRows.length, 1, "one release is one audit row");
    rows.push(...runnerRows);
    assert(rows.length > 0);
    const clientSecrets = await f.pgDatabase.query<{ secret: string | null }>(
      `select "clientSecret" as secret from public."oauthClient"
       where name = 'Audit matrix'`,
    );
    const tokenDigests = await f.pgDatabase.query<{ digest: string }>(
      "select secret_sha256 as digest from bakery.access_tokens where organization_id = $1",
      [f.organizationId],
    );
    assert(MATRIX_TOKEN_SECRETS.length > 0, "matrix minted no access token");
    const knownSecrets = [
      ...MATRIX_TOKEN_SECRETS,
      ...MATRIX_SSO_SECRETS,
      "audit-matrix-access",
      "audit-matrix-secret",
      ...tokenDigests.rows.map((row) => row.digest),
      f.password,
      `${f.password}-changed`,
      ...matrixScimSecrets,
      ...clientSecrets.rows.flatMap((row) => row.secret ? [row.secret] : []),
    ];
    for (const row of rows) {
      const surfaces = {
        details: JSON.stringify(row.details),
        resourceId: row.resourceId,
      };
      for (const [surface, text] of Object.entries(surfaces)) {
        for (const secret of knownSecrets) {
          assert(
            !text.includes(secret),
            `${row.operation} ${surface} contains a known secret`,
          );
        }
        for (const [label, pattern] of SECRET_SHAPES) {
          assertEquals(
            pattern.test(text),
            false,
            `${row.operation} ${surface} looks like a ${label}`,
          );
        }
      }
    }
    // The scan itself must catch what it claims to: a JWS is flagged.
    assert(
      SECRET_SHAPES[0][1].test(
        "eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl",
      ),
    );
    assert(SECRET_SHAPES[1][1].test("a".repeat(64)));
    // ...and so is a SCIM bearer secret, the shape the connection issues.
    assert(matrixScimSecrets.length >= 2);
    assert(SECRET_SHAPES[2][1].test(matrixScimSecrets[0]));
  } finally {
    const extra = await f.pgDatabase.query<{ email: string }>(
      "select email from public.\"user\" where email like 'matrix-%@example.test'",
    );
    await f.pgDatabase.query("delete from bakery.scim_connections");
    await cleanupAuthFixture(f.pgDatabase, extra.rows.map((row) => row.email));
    await f.finish();
    await key.remove();
  }
});

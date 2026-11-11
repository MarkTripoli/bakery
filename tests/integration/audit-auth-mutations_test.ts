import { assert, assertEquals } from "@std/assert";
import { cleanupAuthFixture } from "../helpers/auth.ts";
import { openInstallationFixture } from "../helpers/installation-settings.ts";
import {
  matrixSecretsKey,
  runAuditMatrix,
  runSsoAuditMatrix,
} from "../helpers/audit-matrix.ts";

Deno.test("every auth mutation writes exactly one audit row on success and none on failure", async () => {
  const key = await matrixSecretsKey();
  const f = await openInstallationFixture(true, {
    secretsKey: key.secretsKey,
    githubAppClient: key.githubAppClient,
    skillStorageProbe: key.skillStorageProbe,
  });
  try {
    const rows = await runAuditMatrix(f);
    assert(rows.length >= 20, `matrix produced ${rows.length} rows`);
    assertEquals(new Set(rows.map((row) => row.id)).size, rows.length);
    // Plugin-endpoint mutations (SSO).
    const ssoRows = await runSsoAuditMatrix(f);
    assert(ssoRows.length >= 5, `SSO matrix produced ${ssoRows.length} rows`);
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

// Exercises the
// *shipped* `apps/server/src/main.ts` process under the compose stack, not
// `createApp(...)` in-process. A test belongs here only if the in-process
// lanes (contract/integration/security/recovery) cannot observe the failure
// it defends against.
import { assert, assertEquals } from "@std/assert";
import { upStack } from "./helpers/stack.ts";

const MIGRATION_VERSIONS = [
  "0001_better_auth",
  "0002_application_grants",
  "0003_bakery_authority_columns",
  "0004_two_factor_assurance",
  "0005_passkey",
  "0006_profile_fields",
  "0007_session_passkey",
  "0008_session_reauthenticated_at",
  "0009_oauth_provider",
  "0010_permission_roles",
  "0011_scim",
  "0012_sso_provider",
  "0013_rate_limit_timestamp_double_precision",
];

Deno.test(
  "backend e2e stack boots, migrates and fails closed on bad config",
  { sanitizeResources: false, sanitizeOps: false },
  async (t) => {
    const stack = await upStack("stack");
    try {
      await t.step("boots and serves health", async () => {
        const live = await fetch(`${stack.origin}/health/live`);
        assertEquals(live.status, 200);
        const ready = await fetch(`${stack.origin}/health/ready`);
        assertEquals(ready.status, 200);
        const body = await ready.json() as {
          dependencies: { name: string; state: string }[];
        };
        const database = body.dependencies.find((d) => d.name === "database");
        const postgres = body.dependencies.find((d) => d.name === "postgres");
        assertEquals(database?.state, "ok");
        assertEquals(postgres?.state, "ok");
      });

      await t.step(
        "shipped migrations ran as owner, server runs as app role",
        async () => {
          const migrations = await stack.psql<{ version: string }>(
            `select version from public.better_auth_schema_migrations order by version`,
          );
          assertEquals(
            migrations.map((row) => row.version),
            MIGRATION_VERSIONS,
          );

          const insertAllowed = await stack.psql<{ allowed: boolean }>(
            `select has_table_privilege('bakery_app', 'public."twoFactor"', 'INSERT') as allowed`,
          );
          assert(
            insertAllowed[0].allowed,
            "bakery_app must be able to write twoFactor rows",
          );

          const createAllowed = await stack.psql<{ allowed: boolean }>(
            `select has_database_privilege('bakery_app', 'bakery', 'CREATE') as allowed`,
          );
          assert(
            !createAllowed[0].allowed,
            "bakery_app must not hold CREATE on the bakery database",
          );
        },
      );

      await t.step("process is fail-closed on startup config", async () => {
        const result = await stack.runOneOff([
          "run",
          "--rm",
          "-e",
          "BETTER_AUTH_SECRET=short",
          "server",
        ]);
        assert(
          !result.success,
          "server must exit non-zero on an invalid secret",
        );
        assert(
          result.output.includes("BETTER_AUTH_SECRET"),
          `startup failure must name the offending variable; got: ${result.output}`,
        );
      });
    } finally {
      await stack.down();
    }
  },
);

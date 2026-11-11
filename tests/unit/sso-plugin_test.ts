import { assert, assertEquals } from "@std/assert";
import { readRuntimeConfig } from "../../packages/config/src/env.ts";
import { buildBetterAuthOptions } from "../../apps/server/src/modules/auth/adapters/better-auth.ts";
import type { PgDatabase } from "../../apps/server/src/platform/database.ts";
import { AUDIT_MATRIX_PLUGIN_OPERATIONS } from "../helpers/audit-matrix-actions.ts";
import { SSO_AUDIT_OPERATIONS } from "../../apps/server/src/modules/auth/sso/operations.ts";
import { redactSecrets } from "../../apps/server/src/modules/auth/sso/plugin.ts";

const database = {
  query: () => Promise.reject(new Error("not used while building options")),
} as unknown as PgDatabase;

function authConfig() {
  const config = readRuntimeConfig({
    BAKERY_ENV: "test",
    BAKERY_APP_DATABASE_URL: "postgres://bakery_app:pw@127.0.0.1:5432/bakery",
    BAKERY_PUBLIC_BASE_URL: "http://127.0.0.1:8788",
    BETTER_AUTH_SECRET: "phase-16-test-only-secret-value-32-bytes",
    GITHUB_CLIENT_ID: "client-id",
    GITHUB_CLIENT_SECRET: "client-secret",
  });
  return config.auth!;
}

const SSO_PLUGIN_IDS = ["sso", "bakery-sso-guard", "bakery-sso-enforcement"];

Deno.test("the SSO plugins mount and GitHub sign-in stays configured", () => {
  const options = buildBetterAuthOptions({
    pgDatabase: database,
    config: authConfig(),
  });
  const ids = options.plugins.map((plugin) => plugin.id);
  for (const id of SSO_PLUGIN_IDS) assert(ids.includes(id), `mounts ${id}`);
  assertEquals(options.socialProviders, {
    github: { clientId: "client-id", clientSecret: "client-secret" },
  });
});

Deno.test("the SSO audit operations are the five the integration suite exercises", () => {
  assertEquals(
    Object.values(SSO_AUDIT_OPERATIONS).sort(),
    [...AUDIT_MATRIX_PLUGIN_OPERATIONS].sort(),
  );
});

Deno.test("redactSecrets drops credential fields at any depth and leaves the rest", () => {
  const payload = {
    providerId: "p",
    oidcConfig: { clientId: "c", clientSecret: "s" },
    samlConfig: {
      cert: "public",
      privateKey: "k",
      idpMetadata: { entityID: "e", encPrivateKey: "ek", privateKeyPass: "pw" },
      list: [{ privateKey: "k2", keep: 1 }],
    },
  };
  assertEquals(redactSecrets(payload), {
    providerId: "p",
    oidcConfig: { clientId: "c" },
    samlConfig: {
      cert: "public",
      idpMetadata: { entityID: "e" },
      list: [{ keep: 1 }],
    },
  });
});

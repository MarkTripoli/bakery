import { assertEquals } from "@std/assert";
import { createApp } from "../../apps/server/src/app.ts";
import { createReadyAuthProvider } from "../../apps/server/src/modules/auth/index.ts";
import { createPostgresAuthPersistence } from "../../apps/server/src/modules/auth/adapters/postgres.ts";
import {
  readRuntimeConfig,
  readTestDatabaseConfig,
} from "../../packages/config/src/env.ts";
import {
  closeDatabase,
  closePgDatabase,
  openDatabase,
  openPgDatabase,
} from "../../apps/server/src/platform/database.ts";

/**
 * The app must BOOT.
 *
 * QA found this the hard way at 9b8e48d2: `createApp` threw
 * `ActionRegistryError: action integrationConnections.invoke organization
 * context mismatch: runtime required_authenticated_context, catalog none`, so
 * the server did not start at all. The door unit tests could never see it
 * because they never build the app - they call the handler with a context they
 * made themselves.
 *
 * The catalog and the registered policy are two sources of one fact, and only
 * `createApp` compares them. That comparison is what this test performs, by
 * building the app for real.
 */

async function buildApp(secret: string) {
  const { appDatabaseUrl } = readTestDatabaseConfig();
  const appPg = openPgDatabase(appDatabaseUrl);
  const appDatabase = openDatabase(appDatabaseUrl);
  const config = readRuntimeConfig({
    BAKERY_ENV: "test",
    BAKERY_APP_DATABASE_URL: appDatabaseUrl,
    BAKERY_PUBLIC_BASE_URL: "http://127.0.0.1:8788",
    BETTER_AUTH_SECRET: secret,
  });
  const persistence = createPostgresAuthPersistence(appPg);
  const auth = await createReadyAuthProvider({
    pgDatabase: appPg,
    config: config.auth!,
    persistence,
  });
  const app = createApp({
    config,
    database: appDatabase,
    pgDatabase: appPg,
    auth,
    authPersistence: persistence,
  });
  return {
    app,
    close: async () => {
      await closePgDatabase(appPg);
      await closeDatabase(appDatabase);
    },
  };
}

Deno.test("the app boots: the catalog and the registered action policy agree", async () => {
  const server = await buildApp("a".repeat(32));
  try {
    // Reaching here at all is the assertion: createApp validates every
    // registered action against the catalog, and a mismatch throws.
    assertEquals(typeof server.app.request, "function");
  } finally {
    await server.close();
  }
});

Deno.test("the invoke route answers on the mounted app instead of 404", async () => {
  const server = await buildApp("b".repeat(32));
  try {
    const response = await server.app.request(
      "/v1/integration-connections/00000000-0000-4000-8000-000000009901/actions",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "github.issue.comment.create",
          arguments: { resourceId: "00000000-0000-4000-8000-000000009902" },
        }),
      },
    );
    // A 404 would mean the route is not mounted; MALFORMED_REQUEST would mean the
    // transport schema is rewriting the action id again. Unauthenticated, the
    // honest answer is an authorization refusal from the gate.
    assertEquals(
      response.status === 404,
      false,
      "the invoke route must be mounted on the real app",
    );
    assertEquals(
      response.status === 422,
      false,
      "a real integration action id must not be rejected as malformed",
    );
    assertEquals(
      [401, 403].includes(response.status),
      true,
      `unauthenticated callers must be refused with an authorization error, got ${response.status}`,
    );
  } finally {
    await server.close();
  }
});

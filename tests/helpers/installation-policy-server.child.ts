import {
  readRuntimeConfig,
  readTestDatabaseConfig,
} from "../../packages/config/src/env.ts";
import { createApp } from "../../apps/server/src/app.ts";
import { createReadyAuthProvider } from "../../apps/server/src/modules/auth/index.ts";
import { createPostgresAuthPersistence } from "../../apps/server/src/modules/auth/adapters/postgres.ts";
import {
  closeDatabase,
  closePgDatabase,
  openDatabase,
  openPgDatabase,
} from "../../apps/server/src/platform/database.ts";
import { authTestOrigin, authTestSecret } from "./auth.ts";

const { appDatabaseUrl } = readTestDatabaseConfig();
const database = openDatabase(appDatabaseUrl);
const pgDatabase = openPgDatabase(appDatabaseUrl);
const config = readRuntimeConfig({
  BAKERY_ENV: "test",
  BAKERY_APP_DATABASE_URL: appDatabaseUrl,
  BAKERY_PUBLIC_BASE_URL: authTestOrigin,
  BETTER_AUTH_SECRET: authTestSecret,
});
const persistence = createPostgresAuthPersistence(pgDatabase);
try {
  const auth = await createReadyAuthProvider({
    pgDatabase,
    config: config.auth!,
    persistence,
  });
  const app = createApp({
    config,
    database,
    pgDatabase,
    auth,
    authPersistence: persistence,
  });
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: () => {},
  }, (request, info) => app.fetch(request, { remoteAddr: info.remoteAddr }));
  console.log(JSON.stringify({ url: `http://127.0.0.1:${server.addr.port}` }));
  try {
    await Deno.stdin.read(new Uint8Array(1));
  } finally {
    await server.shutdown();
  }
} finally {
  await Promise.all([closeDatabase(database), closePgDatabase(pgDatabase)]);
}

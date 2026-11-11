import { readRuntimeConfig } from "../../../packages/config/src/env.ts";
import { createApp } from "../../../apps/server/src/app.ts";
import {
  createReadyAuthProvider,
} from "../../../apps/server/src/modules/auth/index.ts";
import { createPostgresAuthPersistence } from "../../../apps/server/src/modules/auth/adapters/postgres.ts";
import {
  closeDatabase,
  closePgDatabase,
  openDatabase,
  openPgDatabase,
} from "../../../apps/server/src/platform/database.ts";

const appDatabaseUrl = Deno.env.get("FIXTURE_APP_DATABASE_URL");
const publicBaseUrl = Deno.env.get("FIXTURE_PUBLIC_BASE_URL");
const secret = Deno.env.get("FIXTURE_AUTH_SECRET");
const port = Number(Deno.env.get("FIXTURE_PORT"));
if (!appDatabaseUrl || !publicBaseUrl || !secret || !Number.isInteger(port)) {
  throw new Error("FIXTURE_ENV_REQUIRED");
}

const config = readRuntimeConfig({
  BAKERY_ENV: "test",
  BAKERY_APP_DATABASE_URL: appDatabaseUrl,
  BAKERY_PUBLIC_BASE_URL: publicBaseUrl,
  BAKERY_SERVER_HOST: "127.0.0.1",
  BAKERY_SERVER_PORT: String(port),
  BETTER_AUTH_SECRET: secret,
});
const database = openDatabase(appDatabaseUrl);
const pgDatabase = openPgDatabase(appDatabaseUrl);
const persistence = createPostgresAuthPersistence(pgDatabase);
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
const server = Deno.serve(
  { hostname: "127.0.0.1", port },
  (request, info) => app.fetch(request, { remoteAddr: info.remoteAddr }),
);
console.log(`FIXTURE_PORT=${server.addr.port}`);

let shutdownPromise: Promise<void> | undefined;
function shutdown(): Promise<void> {
  return shutdownPromise ??= (async () => {
    await server.shutdown();
    await Promise.all([
      closePgDatabase(pgDatabase),
      closeDatabase(database),
    ]);
  })();
}
const stop = () => void shutdown();
Deno.addSignalListener("SIGTERM", stop);
Deno.addSignalListener("SIGINT", stop);
try {
  await server.finished;
} finally {
  Deno.removeSignalListener("SIGTERM", stop);
  Deno.removeSignalListener("SIGINT", stop);
  await shutdown();
}

import { createApp } from "../../apps/server/src/app.ts";
import { createReadyAuthProvider } from "../../apps/server/src/modules/auth/index.ts";
import { createPostgresAuthPersistence } from "../../apps/server/src/modules/auth/adapters/postgres.ts";
import type { SkillImportCheckpointBoundary } from "../../apps/server/src/modules/catalog/import-workflow.ts";
import {
  createSkillSourceAdapterForTest,
  normalizeSkillSourceLocatorForTest,
} from "../../apps/server/src/modules/catalog/source-adapters.ts";
import { SkillFileStore } from "../../apps/server/src/modules/catalog/storage.ts";
import {
  closeDatabase,
  closePgDatabase,
  openDatabase,
  openPgDatabase,
} from "../../apps/server/src/platform/database.ts";
import { readRuntimeConfig } from "../../packages/config/src/env.ts";
import { problemResponse } from "../../packages/contracts/src/http.ts";

function required(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

function requiredPort(name: string): number {
  const port = Number(required(name));
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name}_INVALID`);
  }
  return port;
}

const appDatabaseUrl = required("BAKERY_APP_DATABASE_URL");
const skillRoot = required("BAKERY_SKILL_FILE_ROOT");
const faultRoot = required("BAKERY_IMPORT_FAULT_ROOT");
const port = requiredPort("BAKERY_SERVER_PORT");
const publicBaseUrl = `http://127.0.0.1:${port}`;
const config = readRuntimeConfig({
  BAKERY_ENV: "test",
  BAKERY_SERVER_HOST: "0.0.0.0",
  BAKERY_SERVER_PORT: String(port),
  BAKERY_APP_DATABASE_URL: appDatabaseUrl,
  BAKERY_PUBLIC_BASE_URL: publicBaseUrl,
  BETTER_AUTH_SECRET: required("BETTER_AUTH_SECRET"),
  BAKERY_SKILL_FILE_ROOT: skillRoot,
  INNGEST_URL: required("INNGEST_URL"),
  INNGEST_SIGNING_KEY: required("INNGEST_SIGNING_KEY"),
  INNGEST_EVENT_KEY: required("INNGEST_EVENT_KEY"),
  BAKERY_INNGEST_LOCAL_COMPOSE: "1",
});
const database = openDatabase(appDatabaseUrl);
const pgDatabase = openPgDatabase(appDatabaseUrl);
const persistence = createPostgresAuthPersistence(pgDatabase);
const auth = await createReadyAuthProvider({
  pgDatabase,
  config: config.auth!,
  persistence,
});
const store = new SkillFileStore(skillRoot);
await store.initialize();

async function afterCheckpoint(
  boundary: SkillImportCheckpointBoundary,
  runId: string,
): Promise<void> {
  const armedPath = `${faultRoot}/armed`;
  let armed: string;
  try {
    armed = (await Deno.readTextFile(armedPath)).trim();
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
  if (armed !== boundary) return;
  const consumedPath = `${faultRoot}/consumed-${boundary}-${runId}`;
  try {
    await Deno.rename(armedPath, consumedPath);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
  await Deno.writeTextFile(
    `${faultRoot}/reached`,
    JSON.stringify({ boundary, runId }),
  );
  await new Promise(() => undefined);
}

const app = createApp({
  config,
  database,
  pgDatabase,
  auth,
  authPersistence: persistence,
  skillFileStore: store,
  skillSourceAdapter: createSkillSourceAdapterForTest({
    allowInsecureLoopback: true,
  }),
  skillSourceLocatorNormalizer: normalizeSkillSourceLocatorForTest,
  skillImportProcessHooks: { afterCheckpoint },
});
app.onError((error, context) => {
  console.error("REAL_SKILL_IMPORT_SERVER_ERROR", error);
  return problemResponse(context, error, { publicBaseUrl });
});
const server = Deno.serve(
  {
    hostname: "0.0.0.0",
    port,
    onListen() {
      console.log(`SERVER_PORT=${port}`);
    },
  },
  (request, info) => app.fetch(request, { remoteAddr: info.remoteAddr }),
);

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await server.shutdown();
  await Promise.all([
    closePgDatabase(pgDatabase),
    closeDatabase(database),
  ]);
}
Deno.addSignalListener("SIGTERM", () => void shutdown());
Deno.addSignalListener("SIGINT", () => void shutdown());
await server.finished;

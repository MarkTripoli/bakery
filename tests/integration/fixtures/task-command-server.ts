import { createApiRouter } from "../../../packages/contracts/src/http.ts";
import { openPgDatabase } from "../../../apps/server/src/platform/database.ts";
import { PostgresAuthorityRunner } from "../../../apps/server/src/modules/auth/adapters/authority-postgres.ts";
import { createWorkTaskHandlers } from "../../../apps/server/src/modules/work/index.ts";
import { createPostgresCommandRunner } from "../../../apps/server/src/platform/command-replay.ts";
import { createTaskActionRegistry } from "../../../apps/server/src/task-actions.ts";
import {
  createProjectsActionRegistry,
  createProjectsHandlers,
} from "../../../apps/server/src/modules/projects/index.ts";

const appUrl = Deno.env.get("FIXTURE_APP_DATABASE_URL");
const principalId = Deno.env.get("FIXTURE_PRINCIPAL_ID");
const displayName = Deno.env.get("FIXTURE_DISPLAY_NAME") ?? "Fixture Principal";
const dropKey = Deno.env.get("FIXTURE_DROP_KEY") ?? "";
const port = Number(Deno.env.get("FIXTURE_PORT") ?? "0");
if (!appUrl || !principalId) {
  throw new Error("FIXTURE_ENV_REQUIRED");
}

const pg = openPgDatabase(appUrl, 2);
const authorityRunner = new PostgresAuthorityRunner(pg);
const commandRunner = createPostgresCommandRunner();
const taskRegistry = createTaskActionRegistry(
  createWorkTaskHandlers("task-command-fixture-cursor-secret"),
  { authorityRunner, commandRunner },
);
const projectsRegistry = createProjectsActionRegistry(
  createProjectsHandlers("task-command-fixture-cursor-secret"),
  { authorityRunner, commandRunner },
);
const createContext = () => ({
  principal: { principalId, principalType: "human", displayName },
});
const app = createApiRouter({ registry: taskRegistry, createContext });
app.route(
  "/",
  createApiRouter({ registry: projectsRegistry, createContext }),
);

const server = Deno.serve({ hostname: "127.0.0.1", port }, async (request) => {
  const response = await app.fetch(request);
  const key = request.headers.get("idempotency-key");
  if (dropKey && key === dropKey) {
    await response.text();
    Deno.exit(0);
  }
  return response;
});
console.log(`FIXTURE_PORT=${server.addr.port}`);
await server.finished;

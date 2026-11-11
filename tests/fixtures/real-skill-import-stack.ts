import { createSuperuser } from "../../apps/server/src/modules/auth/index.ts";
import type { SkillImportCheckpointBoundary } from "../../apps/server/src/modules/catalog/import-workflow.ts";
import {
  closePgDatabase,
  openPgDatabase,
} from "../../apps/server/src/platform/database.ts";
import { readRuntimeConfig } from "../../packages/config/src/env.ts";
import {
  bindLoopbackPortWithRetry,
  reserveUniqueLoopbackPort,
} from "./loopback-port-allocation.ts";
import {
  type RunningRemoteSkillSourceFixture,
  startRemoteSkillSourceFixture,
  stopRemoteSkillSourceFixture,
} from "./remote-skill-source.ts";

const decoder = new TextDecoder();
const inngestImage =
  "inngest/inngest:v1.44.0@sha256:d5365a31f8bf504dc2d54ddd114fcdc1a0413f8b57a450365c095ab6234ad8c2";
const redisImage =
  "redis:7.4-alpine@sha256:ff02b58f971e7d7d156a1267e283fcbbeee91773b6aa36c49dac28ecfe28eadf";
const expectedFunctionIds = Object.freeze([
  "bakery-fixed-workflow",
  "bakery-skill-import",
  "bakery-skill-import-recovery",
  "bakery-workflow-recovery",
]);

type ProcessHandle = {
  child: Deno.ChildProcess;
  tail: string[];
};

type ImportSnapshot = Readonly<{
  runStatus: string;
  state: string;
  sourceRevision: string | null;
  sourceProofDigest: string | null;
  skillId: string | null;
  skillVersionId: string | null;
  versionStatus: string | null;
  activeVersionId: string | null;
  fileInventory: unknown;
  terminalFault: unknown;
  runCount: string;
  checkpointCount: string;
  skillCount: string;
  versionCount: string;
  fileCount: string;
  eventCount: string;
  stepCount: string;
  jobCount: string;
}>;

export type RealSkillImportStack = Readonly<{
  project: string;
  root: string;
  serverUrl: string;
  inngestUrl: string;
  postgresPort: number;
  source: RunningRemoteSkillSourceFixture;
  organizationId: string;
  cookie: string;
  registerSource: (
    sourceType: "git" | "url",
    url: string,
    name?: string,
  ) => Promise<{ id: string; version: number }>;
  requestImport: (
    sourceId: string,
    revision: string,
    path?: string,
    key?: string,
  ) => Promise<Record<string, unknown>>;
  getRun: (runId: string) => Promise<Record<string, unknown>>;
  waitTerminal: (runId: string) => Promise<Record<string, unknown>>;
  armBoundary: (boundary: SkillImportCheckpointBoundary) => Promise<void>;
  waitBoundary: (
    boundary: SkillImportCheckpointBoundary,
    runId: string,
  ) => Promise<void>;
  snapshot: (runId: string) => Promise<ImportSnapshot>;
  functionIds: () => Promise<readonly string[]>;
  databaseIdentities: () => Promise<readonly string[]>;
  disableSource: (sourceId: string, version: number) => Promise<void>;
  revokeRequester: (runId: string) => Promise<void>;
  stopServer: () => Promise<void>;
  restartServer: () => Promise<void>;
  stopDispatch: () => Promise<void>;
  restartDispatch: () => Promise<void>;
  stopEngine: () => Promise<void>;
  restartEngine: () => Promise<void>;
  stopPostgres: () => Promise<void>;
  restartPostgres: () => Promise<void>;
  cleanup: () => Promise<void>;
}>;

type CommandResult = { success: boolean; output: string };

function required(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processEnvironment(
  extra: Record<string, string>,
): Record<string, string> {
  const inheritedDenoDir = Deno.env.get("DENO_DIR");
  return {
    PATH: "/usr/bin:/bin",
    HOME: Deno.env.get("HOME") ?? "/nonexistent",
    LC_ALL: "C",
    NO_COLOR: "1",
    ...(inheritedDenoDir ? { DENO_DIR: inheritedDenoDir } : {}),
    ...extra,
  };
}

async function consume(
  stream: ReadableStream<Uint8Array>,
  tail: string[],
): Promise<void> {
  const reader = stream.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return;
      for (
        const line of decoder.decode(next.value, { stream: true }).split("\n")
      ) {
        if (!line) continue;
        tail.push(line);
        if (tail.length > 80) tail.shift();
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function spawnProcess(
  args: readonly string[],
  env: Record<string, string>,
): ProcessHandle {
  const child = new Deno.Command(Deno.execPath(), {
    args: [...args],
    cwd: Deno.cwd(),
    clearEnv: true,
    env: processEnvironment(env),
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const tail: string[] = [];
  void consume(child.stdout, tail);
  void consume(child.stderr, tail);
  return { child, tail };
}

async function stopProcess(handle: ProcessHandle | undefined): Promise<void> {
  if (!handle) return;
  try {
    handle.child.kill("SIGTERM");
  } catch {
    return;
  }
  const exited = await Promise.race([
    handle.child.status.then(() => true),
    delay(1_500).then(() => false),
  ]);
  if (!exited) {
    try {
      handle.child.kill("SIGKILL");
    } catch {
      // The owned process exited between the timeout and kill.
    }
  }
  await handle.child.status.catch(() => undefined);
}

async function waitHttp(url: string, process?: ProcessHandle): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (process) {
      const status = await Promise.race([
        process.child.status.then((value) => value),
        Promise.resolve(undefined),
      ]);
      if (status && !status.success) {
        throw new Error(`OWNED_PROCESS_EXITED:${process.tail.join("\n")}`);
      }
    }
    try {
      const response = await fetch(url);
      if (response.ok) {
        await response.body?.cancel();
        return;
      }
    } catch {
      // Process or container is not ready yet.
    }
    await delay(250);
  }
  throw new Error(`READINESS_TIMEOUT:${url}:${process?.tail.join("|") ?? ""}`);
}

function publishedPort(output: string): number {
  const match = /127\.0\.0\.1:(\d+)/.exec(output);
  const port = Number(match?.[1]);
  if (!Number.isInteger(port) || port < 1) {
    throw new Error(`PUBLISHED_PORT_INVALID:${output.trim()}`);
  }
  return port;
}

export async function startRealSkillImportStack(): Promise<
  RealSkillImportStack
> {
  const project = required("BAKERY_IMPORT_STACK_PROJECT");
  const root = required("BAKERY_IMPORT_STACK_ROOT");
  if (!/^bakery-278-[a-z0-9-]+$/.test(project)) {
    throw new Error("OWNED_PROJECT_INVALID");
  }
  await Deno.mkdir(root, { recursive: true, mode: 0o700 });
  const rootStat = await Deno.stat(root);
  if ((rootStat.mode! & 0o777) !== 0o700) {
    throw new Error("OWNED_ROOT_MODE_INVALID");
  }
  const skillRoot = `${root}/skill-store`;
  const faultRoot = `${root}/faults`;
  await Deno.mkdir(skillRoot, { recursive: true, mode: 0o700 });
  await Deno.mkdir(faultRoot, { recursive: true, mode: 0o700 });
  const dockerHost = required("DOCKER_HOST");
  const passwords = {
    postgres: `p${crypto.randomUUID().replaceAll("-", "")}`,
    bakery: `b${crypto.randomUUID().replaceAll("-", "")}`,
    app: `a${crypto.randomUUID().replaceAll("-", "")}`,
    inngest: `i${crypto.randomUUID().replaceAll("-", "")}`,
    redis: `r${crypto.randomUUID().replaceAll("-", "")}`,
  };
  const eventKey = `issue278-${crypto.randomUUID()}`;
  const signingKey = crypto.randomUUID().replaceAll("-", "") +
    crypto.randomUUID().replaceAll("-", "");
  const authSecret = `issue278-${crypto.randomUUID()}-auth-secret-value`;
  const composeEnvironment = processEnvironment({
    DOCKER_HOST: dockerHost,
    BAKERY_INNGEST_PORT: "0",
    BAKERY_SERVER_PORT: "0",
    BAKERY_LOCAL_POSTGRES_PASSWORD: passwords.postgres,
    BAKERY_LOCAL_BAKERY_PASSWORD: passwords.bakery,
    BAKERY_LOCAL_APP_PASSWORD: passwords.app,
    BAKERY_LOCAL_INNGEST_PASSWORD: passwords.inngest,
    BAKERY_LOCAL_REDIS_PASSWORD: passwords.redis,
    BAKERY_INNGEST_EVENT_KEY: eventKey,
    BAKERY_INNGEST_SIGNING_KEY: signingKey,
    BETTER_AUTH_SECRET: authSecret,
  });
  const overridePath = `${root}/compose.override.yaml`;
  const compose = [
    "compose",
    "--project-name",
    project,
    "-f",
    "infra/compose.yaml",
    "-f",
    overridePath,
  ];
  const docker = async (
    args: readonly string[],
    allowFailure = false,
  ): Promise<CommandResult> => {
    const result = await new Deno.Command("docker", {
      args: [...args],
      cwd: Deno.cwd(),
      clearEnv: true,
      env: composeEnvironment,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    const commandResult = {
      success: result.success,
      output: `${decoder.decode(result.stdout)}${
        decoder.decode(result.stderr)
      }`,
    };
    if (!allowFailure && !commandResult.success) {
      throw new Error(
        `DOCKER_COMMAND_FAILED:${args.join(" ")}:${commandResult.output}`,
      );
    }
    return commandResult;
  };
  const runCompose = (args: readonly string[], allowFailure = false) =>
    docker([...compose, ...args], allowFailure);

  let source: RunningRemoteSkillSourceFixture | undefined;
  let server: ProcessHandle | undefined;
  let dispatch: ProcessHandle | undefined;
  let postgresPort = 0;
  const allocatedPorts = new Set<number>();
  const redisPort = reserveUniqueLoopbackPort(allocatedPorts);
  const inngestPort = reserveUniqueLoopbackPort(allocatedPorts);
  const serverPort = reserveUniqueLoopbackPort(allocatedPorts);
  const inngestContainer = `${project}-inngest-host`;
  const redisContainer = `${project}-redis-host`;
  let ownerUrl = "";
  let appUrl = "";
  let inngestDatabaseUrl = "";
  let cleaned = false;

  const serverUrl = `http://127.0.0.1:${serverPort}`;
  const serverEnvironment = () => ({
    BAKERY_ENV: "test",
    BAKERY_SERVER_PORT: String(serverPort),
    BAKERY_APP_DATABASE_URL: appUrl,
    BAKERY_SKILL_FILE_ROOT: skillRoot,
    BAKERY_IMPORT_FAULT_ROOT: faultRoot,
    BETTER_AUTH_SECRET: authSecret,
    INNGEST_URL: `http://127.0.0.1:${inngestPort}`,
    INNGEST_SIGNING_KEY: signingKey,
    INNGEST_EVENT_KEY: eventKey,
  });
  const startServer = async () => {
    server = spawnProcess([
      "run",
      "-A",
      "tests/fixtures/real-skill-import-server-process.ts",
    ], serverEnvironment());
    await Deno.writeTextFile(`${root}/server.pid`, String(server.child.pid));
    await waitHttp(`${serverUrl}/health/live`, server);
  };
  const startDispatch = async () => {
    dispatch = spawnProcess([
      "run",
      "--allow-env",
      "--allow-net",
      "apps/server/src/dispatch.ts",
    ], {
      BAKERY_ENV: "test",
      BAKERY_APP_DATABASE_URL: appUrl,
      INNGEST_URL: `http://127.0.0.1:${inngestPort}`,
      INNGEST_EVENT_KEY: eventKey,
    });
    await Deno.writeTextFile(
      `${root}/dispatch.pid`,
      String(dispatch.child.pid),
    );
    await delay(300);
  };
  const query = async <T extends Record<string, unknown>>(
    url: string,
    sql: string,
    values: unknown[] = [],
  ) => {
    const database = openPgDatabase(url);
    try {
      return await database.query<T>(sql, values);
    } finally {
      await closePgDatabase(database);
    }
  };
  const waitPostgres = async () => {
    for (let attempt = 0; attempt < 120; attempt++) {
      const status = await docker([
        "inspect",
        "-f",
        "{{.State.Health.Status}}",
        `${project}-postgres-1`,
      ], true);
      if (status.output.trim() === "healthy") {
        if (!ownerUrl) return;
        try {
          await query(ownerUrl, "select 1");
          return;
        } catch {
          // Rootless port forwarding can lag behind container health.
        }
      }
      await delay(250);
    }
    throw new Error("POSTGRES_READINESS_TIMEOUT");
  };
  const startRedis = async () => {
    await docker([
      "run",
      "-d",
      "--name",
      redisContainer,
      "--network",
      "host",
      "--label",
      `com.docker.compose.project=${project}`,
      redisImage,
      "redis-server",
      "--bind",
      "127.0.0.1",
      "--port",
      String(redisPort),
      "--appendonly",
      "yes",
      "--requirepass",
      passwords.redis,
    ]);
  };
  const startEngine = async () => {
    await docker([
      "run",
      "-d",
      "--name",
      inngestContainer,
      "--network",
      "host",
      "--label",
      `com.docker.compose.project=${project}`,
      inngestImage,
      "sh",
      "-eu",
      "-c",
      `exec inngest start --host=127.0.0.1 --port=${inngestPort} --postgres-uri=postgres://inngest:${passwords.inngest}@127.0.0.1:${postgresPort}/inngest --redis-uri=redis://:${passwords.redis}@127.0.0.1:${redisPort}/0 --event-key=${eventKey} --signing-key=${signingKey} --sdk-url=${serverUrl}/api/inngest`,
    ]);
    try {
      await waitHttp(`http://127.0.0.1:${inngestPort}/health`);
    } catch (error) {
      const status = await docker([
        "inspect",
        "-f",
        "{{.State.Status}}:{{.State.ExitCode}}",
        inngestContainer,
      ], true);
      const logs = await docker(["logs", inngestContainer], true);
      throw new Error(
        `INNGEST_START_FAILED:${status.output.trim()}:${
          logs.output.split("\n").slice(-30).join("|")
        }`,
        { cause: error },
      );
    }
  };
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await Promise.all([stopProcess(dispatch), stopProcess(server)]);
    if (source) {
      await stopRemoteSkillSourceFixture(source).catch(() => undefined);
    }
    await docker(["rm", "-f", inngestContainer], true).catch(() => undefined);
    await docker(["rm", "-f", redisContainer], true).catch(() => undefined);
    await runCompose(["down", "-v", "--remove-orphans"], true).catch(() =>
      undefined
    );
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  };

  try {
    await Deno.writeTextFile(overridePath, "services: {}\n");
    source = await startRemoteSkillSourceFixture();
    await Deno.writeTextFile(`${root}/source.pid`, String(source.pid));
    postgresPort = await bindLoopbackPortWithRetry({
      allocated: allocatedPorts,
      bind: async (candidate) => {
        composeEnvironment.BAKERY_POSTGRES_PORT = String(candidate);
        await runCompose(["up", "-d", "--wait", "postgres", "migrate"]);
      },
      cleanupOwnedAttempt: async () => {
        await runCompose(["down", "-v", "--remove-orphans"]);
      },
    });
    await runCompose(["wait", "migrate"]);
    const publishedPostgresPort = publishedPort(
      (await runCompose(["port", "postgres", "5432"])).output,
    );
    if (publishedPostgresPort !== postgresPort) {
      throw new Error(
        `POSTGRES_PORT_MISMATCH:${postgresPort}:${publishedPostgresPort}`,
      );
    }
    console.log(
      `issue278: owned postgres host=127.0.0.1 port=${postgresPort}`,
    );
    ownerUrl =
      `postgres://postgres:${passwords.postgres}@127.0.0.1:${postgresPort}/bakery`;
    appUrl =
      `postgres://bakery_app:${passwords.app}@127.0.0.1:${postgresPort}/bakery`;
    inngestDatabaseUrl =
      `postgres://inngest:${passwords.inngest}@127.0.0.1:${postgresPort}/inngest`;
    await startServer();
    await startRedis();
    await startEngine();
    await startDispatch();

    const config = readRuntimeConfig({
      BAKERY_ENV: "test",
      BAKERY_APP_DATABASE_URL: appUrl,
      BAKERY_PUBLIC_BASE_URL: serverUrl,
      BETTER_AUTH_SECRET: authSecret,
    });
    const email = `issue278-${crypto.randomUUID()}@example.test`;
    const password = `Issue278-${crypto.randomUUID()}`;
    const owner = openPgDatabase(ownerUrl);
    try {
      await createSuperuser({ pgDatabase: owner, config: config.auth! }, {
        email,
        displayName: "Issue 278 Admin",
        password,
      });
    } finally {
      await closePgDatabase(owner);
    }
    const scope = await query<{ organizationId: string }>(
      ownerUrl,
      `select membership.organization_id as "organizationId"
         from bakery.organization_memberships as membership
         join bakery.principals as principal on principal.id = membership.principal_id
         join public."user" as provider_user on provider_user.id = principal.provider_user_id
        where provider_user.email = $1`,
      [email],
    );
    const organizationId = scope.rows[0]?.organizationId;
    if (!organizationId) throw new Error("ADMIN_ORGANIZATION_MISSING");
    const signIn = await fetch(`${serverUrl}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: serverUrl },
      body: JSON.stringify({ email, password }),
    });
    if (!signIn.ok) {
      throw new Error(
        `ADMIN_SIGN_IN_FAILED:${signIn.status}:${await signIn.text()}:server=${
          server?.tail.slice(-20).join("|") ?? ""
        }`,
      );
    }
    const cookie = signIn.headers.getSetCookie().find((value) =>
      value.startsWith("better-auth.session_token=")
    )?.split(";", 1)[0];
    if (!cookie) throw new Error("ADMIN_SESSION_COOKIE_MISSING");

    const request = async (
      path: string,
      init: RequestInit = {},
    ): Promise<Response> => {
      const headers = new Headers(init.headers);
      headers.set("cookie", cookie);
      headers.set("Bakery-Organization-Id", organizationId);
      headers.set("origin", serverUrl);
      if (init.body !== undefined) {
        headers.set("content-type", "application/json");
      }
      return await fetch(`${serverUrl}${path}`, { ...init, headers });
    };
    const registerSource = async (
      sourceType: "git" | "url",
      url: string,
      name = `Fixture ${crypto.randomUUID()}`,
    ) => {
      const response = await request("/v1/skill-sources", {
        method: "POST",
        headers: { "Idempotency-Key": `source-${crypto.randomUUID()}` },
        body: JSON.stringify({ sourceType, url, name, license: "MIT" }),
      });
      if (response.status !== 201) {
        throw new Error(
          `SOURCE_CREATE_FAILED:${response.status}:${await response
            .text()}:server=${server?.tail.slice(-20).join("|") ?? ""}`,
        );
      }
      return await response.json() as { id: string; version: number };
    };
    const requestImport = async (
      sourceId: string,
      revision: string,
      path?: string,
      key = `import-${crypto.randomUUID()}`,
    ) => {
      const response = await request("/v1/skill-imports", {
        method: "POST",
        headers: { "Idempotency-Key": key },
        body: JSON.stringify({ sourceId, revision, ...(path ? { path } : {}) }),
      });
      if (response.status !== 201) {
        throw new Error(
          `IMPORT_ADMISSION_FAILED:${response.status}:${await response.text()}`,
        );
      }
      return await response.json() as Record<string, unknown>;
    };
    const getRun = async (runId: string) => {
      const response = await request(`/v1/runs/${runId}`);
      if (!response.ok) {
        throw new Error(
          `RUN_GET_FAILED:${response.status}:${await response.text()}`,
        );
      }
      return await response.json() as Record<string, unknown>;
    };
    const waitTerminal = async (runId: string) => {
      for (let attempt = 0; attempt < 240; attempt++) {
        const run = await getRun(runId);
        if (run.status === "completed" || run.status === "failed") return run;
        await delay(250);
      }
      throw new Error(`IMPORT_TERMINAL_TIMEOUT:${runId}`);
    };
    const snapshot = async (runId: string): Promise<ImportSnapshot> => {
      const result = await query<ImportSnapshot>(
        ownerUrl,
        `select run.status as "runStatus", import.state,
                import.resolved_revision as "sourceRevision",
                import.source_proof_digest as "sourceProofDigest",
                import.skill_id as "skillId",
                import.skill_version_id as "skillVersionId",
                (select status from bakery.skill_versions where organization_id = run.organization_id and id = import.skill_version_id) as "versionStatus",
                (select active_version_id from bakery.skills where organization_id = run.organization_id and id = import.skill_id) as "activeVersionId",
                import.file_inventory as "fileInventory",
                import.terminal_fault as "terminalFault",
                (select count(*)::text from bakery.workflow_runs where id = run.id) as "runCount",
                (select count(*)::text from bakery.skill_imports where run_id = run.id) as "checkpointCount",
                (select count(*)::text from bakery.skills where organization_id = run.organization_id and source_id = import.source_id and source_path = import.source_path) as "skillCount",
                (select count(*)::text from bakery.skill_versions where organization_id = run.organization_id and skill_id = import.skill_id) as "versionCount",
                (select count(*)::text from bakery.skill_files where organization_id = run.organization_id and skill_version_id = import.skill_version_id) as "fileCount",
                (select count(*)::text from bakery.domain_events where organization_id = run.organization_id and aggregate_id = run.id and event_type = 'skill.import.requested') as "eventCount",
                (select count(*)::text from bakery.run_steps where organization_id = run.organization_id and run_id = run.id) as "stepCount",
                (select count(*)::text from bakery.jobs as job join bakery.run_steps as step on step.id = job.run_step_id where step.organization_id = run.organization_id and step.run_id = run.id) as "jobCount"
           from bakery.workflow_runs as run
           join bakery.skill_imports as import on import.organization_id = run.organization_id and import.run_id = run.id
          where run.id = $1`,
        [runId],
      );
      const row = result.rows[0];
      if (!row) throw new Error("IMPORT_SNAPSHOT_MISSING");
      return Object.freeze(row);
    };
    const armBoundary = async (boundary: SkillImportCheckpointBoundary) => {
      await Deno.remove(`${faultRoot}/reached`).catch(() => undefined);
      await Deno.writeTextFile(`${faultRoot}/armed`, boundary, {
        createNew: true,
      });
    };
    const waitBoundary = async (
      boundary: SkillImportCheckpointBoundary,
      runId: string,
    ) => {
      for (let attempt = 0; attempt < 240; attempt++) {
        try {
          const reached = JSON.parse(
            await Deno.readTextFile(`${faultRoot}/reached`),
          );
          if (reached.boundary === boundary && reached.runId === runId) return;
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
        await delay(100);
      }
      throw new Error(
        `IMPORT_BOUNDARY_TIMEOUT:${boundary}:${runId}:state=${
          JSON.stringify(await snapshot(runId))
        }:server=${server?.tail.slice(-30).join("|") ?? ""}`,
      );
    };
    const functionIds = async () => {
      let observed: Array<{ id: string; slug: string }> = [];
      let queryFailure = "";
      for (let attempt = 0; attempt < 120; attempt++) {
        try {
          const result = await query<{ id: string; slug: string }>(
            inngestDatabaseUrl,
            "select id, slug from public.functions order by id",
          );
          observed = result.rows;
          const ids = expectedFunctionIds.filter((expected) =>
            observed.some(({ id, slug }) =>
              id === expected || slug === expected ||
              slug.endsWith(`-${expected}`)
            )
          );
          if (ids.length === expectedFunctionIds.length) {
            return Object.freeze(ids);
          }
        } catch (error) {
          queryFailure = error instanceof Error ? error.message : String(error);
        }
        await delay(250);
      }
      const connectivity = await docker([
        "exec",
        inngestContainer,
        "bash",
        "-c",
        `exec 3<>/dev/tcp/127.0.0.1/${serverPort} && printf 'GET /health/live HTTP/1.1\\r\\nHost: 127.0.0.1\\r\\nConnection: close\\r\\n\\r\\n' >&3 && head -1 <&3`,
      ], true);
      const logs = (await docker(["logs", inngestContainer], true)).output
        .split("\n").slice(-30).join("|");
      throw new Error(
        `INNGEST_FUNCTION_REGISTRATION_TIMEOUT:observed=${
          JSON.stringify(observed)
        }:query=${queryFailure}:connect=${connectivity.output.trim()}:logs=${logs}`,
      );
    };
    const databaseIdentities = async () => {
      const ownerIdentity = await query<{ identity: string }>(
        ownerUrl,
        "select current_database() || ':' || current_user as identity",
      );
      const appIdentity = await query<{ identity: string }>(
        appUrl,
        "select current_database() || ':' || current_user as identity",
      );
      return Object.freeze([
        ownerIdentity.rows[0].identity,
        appIdentity.rows[0].identity,
      ]);
    };
    const disableSource = async (sourceId: string, version: number) => {
      const response = await request(`/v1/skill-sources/${sourceId}`, {
        method: "PATCH",
        headers: {
          "Idempotency-Key": `disable-${crypto.randomUUID()}`,
          "If-Match": `"${version}"`,
        },
        body: JSON.stringify({ enabled: false }),
      });
      if (!response.ok) {
        throw new Error(
          `SOURCE_DISABLE_FAILED:${response.status}:${await response.text()}`,
        );
      }
    };
    const revokeRequester = async (runId: string) => {
      await query(
        ownerUrl,
        `delete from bakery.organization_memberships as membership
          using bakery.workflow_runs as run
          where run.id = $1 and membership.organization_id = run.organization_id
            and membership.principal_id = run.requested_by`,
        [runId],
      );
    };

    return Object.freeze({
      project,
      root,
      serverUrl,
      inngestUrl: `http://127.0.0.1:${inngestPort}`,
      postgresPort,
      source,
      organizationId,
      cookie,
      registerSource,
      requestImport,
      getRun,
      waitTerminal,
      armBoundary,
      waitBoundary,
      snapshot,
      functionIds,
      databaseIdentities,
      disableSource,
      revokeRequester,
      stopServer: async () => {
        await stopProcess(server);
        server = undefined;
        await Deno.remove(`${root}/server.pid`).catch(() => undefined);
      },
      restartServer: async () => {
        await stopProcess(server);
        await startServer();
      },
      stopDispatch: async () => {
        await stopProcess(dispatch);
        dispatch = undefined;
        await Deno.remove(`${root}/dispatch.pid`).catch(() => undefined);
      },
      restartDispatch: async () => {
        await stopProcess(dispatch);
        await startDispatch();
      },
      stopEngine: async () => {
        await docker(["stop", inngestContainer]);
      },
      restartEngine: async () => {
        await docker(["start", inngestContainer]);
        await waitHttp(`http://127.0.0.1:${inngestPort}/health`);
      },
      stopPostgres: async () => {
        await runCompose(["stop", "postgres"]);
      },
      restartPostgres: async () => {
        await runCompose(["rm", "-f", "postgres"]);
        await runCompose(["up", "-d", "--wait", "postgres"]);
        await waitPostgres();
      },
      cleanup,
    });
  } catch (error) {
    await cleanup();
    throw error;
  }
}

import type { Stack } from "../../e2e/helpers/stack.ts";
import {
  reserveProcessLoopbackPort,
  retryOnPortCollision,
} from "../../fixtures/loopback-port-allocation.ts";
import { fundedModelPolicy } from "../funded-model-job.ts";
import {
  closePgDatabase,
  openPgDatabase,
  type PgDatabase,
} from "../../../apps/server/src/platform/database.ts";
import { registerLaneStack } from "../lane-stack-registry.ts";

type DockerResult = {
  readonly success: boolean;
  readonly stdout: string;
  readonly stderr: string;
};

const POSTGRES_INIT_PATHS = [
  "infra",
  "infra/postgres",
  "infra/postgres/init",
  "infra/postgres/init/001-roles.sh",
] as const;

const MAX_LOG_BYTES = 32 * 1024;

export type DurableService = "server" | "worker" | "inngest";

export type DurableCoreStack = Omit<Stack, "logs" | "down"> & {
  readonly project: string;
  readonly ports: Readonly<Record<string, number>>;
  readonly logs: (
    service: DurableService | "migrate" | "postgres" | "redis",
  ) => Promise<string>;
  readonly stopService: (service: DurableService) => Promise<void>;
  readonly startService: (service: DurableService) => Promise<void>;
  readonly restartService: (
    service: DurableService,
    persistedMarker: string,
  ) => Promise<void>;
  readonly processId: (service: DurableService) => Promise<number>;
  readonly waitForService: (service: DurableService) => Promise<void>;
  readonly down: () => Promise<void>;
};

async function runDocker(
  args: readonly string[],
  env: Record<string, string> = Deno.env.toObject(),
): Promise<DockerResult> {
  const result = await new Deno.Command("docker", {
    args: [...args],
    cwd: Deno.cwd(),
    env,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    success: result.success,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

function requireSuccess(result: DockerResult, operation: string): string {
  if (!result.success) {
    throw new Error(`DURABLE_CORE_DOCKER_${operation}:${result.stderr}`);
  }
  return result.stdout;
}

function boundedText(value: string, maxBytes = MAX_LOG_BYTES): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= maxBytes) return value;
  return new TextDecoder().decode(bytes.slice(bytes.byteLength - maxBytes));
}

function composeArgs(project: string, budgetOverridePath: string): string[] {
  return [
    "compose",
    "--project-name",
    project,
    "-f",
    "infra/compose.yaml",
    "-f",
    budgetOverridePath,
  ];
}
type OwnedComposeNetwork = {
  readonly name: string;
  readonly subnet: string;
  readonly internal: boolean;
};

function composeNetworks(
  project: string,
  attempt: number,
): OwnedComposeNetwork[] {
  const seed = Number.parseInt(
    project.split("-").at(-1)?.slice(0, 3) ?? "001",
    16,
  );
  const baseBlock = (seed + attempt * 3) % 4093;
  return [
    { name: "app", internal: false },
    { name: "infra", internal: true },
    { name: "test-access", internal: false },
  ].map(({ name, internal }, index) => {
    const block = baseBlock + index;
    return {
      name: `${project}_${name}`,
      subnet: `10.253.${Math.floor(block / 16)}.${(block % 16) * 16}/28`,
      internal,
    };
  });
}

async function removeOwnedComposeNetworks(
  names: Iterable<string>,
  env: Record<string, string>,
): Promise<void> {
  const failures: Error[] = [];
  for (const name of names) {
    const result = await runDocker(["network", "rm", name], env);
    const output = `${result.stdout}${result.stderr}`;
    if (
      !result.success &&
      !/no such network|network .* not found/i.test(output)
    ) {
      failures.push(
        new Error(`DURABLE_CORE_NETWORK_REMOVE_FAILED:${name}:${output}`),
      );
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "DURABLE_CORE_NETWORK_CLEANUP_FAILED");
  }
}

async function createOwnedComposeNetworks(
  project: string,
  env: Record<string, string>,
  owned: Set<string>,
): Promise<void> {
  for (let attempt = 0; attempt < 32; attempt++) {
    const networks = composeNetworks(project, attempt);
    const created: string[] = [];
    for (const network of networks) {
      const result = await runDocker(
        [
          "network",
          "create",
          "--driver",
          "bridge",
          "--subnet",
          network.subnet,
          ...(network.internal ? ["--internal"] : []),
          "--label",
          `com.docker.compose.project=${project}`,
          "--label",
          `com.docker.compose.network=${
            network.name.slice(project.length + 1)
          }`,
          network.name,
        ],
        env,
      );
      if (result.success) {
        created.push(network.name);
        owned.add(network.name);
        continue;
      }
      const output = `${result.stdout}${result.stderr}`;
      let cleanupFailure: unknown;
      try {
        await removeOwnedComposeNetworks(created, env);
        for (const name of created) owned.delete(name);
      } catch (error) {
        cleanupFailure = error;
      }
      if (cleanupFailure !== undefined) {
        throw new AggregateError(
          [
            new Error(`DURABLE_CORE_NETWORK_CREATE_FAILED:${output}`),
            cleanupFailure,
          ],
          "DURABLE_CORE_NETWORK_CREATE_AND_CLEANUP_FAILED",
        );
      }
      if (output.includes("Pool overlaps")) break;
      throw new Error(`DURABLE_CORE_NETWORK_CREATE_FAILED:${output}`);
    }
    if (created.length === networks.length) return;
  }
  throw new Error("DURABLE_CORE_NETWORK_CAPACITY_EXHAUSTED");
}

type OwnedStack = {
  readonly stack: Stack;
  readonly project: string;
  readonly environment: Record<string, string>;
  readonly budgetOverridePath: string;
};

async function upOwnedStack(
  label: string,
  jobCompletionTimeout?: string,
): Promise<OwnedStack> {
  const projectLabel = label.replace(/[^a-z0-9_-]/gi, "-").toLowerCase().slice(
    0,
    15,
  );
  const project = `bakery-e2e-${projectLabel}-${crypto.randomUUID()}`;
  registerLaneStack(project);
  const dispatchContainer = `${project}-dispatch`;
  // Model actions admit through the funded budget policy, so the server needs it.
  const budgetOverridePath = await Deno.makeTempFile({
    prefix: "bakery-durable-core-budget-",
    suffix: ".json",
  });
  await Deno.writeTextFile(
    budgetOverridePath,
    JSON.stringify({
      services: {
        server: {
          environment: {
            BAKERY_BUDGET_INSTALLATION_MONTHLY_LIMIT_USD:
              fundedModelPolicy.installationMonthlyLimitUsd,
            BAKERY_BUDGET_RESERVATION_TTL_SECONDS: String(
              fundedModelPolicy.reservationTtlSeconds,
            ),
            BAKERY_BUDGET_MAX_RUN_DURATION_SECONDS: String(
              fundedModelPolicy.maxRunDurationSeconds,
            ),
          },
        },
      },
    }),
  );
  const compose = composeArgs(project, budgetOverridePath);
  // The server's public URL (Better Auth base URL) is baked into the container
  // at create time, so its host port must be known before `up`; this is the one
  // port that cannot be docker-assigned. Postgres is docker-assigned ("0") and
  // read back after boot, so no host port is reserved and released early. The
  // first boot draws it again if Docker loses the bind race (see `firstBoot`).
  const bakeryPassword = `bakery-e2e-${crypto.randomUUID()}`;
  const authSecret = `bakery-e2e-auth-secret-${crypto.randomUUID()}`;
  const environment: Record<string, string> = {
    ...Deno.env.toObject(),
    BAKERY_SERVER_PORT: "0",
    BAKERY_POSTGRES_PORT: "0",
    BAKERY_INNGEST_PORT: "0",
    BAKERY_INNGEST_EVENT_KEY: "bakery-e2e-event",
    BAKERY_INNGEST_SIGNING_KEY:
      "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    BAKERY_LOCAL_BAKERY_PASSWORD: bakeryPassword,
    BETTER_AUTH_SECRET: authSecret,
    BAKERY_LOCAL_INNGEST_PASSWORD: "bakery-e2e-inngest",
    BAKERY_LOCAL_POSTGRES_PASSWORD: "bakery-e2e-postgres",
    BAKERY_LOCAL_REDIS_PASSWORD: "bakery-e2e-redis",
  };
  if (jobCompletionTimeout !== undefined) {
    environment.INNGEST_JOB_COMPLETION_TIMEOUT = jobCompletionTimeout;
  }
  let origin = "";
  let ownerDatabaseUrl = "";
  const ownedNetworks = new Set<string>();
  try {
    await createOwnedComposeNetworks(project, environment, ownedNetworks);
  } catch (error) {
    try {
      await removeOwnedComposeNetworks(ownedNetworks, environment);
      ownedNetworks.clear();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "DURABLE_CORE_NETWORK_CREATE_AND_CLEANUP_FAILED",
      );
    }
    throw error;
  }
  let ownerPg: PgDatabase | undefined;
  let stopped = false;
  let dispatchStarted = false;

  const dumpLogs = async () => {
    const result = await runDocker(
      [
        ...compose,
        "logs",
        "--no-color",
        "--tail",
        "60",
        "server",
        "migrate",
        "inngest",
      ],
      environment,
    );
    const dispatch = dispatchStarted
      ? await runDocker(
        ["logs", "--tail", "200", dispatchContainer],
        environment,
      )
      : undefined;
    return `${result.stdout}${result.stderr}${
      dispatch === undefined ? "" : `${dispatch.stdout}${dispatch.stderr}`
    }`;
  };
  const bootServer = async (
    extraArgs: readonly string[],
    extraEnvironment: Record<string, string>,
  ): Promise<void> => {
    const result = await runDocker(
      [...compose, "up", "-d", "--wait", ...extraArgs, "server"],
      { ...environment, ...extraEnvironment },
    );
    if (!result.success) {
      throw new Error(
        `DURABLE_CORE_COMPOSE_START_FAILED:${result.stderr}\n${await dumpLogs()}`,
      );
    }
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        if ((await fetch(`${origin}/health/live`)).ok) return;
      } catch {
        // The server may still be starting.
      }
      await delay(250);
    }
    throw new Error(
      `DURABLE_CORE_SERVER_READINESS_TIMEOUT:${await dumpLogs()}`,
    );
  };
  const waitForDispatch = async (): Promise<void> => {
    for (let attempt = 0; attempt < 120; attempt++) {
      const status = await runDocker(
        ["inspect", "-f", "{{.State.Status}}", dispatchContainer],
        environment,
      );
      const state = status.stdout.trim();
      if (status.success && state === "running") return;
      if (status.success && (state === "exited" || state === "dead")) {
        throw new Error(
          `DURABLE_CORE_DISPATCH_EXITED:${await dumpLogs()}`,
        );
      }
      await delay(250);
    }
    throw new Error(
      `DURABLE_CORE_DISPATCH_READINESS_TIMEOUT:${await dumpLogs()}`,
    );
  };
  const down = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    const failures: unknown[] = [];
    if (ownerPg) {
      await closePgDatabase(ownerPg);
      ownerPg = undefined;
    }
    if (dispatchStarted) {
      const dispatchResult = await runDocker(
        ["rm", "-f", dispatchContainer],
        environment,
      );
      if (
        !dispatchResult.success &&
        !/no such container/i.test(
          `${dispatchResult.stdout}${dispatchResult.stderr}`,
        )
      ) {
        failures.push(
          new Error(
            `DURABLE_CORE_DISPATCH_CLEANUP_FAILED:${dispatchResult.stderr}`,
          ),
        );
      }
      dispatchStarted = false;
    }
    const composeResult = await runDocker(
      [...compose, "down", "-v"],
      environment,
    );
    if (!composeResult.success) {
      failures.push(
        new Error(
          `DURABLE_CORE_COMPOSE_CLEANUP_FAILED:${composeResult.stderr}`,
        ),
      );
    }
    try {
      await removeOwnedComposeNetworks(ownedNetworks, environment);
    } catch (error) {
      failures.push(error);
    }
    try {
      await Deno.remove(budgetOverridePath);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) failures.push(error);
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "DURABLE_CORE_STACK_CLEANUP_FAILED");
    }
  };

  // Rootless Docker's PortManager.AddPort() can lose a bind race on a shared
  // host (CI run 38117010650: "listen tcp4 127.0.0.1:33925: bind: address
  // already in use", on a Docker-assigned service port). This first boot
  // retries on that named error, and its cleanup removes the compose project
  // and the networks it labels, then creates the owned set again. A restart
  // must not clean (it would destroy the state under test): the engine's
  // startService re-draws its pinned port instead, with a cleanup that
  // removes nothing.
  const firstBoot = () =>
    retryOnPortCollision({
      run: async () => {
        environment.BAKERY_SERVER_PORT = String(reserveProcessLoopbackPort());
        origin = `http://127.0.0.1:${environment.BAKERY_SERVER_PORT}`;
        await bootServer([], {});
      },
      cleanupOwnedAttempt: async () => {
        const composeResult = await runDocker(
          [...compose, "down", "-v", "--remove-orphans"],
          environment,
        );
        requireSuccess(composeResult, "COMPOSE_CLEANUP");
        await removeOwnedComposeNetworks(ownedNetworks, environment);
        ownedNetworks.clear();
        await createOwnedComposeNetworks(project, environment, ownedNetworks);
      },
    });

  try {
    await firstBoot();
    const postgresPort = parsePort(
      requireSuccess(
        await runDocker([...compose, "port", "postgres", "5432"], environment),
        "POSTGRES_PORT",
      ),
      "postgres",
    );
    ownerDatabaseUrl =
      `postgres://bakery:${bakeryPassword}@127.0.0.1:${postgresPort}/bakery`;
    const dispatch = await runDocker(
      [
        ...compose,
        "run",
        "-d",
        "--name",
        dispatchContainer,
        "--no-deps",
        "-e",
        `INNGEST_EVENT_KEY=${environment.BAKERY_INNGEST_EVENT_KEY}`,
        "server",
        "sh",
        "-eu",
        "-c",
        'export BAKERY_APP_DATABASE_URL="postgres://bakery_app:$BAKERY_LOCAL_APP_PASSWORD@postgres:5432/bakery"; exec deno run --allow-env --allow-net apps/server/src/dispatch.ts',
      ],
      environment,
    );
    if (!dispatch.success) {
      throw new Error(`DURABLE_CORE_DISPATCH_START_FAILED:${dispatch.stderr}`);
    }
    dispatchStarted = true;
    await waitForDispatch();
    ownerPg = openPgDatabase(ownerDatabaseUrl);
    const stack: Stack = {
      origin,
      ownerDatabaseUrl,
      authSecret,
      fetch: async (request: Request): Promise<Response> => {
        const url = new URL(request.url);
        const target = new URL(origin);
        url.protocol = target.protocol;
        url.host = target.host;
        const headers = new Headers(request.headers);
        if (headers.has("origin")) headers.set("origin", origin);
        const body = request.method === "GET" || request.method === "HEAD"
          ? undefined
          : await request.clone().arrayBuffer();
        return await fetch(
          new Request(url, { method: request.method, headers, body }),
        );
      },
      psql: async <T>(sql: string, params?: unknown[]) => {
        const result = await ownerPg!.query(sql, params as unknown[]);
        return result.rows as T[];
      },
      logs: async () => await dumpLogs(),
      restartServer: (extraEnvironment: Record<string, string>) =>
        bootServer(["--force-recreate", "--no-deps"], extraEnvironment),
      runOneOff: async (
        args: string[],
        extraEnvironment?: Record<string, string>,
      ) => {
        const result = await runDocker(
          [...compose, ...args],
          { ...environment, ...extraEnvironment },
        );
        return {
          success: result.success,
          output: `${result.stdout}${result.stderr}`,
        };
      },
      down,
    };
    return { stack, project, environment, budgetOverridePath };
  } catch (error) {
    try {
      await down();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "DURABLE_CORE_STACK_START_AND_CLEANUP_FAILED",
      );
    }
    throw error;
  }
}

function parsePort(output: string, service: string): number {
  const match = output.trim().match(/:(\d+)$/m);
  if (!match) {
    throw new Error(`DURABLE_CORE_${service.toUpperCase()}_PORT_MISSING`);
  }
  const port = Number(match[1]);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`DURABLE_CORE_${service.toUpperCase()}_PORT_INVALID`);
  }
  return port;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(
  service: DurableService,
  check: () => Promise<boolean>,
  logs: () => Promise<string>,
): Promise<void> {
  let lastError = "";
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(250);
  }
  throw new Error(
    `DURABLE_CORE_${service.toUpperCase()}_READINESS_TIMEOUT:${lastError}\n${await logs()}`,
  );
}

async function withStdin(
  command: string,
  args: readonly string[],
  input: string,
): Promise<void> {
  const process = new Deno.Command(command, {
    args: [...args],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = process.stdin.getWriter();
  await writer.write(new TextEncoder().encode(input));
  await writer.close();
  const result = await process.output();
  if (!result.success) {
    throw new Error(
      `DURABLE_CORE_${command.toUpperCase()}_FAILED:${
        new TextDecoder().decode(result.stderr)
      }`,
    );
  }
}

type PermissionSnapshot = {
  readonly path: string;
  readonly mode: string;
  readonly acl: string;
};

async function permissionSnapshot(path: string): Promise<PermissionSnapshot> {
  const stat = await new Deno.Command("stat", {
    args: ["-c", "%a", path],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!stat.success) {
    throw new Error(`DURABLE_CORE_PERMISSION_STAT_FAILED:${path}`);
  }
  const acl = await new Deno.Command("getfacl", {
    args: ["-p", path],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!acl.success) {
    throw new Error(`DURABLE_CORE_PERMISSION_ACL_FAILED:${path}`);
  }
  return {
    path,
    mode: new TextDecoder().decode(stat.stdout).trim(),
    acl: new TextDecoder().decode(acl.stdout),
  };
}

/**
 * The checkout's init path is intentionally mode-700. Compose needs a reversible
 * read/execute grant while PostgreSQL initializes, and no permission change is
 * allowed to survive the callback.
 */
export async function withPostgresInitAccess<T>(
  work: () => Promise<T>,
): Promise<T> {
  const snapshots = await Promise.all(
    POSTGRES_INIT_PATHS.map(permissionSnapshot),
  );
  let result!: T;
  let failed = false;
  let failure: unknown;
  try {
    for (const path of POSTGRES_INIT_PATHS) {
      const grant = await new Deno.Command("chmod", {
        args: ["o+rx", path],
        stdout: "piped",
        stderr: "piped",
      }).output();
      if (!grant.success) {
        throw new Error(`DURABLE_CORE_PERMISSION_GRANT_FAILED:${path}`);
      }
    }
    result = await work();
  } catch (error) {
    failed = true;
    failure = error;
  }
  const restoreFailures: unknown[] = [];
  for (const snapshot of [...snapshots].reverse()) {
    try {
      const restoreMode = await new Deno.Command("chmod", {
        args: [snapshot.mode, snapshot.path],
        stdout: "piped",
        stderr: "piped",
      }).output();
      if (!restoreMode.success) {
        throw new Error(
          `DURABLE_CORE_PERMISSION_RESTORE_FAILED:${snapshot.path}`,
        );
      }
      await withStdin("setfacl", ["--restore=-"], snapshot.acl);
    } catch (error) {
      restoreFailures.push(error);
    }
  }
  if (failed) {
    if (restoreFailures.length > 0) {
      throw new AggregateError(
        [failure, ...restoreFailures],
        "DURABLE_CORE_PERMISSION_RESTORE_INCOMPLETE",
      );
    }
    throw failure;
  }
  if (restoreFailures.length > 0) {
    throw new AggregateError(
      restoreFailures,
      "DURABLE_CORE_PERMISSION_RESTORE_INCOMPLETE",
    );
  }
  return result;
}

export async function upDurableCoreStack(
  label: string,
  options?: { readonly jobCompletionTimeout?: string },
): Promise<DurableCoreStack> {
  let owned: OwnedStack | undefined;
  try {
    await withPostgresInitAccess(async () => {
      const created = await upOwnedStack(label, options?.jobCompletionTimeout);
      owned = created;
      return created;
    });
  } catch (error) {
    if (owned !== undefined) {
      try {
        await owned.stack.down();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "DURABLE_CORE_STACK_START_AND_CLEANUP_FAILED",
        );
      }
    }
    throw error;
  }
  if (owned === undefined) {
    throw new Error("DURABLE_CORE_STACK_NOT_CREATED");
  }
  const base = owned.stack;
  try {
    const compose = composeArgs(owned.project, owned.budgetOverridePath);
    const serverPort = Number(new URL(base.origin).port);
    const postgresPort = Number(
      base.ownerDatabaseUrl.match(/:(\d+)\//)?.[1] ?? 0,
    );
    const initialInngestPort = parsePort(
      requireSuccess(
        await runDocker(
          [...compose, "port", "inngest", "8288"],
          owned.environment,
        ),
        "INNGEST_PORT",
      ),
      "inngest",
    );
    const composeEnvironment = {
      ...owned.environment,
      BAKERY_SERVER_PORT: String(serverPort),
      BAKERY_POSTGRES_PORT: String(postgresPort),
      BAKERY_INNGEST_PORT: String(initialInngestPort),
      BAKERY_PUBLIC_BASE_URL: base.origin,
    };
    const composeRun = async (args: readonly string[]): Promise<DockerResult> =>
      await runDocker([...compose, ...args], composeEnvironment);
    const logs = async (
      service: DurableService | "migrate" | "postgres" | "redis",
    ): Promise<string> => {
      const result = await composeRun([
        "logs",
        "--no-color",
        "--tail",
        "200",
        service,
      ]);
      return boundedText(`${result.stdout}${result.stderr}`);
    };
    const waitForService = async (service: DurableService): Promise<void> => {
      if (service === "server") {
        await waitFor(
          service,
          async () => (await fetch(`${base.origin}/health/live`)).ok,
          () => logs("server"),
        );
        return;
      }
      if (service === "inngest") {
        const port = parsePort(
          requireSuccess(
            await composeRun(["port", "inngest", "8288"]),
            "INNGEST_PORT",
          ),
          service,
        );
        await waitFor(
          service,
          async () => (await fetch(`http://127.0.0.1:${port}/health`)).ok,
          () => logs("inngest"),
        );
        return;
      }
      await waitFor(
        service,
        async () => {
          const result = await composeRun([
            "ps",
            "--status",
            "running",
            "--services",
            "worker",
          ]);
          return result.success && result.stdout.split("\n").includes("worker");
        },
        () => logs("worker"),
      );
    };
    const stopService = async (service: DurableService): Promise<void> => {
      requireSuccess(await composeRun(["stop", service]), "STOP_SERVICE");
    };
    const startService = async (service: DurableService): Promise<void> => {
      const args = service === "worker"
        ? ["--profile", "worker", "up", "-d", "--wait", service]
        : ["up", "-d", "--no-deps", "--wait", service];
      if (service === "inngest") {
        // The stopped engine's host port stays pinned so its consumers keep one
        // URL, and another socket can take it while the engine is down. A lost
        // bind draws a fresh port: the failed `up` leaves only a created
        // container, which the next `up` recreates on the new port, so there is
        // nothing to clean. Consumers read `ports.inngest` per call.
        await retryOnPortCollision({
          run: async (attempt) => {
            if (attempt > 1) {
              const port = reserveProcessLoopbackPort();
              composeEnvironment.BAKERY_INNGEST_PORT = String(port);
              ports.inngest = port;
            }
            requireSuccess(await composeRun(args), "START_SERVICE");
          },
          cleanupOwnedAttempt: () => Promise.resolve(),
        });
      } else {
        requireSuccess(await composeRun(args), "START_SERVICE");
      }
      await waitForService(service);
    };
    const restartService = async (
      service: DurableService,
      persistedMarker: string,
    ): Promise<void> => {
      if (persistedMarker.trim() === "") {
        throw new Error("DURABLE_CORE_RESTART_REQUIRES_PERSISTED_MARKER");
      }
      await stopService(service);
      await startService(service);
    };
    const processId = async (service: DurableService): Promise<number> => {
      const containerId = requireSuccess(
        await composeRun(["ps", "-q", service]),
        "PROCESS_ID",
      ).trim();
      if (!containerId) {
        throw new Error(
          `DURABLE_CORE_${service.toUpperCase()}_CONTAINER_MISSING`,
        );
      }
      const pid = Number(
        requireSuccess(
          await runDocker(
            ["inspect", "--format", "{{.State.Pid}}", containerId],
            composeEnvironment,
          ),
          "PROCESS_ID",
        ).trim(),
      );
      if (!Number.isSafeInteger(pid) || pid <= 0) {
        throw new Error(
          `DURABLE_CORE_${service.toUpperCase()}_PROCESS_ID_INVALID`,
        );
      }
      return pid;
    };
    const ports = {
      server: serverPort,
      postgres: postgresPort,
      inngest: initialInngestPort,
    };
    if (ports.server <= 0 || ports.postgres <= 0) {
      throw new Error("DURABLE_CORE_RESOLVED_PORTS_INVALID");
    }
    return {
      ...base,
      project: owned.project,
      ports,
      logs,
      stopService,
      startService,
      restartService,
      waitForService,
      processId,
      down: base.down,
    };
  } catch (error) {
    await base.down().catch(() => undefined);
    throw error;
  }
}

// One compose stack per e2e test *file*: boots `infra/compose.yaml` for real,
// against the shipped `denoland/deno` image and the exact `--allow-*` flags
// the compose service declares. This is the only place in the backend test
// suite that exercises the built process, the migrate-then-app-role boot
// order, and a real TCP hop into the server (as opposed to `createApp(...)`
// + `app.fetch(request)` in-process, which every other lane uses).
import { assert, fail } from "@std/assert";
import {
  closePgDatabase,
  openPgDatabase,
  type PgDatabase,
} from "../../../apps/server/src/platform/database.ts";
import {
  reserveProcessLoopbackPort,
  retryOnPortCollision,
} from "../../fixtures/loopback-port-allocation.ts";
import { registerLaneStack } from "../../helpers/lane-stack-registry.ts";

export type Stack = {
  /** `http://127.0.0.1:<published server port>`, also `BAKERY_PUBLIC_BASE_URL`. */
  origin: string;
  /** Owner-role (`bakery`) connection string to the containerized `bakery` database. */
  ownerDatabaseUrl: string;
  /** The `BETTER_AUTH_SECRET` the running `server` container was started with. */
  authSecret: string;
  /**
   * Rewrites `request` onto `stack.origin` (host/port/protocol) and, when the
   * request carries an `origin` header, retargets it at `stack.origin` too —
   * so the server's trusted-origin check (derived from its own
   * `BAKERY_PUBLIC_BASE_URL`) is exercised for real instead of matching a
   * hardcoded test constant.
   */
  fetch(request: Request): Promise<Response>;
  /** Owner-role query against the containerized database, for seeding and assertions only. */
  psql<T>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Raw `docker compose logs` output for one service. */
  logs(service: "server" | "migrate"): Promise<string>;
  /**
   * Recreates the `server` service with `envOverrides` merged over the
   * stack's base environment, waits for it to report healthy again, and
   * fails the test with logs attached if it does not.
   */
  restartServer(envOverrides: Record<string, string>): Promise<void>;
  /** One-off `docker compose <args>` against this stack's project, e.g. `["run", "--rm", "-e", "X=y", "server"]`. */
  runOneOff(
    args: string[],
    envOverrides?: Record<string, string>,
  ): Promise<{ success: boolean; output: string }>;
  down(): Promise<void>;
};

export type PostgresStack = {
  /** Unique compose project owned by this fixture. */
  project: string;
  /** Published loopback PostgreSQL port owned by this fixture. */
  postgresPort: string;
  /** Owner-role (`bakery`) connection string to the containerized `bakery` database. */
  ownerDatabaseUrl: string;
  /** Application-role connection string to the containerized `bakery` database. */
  appDatabaseUrl: string;
  /** PostgreSQL superuser connection string for fixture administration only. */
  adminDatabaseUrl: string;
  /** Stops this stack and proves no project-labelled resource remains. */
  down(): Promise<void>;
};

async function createOwnedComposeNetworks(
  project: string,
  env: Record<string, string>,
): Promise<void> {
  const seed = Number.parseInt(
    project.split("-").at(-1)?.slice(0, 3) ?? "001",
    16,
  );
  for (let attempt = 0; attempt < 32; attempt++) {
    const baseBlock = (seed + attempt * 3) % 4094;
    const networks = [
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
    const created: string[] = [];
    let retry = false;
    for (const network of networks) {
      const result = await run(
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
      if (!result.success) {
        for (const name of created) {
          await run(["network", "rm", name], env);
        }
        const output = `${result.stdout}\n${result.stderr}`;
        if (output.includes("Pool overlaps")) {
          retry = true;
          break;
        }
        throw new Error(`E2E_NETWORK_CREATE_FAILED:${output}`);
      }
      created.push(network.name);
    }
    if (!retry && created.length === networks.length) return;
  }
  fail("Could not allocate isolated Docker networks after 32 attempts");
}

export async function upPostgresStack(label: string): Promise<PostgresStack> {
  const project = `bakery-e2e-${label}-${crypto.randomUUID()}`;
  registerLaneStack(project);
  const compose = [
    "compose",
    "--project-name",
    project,
    "-f",
    "infra/compose.yaml",
  ];
  // Drawn again by each attempt: Docker can lose the bind race for it.
  let postgresPort = "";
  const bakeryPassword = `bakery-e2e-${crypto.randomUUID()}`;
  const appPassword = `bakery-e2e-app-${crypto.randomUUID()}`;
  const env: Record<string, string> = {
    ...Deno.env.toObject(),
    BAKERY_POSTGRES_PORT: "0",
    BAKERY_SERVER_PORT: "0",
    BAKERY_INNGEST_PORT: "0",
    BAKERY_INNGEST_EVENT_KEY: "bakery-e2e-event",
    BAKERY_INNGEST_SIGNING_KEY:
      "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    BETTER_AUTH_SECRET: `bakery-e2e-auth-secret-${crypto.randomUUID()}`,
    BAKERY_LOCAL_BAKERY_PASSWORD: bakeryPassword,
    BAKERY_LOCAL_APP_PASSWORD: appPassword,
    BAKERY_LOCAL_INNGEST_PASSWORD: `bakery-e2e-inngest-${crypto.randomUUID()}`,
    BAKERY_LOCAL_POSTGRES_PASSWORD:
      `bakery-e2e-postgres-${crypto.randomUUID()}`,
    BAKERY_LOCAL_REDIS_PASSWORD: `bakery-e2e-redis-${crypto.randomUUID()}`,
  };
  let ownerDatabaseUrl = "";
  let appDatabaseUrl = "";
  let adminDatabaseUrl = "";
  let stopped = false;

  const down = async (): Promise<void> => {
    if (stopped) return;
    const result = await run(
      [...compose, "down", "-v", "--remove-orphans"],
      env,
    );
    if (!result.success) {
      throw new Error(`E2E_COMPOSE_CLEANUP_FAILED:${result.stderr}`);
    }
    for (
      const args of [
        [
          "ps",
          "-aq",
          "--filter",
          `label=com.docker.compose.project=${project}`,
        ],
        [
          "volume",
          "ls",
          "-q",
          "--filter",
          `label=com.docker.compose.project=${project}`,
        ],
        [
          "network",
          "ls",
          "-q",
          "--filter",
          `label=com.docker.compose.project=${project}`,
        ],
      ]
    ) {
      const remaining = await run(args, env);
      if (!remaining.success || remaining.stdout.trim()) {
        throw new Error("E2E_COMPOSE_CLEANUP_INCOMPLETE");
      }
    }
    stopped = true;
  };

  try {
    // A lost bind race (see retryOnPortCollision) re-runs the whole boot on a
    // fresh port. `down` proves the failed attempt left nothing behind, networks
    // included, so the next attempt creates the owned networks again.
    await retryOnPortCollision({
      run: async () => {
        postgresPort = String(reserveProcessLoopbackPort());
        env.BAKERY_POSTGRES_PORT = postgresPort;
        ownerDatabaseUrl =
          `postgres://bakery:${bakeryPassword}@127.0.0.1:${postgresPort}/bakery`;
        appDatabaseUrl =
          `postgres://bakery_app:${appPassword}@127.0.0.1:${postgresPort}/bakery`;
        adminDatabaseUrl =
          `postgres://postgres:${env.BAKERY_LOCAL_POSTGRES_PASSWORD}@127.0.0.1:${postgresPort}/bakery`;
        await createOwnedComposeNetworks(project, env);
        const result = await run(
          [...compose, "up", "-d", "--wait", "postgres"],
          env,
        );
        if (!result.success) {
          throw new Error(`E2E_COMPOSE_START_FAILED:${result.stderr}`);
        }
      },
      cleanupOwnedAttempt: async () => {
        await down();
        stopped = false;
      },
    });
    // Compose's socket healthcheck can pass against initdb's temporary server;
    // require the published TCP endpoint to answer SQL before exposing the URL.
    const ownerProbe = openPgDatabase(ownerDatabaseUrl, 1);
    const timeoutMs = 30_000;
    const deadline = Date.now() + timeoutMs;
    let ready = false;
    let lastError: unknown;
    try {
      while (!ready && Date.now() < deadline) {
        try {
          await ownerProbe.query("select 1");
          ready = Date.now() <= deadline;
        } catch (error) {
          lastError = error;
        }
        if (!ready) {
          const remaining = deadline - Date.now();
          if (remaining <= 0) break;
          const { promise, resolve } = Promise.withResolvers<void>();
          setTimeout(resolve, Math.min(250, remaining));
          await promise;
        }
      }
    } finally {
      await closePgDatabase(ownerProbe);
    }
    if (!ready) {
      throw new Error(
        `E2E_POSTGRES_TCP_READINESS_TIMEOUT: owner SQL probe did not succeed within ${timeoutMs}ms`,
        { cause: lastError },
      );
    }

    return {
      project,
      postgresPort,
      ownerDatabaseUrl,
      appDatabaseUrl,
      adminDatabaseUrl,
      down,
    };
  } catch (error) {
    try {
      await down();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "E2E_COMPOSE_START_AND_CLEANUP_FAILED",
      );
    }
    throw error;
  }
}

async function run(
  args: string[],
  env: Record<string, string>,
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  const result = await new Deno.Command("docker", {
    args,
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

export async function upStack(label: string): Promise<Stack> {
  const project = `bakery-e2e-${label}-${crypto.randomUUID()}`;
  registerLaneStack(project);
  const compose = [
    "compose",
    "--project-name",
    project,
    "-f",
    "infra/compose.yaml",
  ];
  const bakeryPassword = `bakery-e2e-${crypto.randomUUID()}`;
  const authSecret = `bakery-e2e-auth-secret-${crypto.randomUUID()}`;
  const env: Record<string, string> = {
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
  // Drawn again by each first-boot attempt: Docker can lose the bind race.
  let origin = "";
  let ownerDatabaseUrl = "";

  const dumpLogs = async (extraEnv: Record<string, string>) => {
    const result = await run(
      [...compose, "logs", "--no-color", "server", "migrate"],
      { ...env, ...extraEnv },
    );
    return `${result.stdout}${result.stderr}`;
  };

  const bootServer = async (
    extraArgs: string[],
    extraEnv: Record<string, string>,
  ) => {
    const mergedEnv = { ...env, ...extraEnv };
    const result = await run(
      [...compose, "up", "-d", "--wait", ...extraArgs, "server"],
      mergedEnv,
    );
    if (!result.success) {
      fail(
        `docker compose up --wait server failed: ${result.stderr}\n--- logs ---\n${await dumpLogs(
          extraEnv,
        )}`,
      );
    }
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        const response = await fetch(`${origin}/health/live`);
        if (response.ok) return;
      } catch {
        // service may still be starting
      }
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 250);
      await promise;
    }
    fail(
      `server health endpoint did not become ready\n--- logs ---\n${await dumpLogs(
        extraEnv,
      )}`,
    );
  };

  await run([...compose, "down"], env);
  let ownerPg: PgDatabase | undefined;
  try {
    // Only this first boot retries a lost bind race (see retryOnPortCollision):
    // a restart rebinds a released port and its cleanup would destroy the state
    // under test. `down` removes the project's networks with it, so each
    // attempt creates the owned networks again.
    await retryOnPortCollision({
      run: async () => {
        const serverPort = reserveProcessLoopbackPort();
        const postgresPort = reserveProcessLoopbackPort();
        env.BAKERY_SERVER_PORT = String(serverPort);
        env.BAKERY_POSTGRES_PORT = String(postgresPort);
        origin = `http://127.0.0.1:${serverPort}`;
        ownerDatabaseUrl =
          `postgres://bakery:${bakeryPassword}@127.0.0.1:${postgresPort}/bakery`;
        await createOwnedComposeNetworks(project, env);
        await bootServer([], {});
      },
      cleanupOwnedAttempt: async () => {
        const result = await run(
          [...compose, "down", "-v", "--remove-orphans"],
          env,
        );
        assert(result.success, `docker compose down failed: ${result.stderr}`);
      },
    });
    ownerPg = openPgDatabase(ownerDatabaseUrl);
    return {
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
        return fetch(
          new Request(url, { method: request.method, headers, body }),
        );
      },
      psql: async <T>(sql: string, params?: unknown[]) => {
        const result = await ownerPg!.query(sql, params as unknown[]);
        return result.rows as T[];
      },
      logs: async (service: "server" | "migrate") => {
        const result = await run(
          [...compose, "logs", "--no-color", service],
          env,
        );
        return `${result.stdout}${result.stderr}`;
      },
      restartServer: (envOverrides: Record<string, string>) =>
        bootServer(["--force-recreate", "--no-deps"], envOverrides),
      runOneOff: async (
        args: string[],
        envOverrides?: Record<string, string>,
      ) => {
        const result = await run([...compose, ...args], {
          ...env,
          ...envOverrides,
        });
        return {
          success: result.success,
          output: `${result.stdout}${result.stderr}`,
        };
      },
      down: async () => {
        if (ownerPg) await closePgDatabase(ownerPg);
        const result = await run([...compose, "down", "-v"], env);
        assert(result.success, `docker compose down failed: ${result.stderr}`);
      },
    };
  } catch (error) {
    if (ownerPg) await closePgDatabase(ownerPg);
    await run([...compose, "down", "-v"], env);
    throw error;
  }
}

/**
 * Runs `callback` against a Postgres stack owned by the caller, with
 * `DATABASE_URL` and `BAKERY_APP_DATABASE_URL` pointed at it. The previous
 * environment is restored and the stack torn down afterwards. A callback error
 * wins over a cleanup error; both are raised together only when both fail.
 */
export async function withOwnedPostgresEnv<T>(
  label: string,
  callback: (stack: PostgresStack) => Promise<T>,
): Promise<T> {
  const stack = await upPostgresStack(label);
  const values = {
    DATABASE_URL: stack.ownerDatabaseUrl,
    BAKERY_APP_DATABASE_URL: stack.appDatabaseUrl,
  };
  const previous = new Map<string, string | undefined>();
  let result: T | undefined;
  let callbackFailed = false;
  let callbackError: unknown;
  let cleanupError: unknown;
  try {
    for (const [name, value] of Object.entries(values)) {
      previous.set(name, Deno.env.get(name));
      Deno.env.set(name, value);
    }
    result = await callback(stack);
  } catch (error) {
    callbackFailed = true;
    callbackError = error;
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
    try {
      await stack.down();
    } catch (error) {
      cleanupError = error;
    }
  }
  if (callbackFailed) {
    if (cleanupError !== undefined) {
      throw new AggregateError(
        [callbackError, cleanupError],
        "OWNED_POSTGRES_CLEANUP_FAILED",
      );
    }
    throw callbackError;
  }
  if (cleanupError !== undefined) throw cleanupError;
  return result as T;
}

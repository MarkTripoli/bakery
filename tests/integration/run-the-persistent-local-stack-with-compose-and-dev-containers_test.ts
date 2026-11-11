import { assert, assertEquals, fail } from "@std/assert";
import {
  reserveProcessLoopbackPort,
  retryOnPortCollision,
} from "../fixtures/loopback-port-allocation.ts";

const testSecrets = {
  bakeryPassword: "bakery-b0102-test-bakery",
  appPassword: "bakery-b0102-test-app",
  authSecret: "bakery-b0102-test-auth-secret-32",
  inngestEventKey: "bakery-b0102-test-event-key",
  inngestPassword: "bakery-b0102-test-inngest",
  inngestSigningKey:
    "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
  postgresPassword: "bakery-b0102-test-postgres",
  redisPassword: "bakery-b0102-test-redis",
} as const;

const composeArgs = (projectName: string): string[] => [
  "compose",
  "--project-name",
  projectName,
  "-f",
  "infra/compose.yaml",
];

const composeEnv = (): Record<string, string> => {
  const ports = [8000, 8288, 5432].map(() => reserveProcessLoopbackPort());
  return {
    ...Deno.env.toObject(),
    BAKERY_ENV: "development",
    BAKERY_SERVER_PORT: String(ports[0]),
    BAKERY_INNGEST_PORT: String(ports[1]),
    BAKERY_POSTGRES_PORT: String(ports[2]),
    BAKERY_INNGEST_EVENT_KEY: testSecrets.inngestEventKey,
    BAKERY_INNGEST_SIGNING_KEY: testSecrets.inngestSigningKey,
    BAKERY_LOCAL_BAKERY_PASSWORD: testSecrets.bakeryPassword,
    BAKERY_LOCAL_APP_PASSWORD: testSecrets.appPassword,
    BETTER_AUTH_SECRET: testSecrets.authSecret,
    BAKERY_LOCAL_INNGEST_PASSWORD: testSecrets.inngestPassword,
    BAKERY_LOCAL_POSTGRES_PASSWORD: testSecrets.postgresPassword,
    BAKERY_LOCAL_REDIS_PASSWORD: testSecrets.redisPassword,
  };
};

async function createOwnedComposeNetworks(
  project: string,
  env: Record<string, string>,
): Promise<readonly string[]> {
  const seed = Number.parseInt(
    project.split("-").at(-1)?.slice(0, 3) ?? "001",
    16,
  );
  for (let attempt = 0; attempt < 32; attempt++) {
    const baseBlock = (seed + attempt * 3) % 4093;
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
    for (const network of networks) {
      const result = await executeDocker(
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
          await run(["network", "rm", name], true, env);
        }
        if (result.output.includes("Pool overlaps")) break;
        fail(`docker network create failed:\n${result.output}`);
      }
      created.push(network.name);
    }
    if (created.length === networks.length) return created;
  }
  fail("Could not allocate isolated Docker networks after 32 attempts");
}

type DockerResult = {
  readonly success: boolean;
  readonly output: string;
};

const executeDocker = async (
  args: string[],
  env?: Record<string, string>,
  maxOutputChars?: number,
): Promise<DockerResult> => {
  const command = new Deno.Command("docker", {
    args,
    cwd: Deno.cwd(),
    env,
    stdout: "piped",
    stderr: "piped",
  });
  if (maxOutputChars !== undefined) {
    const child = command.spawn();
    const readTail = async (stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder();
      let tail = "";
      for await (const chunk of stream) {
        tail = (tail + decoder.decode(chunk, { stream: true })).slice(
          -maxOutputChars / 2,
        );
      }
      return (tail + decoder.decode()).slice(-maxOutputChars / 2);
    };
    const [stdout, stderr, status] = await Promise.all([
      readTail(child.stdout),
      readTail(child.stderr),
      child.status,
    ]);
    return { success: status.success, output: `${stdout}${stderr}` };
  }
  const result = await command.output();
  return {
    success: result.success,
    output: `${new TextDecoder().decode(result.stdout)}${
      new TextDecoder().decode(result.stderr)
    }`,
  };
};

const run = async (
  args: string[],
  allowFailure = false,
  env?: Record<string, string>,
): Promise<string> => {
  const result = await executeDocker(args, env);
  if (!allowFailure && !result.success) {
    fail(`docker ${args.join(" ")} failed:\n${result.output}`);
  }
  return result.output;
};

async function get(path: string): Promise<Response> {
  return await fetch(`http://127.0.0.1${path}`);
}

async function waitFor(path: string): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const response = await get(path);
      if (response.ok) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw lastError ?? new Error(`Timed out waiting for ${path}`);
}

Deno.test("Compose starts healthy services and Redis state survives restart", async () => {
  const version = await run(["version"], true);
  if (version.trim() === "") {
    fail("Docker is unavailable; the local stack probe fails closed");
  }

  const projectName = "bakery-b0102-test-" + crypto.randomUUID();
  const compose = composeArgs(projectName);
  let env = composeEnv();
  await run([...compose, "down"], true, env);
  let networks = await createOwnedComposeNetworks(projectName, env);
  try {
    // First boot only: a lost host-port bind draws new ports and boots again on
    // a clean project; the restarts below rebind their own ports and are not
    // wrapped.
    await retryOnPortCollision({
      run: async () => {
        env = composeEnv();
        const startup = await executeDocker(
          [
            ...compose,
            "up",
            "-d",
            "--wait",
            "postgres",
            "redis",
            "inngest",
            "server",
          ],
          env,
        );
        if (startup.success) return;
        const [inngestLogs, serverLogs] = await Promise.all(
          ["inngest", "server"].map((service) =>
            executeDocker(
              [...compose, "logs", "--no-color", "--tail=80", service],
              env,
              16_384,
            )
          ),
        );
        const redact = (output: string) =>
          Object.values(testSecrets).reduce(
            (text, secret) => text.replaceAll(secret, "[redacted]"),
            output,
          );
        fail(
          `docker ${compose.join(" ")} up failed:\n${
            redact(startup.output)
          }\n` +
            `Inngest logs (last 80 lines):\n${redact(inngestLogs.output)}\n` +
            `server logs (last 80 lines):\n${redact(serverLogs.output)}`,
        );
      },
      cleanupOwnedAttempt: async () => {
        await run([...compose, "down", "-v", "--remove-orphans"], false, env);
        for (const network of networks) {
          await run(["network", "rm", network], true, env);
        }
        networks = await createOwnedComposeNetworks(projectName, env);
      },
    });
    assertEquals(
      (await waitFor(`:${env.BAKERY_SERVER_PORT}/health/live`)).status,
      200,
    );
    await run(
      [
        ...compose,
        "exec",
        "-T",
        "inngest",
        "inngest",
        "api",
        "--api-host",
        "127.0.0.1",
        "--api-port",
        "8288",
        "--signing-key",
        testSecrets.inngestSigningKey,
        "health",
      ],
      false,
      env,
    );

    const eventName = `bakery/b0102.probe.${crypto.randomUUID()}`;
    const event = await run(
      [
        ...compose,
        "exec",
        "-T",
        "server",
        "deno",
        "eval",
        `const r = await fetch('http://inngest:8288/e/${testSecrets.inngestEventKey}', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '${eventName}', data: { value: 'persisted' } }) }); if (!r.ok) Deno.exit(1); console.log(await r.text());`,
      ],
      false,
      env,
    );
    assert(event.includes('"status":200'));
    const eventQuery =
      `select count(*) from events where event_name = '${eventName}'`;
    const engineEvents = await run(
      [
        ...compose,
        "exec",
        "-T",
        "postgres",
        "psql",
        "-U",
        "inngest",
        "-d",
        "inngest",
        "-Atqc",
        eventQuery,
      ],
      false,
      env,
    );
    let engineEventCount = Number(engineEvents.trim().split("\n").at(-1));
    for (let attempt = 0; engineEventCount === 0 && attempt < 20; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const persisted = await run(
        [
          ...compose,
          "exec",
          "-T",
          "postgres",
          "psql",
          "-U",
          "inngest",
          "-d",
          "inngest",
          "-Atqc",
          eventQuery,
        ],
        false,
        env,
      );
      engineEventCount = Number(persisted.trim().split("\n").at(-1));
    }
    assert(
      engineEventCount > 0,
      `Inngest event was not persisted within 5s: ${engineEvents}`,
    );
    await run([...compose, "restart", "inngest"], false, env);
    await run([...compose, "up", "-d", "--wait", "inngest"], false, env);
    const persistedEngineEvents = await run(
      [
        ...compose,
        "exec",
        "-T",
        "postgres",
        "psql",
        "-U",
        "inngest",
        "-d",
        "inngest",
        "-Atqc",
        eventQuery,
      ],
      false,
      env,
    );
    assertEquals(
      persistedEngineEvents.trim().split("\n").at(-1),
      String(engineEventCount),
    );

    await run(
      [
        ...compose,
        "exec",
        "-T",
        "redis",
        "redis-cli",
        "-a",
        testSecrets.redisPassword,
        "SET",
        "bakery_b0102_probe",
        "persisted",
      ],
      false,
      env,
    );
    await run([...compose, "restart", "redis"], false, env);
    await run([...compose, "up", "-d", "--wait", "redis"], false, env);
    const value = await run(
      [
        ...compose,
        "exec",
        "-T",
        "redis",
        "redis-cli",
        "-a",
        testSecrets.redisPassword,
        "GET",
        "bakery_b0102_probe",
      ],
      false,
      env,
    );
    assert(value.includes("persisted"));
  } finally {
    await run([...compose, "down", "-v"], true, env);
    for (const network of networks) {
      await run(["network", "rm", network], true, env);
    }
  }
});

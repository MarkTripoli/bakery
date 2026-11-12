import { assert, assertEquals } from "@std/assert";
import {
  createDispatchLaunch,
  dispatchEnvironment,
} from "../../apps/server/scripts/run-dispatch.ts";

type ComposeService = {
  image?: string;
  profiles?: string[];
  ports?: Array<{ host_ip?: string; published?: string; target?: number }>;
  command?: string[];
  environment?: Record<string, string | null>;
  networks?: Record<string, unknown>;
  volumes?: Array<string | { source?: string; target?: string }>;
  read_only?: boolean;
  healthcheck?: unknown;
  depends_on?: Record<string, unknown>;
};

Deno.test("dispatcher child environment excludes unrelated credentials", () => {
  const inherited = {
    PATH: "/usr/bin",
    INNGEST_EVENT_KEY: "required-event-key",
    INNGEST_URL: "http://127.0.0.1:8288",
    DATABASE_URL: "postgres://excluded",
    BAKERY_ADMIN_DATABASE_URL: "postgres://excluded-admin",
    BETTER_AUTH_SECRET: "excluded-auth-secret",
    GITHUB_TOKEN: "excluded-github-token",
  };
  const environment = dispatchEnvironment(inherited);
  assertEquals(environment.INNGEST_EVENT_KEY, "required-event-key");
  assertEquals(environment.INNGEST_URL, "http://127.0.0.1:8288");
  for (
    const excluded of [
      "DATABASE_URL",
      "BAKERY_ADMIN_DATABASE_URL",
      "BETTER_AUTH_SECRET",
      "GITHUB_TOKEN",
    ]
  ) {
    assertEquals(environment[excluded], undefined, `${excluded} leaked`);
  }
  const launch = createDispatchLaunch(inherited);
  assertEquals(launch.clearEnv, true);
  assertEquals(launch.env, environment);
});

Deno.test("dispatcher child keeps the Deno cache and private Inngest suffix without leaking secrets", () => {
  const inherited = {
    PATH: "/usr/bin",
    DENO_DIR: "/deno-dir",
    HOME: "/root",
    BAKERY_ENV: "production",
    INNGEST_EVENT_KEY: "required-event-key",
    INNGEST_URL: "http://inngest.railway.internal:8288",
    BAKERY_INNGEST_PRIVATE_HOST_SUFFIX: ".railway.internal",
    DATABASE_URL: "postgres://excluded",
    BETTER_AUTH_SECRET: "excluded-auth-secret",
    BAKERY_SECRETS_KEY_B64: "excluded-secrets-key",
  };
  const environment = dispatchEnvironment(inherited);
  assertEquals(environment.DENO_DIR, "/deno-dir");
  assertEquals(
    environment.BAKERY_INNGEST_PRIVATE_HOST_SUFFIX,
    ".railway.internal",
  );
  for (
    const excluded of [
      "HOME",
      "DATABASE_URL",
      "BETTER_AUTH_SECRET",
      "BAKERY_SECRETS_KEY_B64",
    ]
  ) {
    assertEquals(environment[excluded], undefined, `${excluded} leaked`);
  }
  assertEquals(
    dispatchEnvironment({ PATH: "/usr/bin" }).DENO_DIR,
    undefined,
  );
  assertEquals(
    createDispatchLaunch(inherited).env.DENO_DIR,
    "/deno-dir",
  );
});

const readCompose = async (
  overrides: Record<string, string | undefined> = {},
): Promise<Record<string, unknown>> => {
  const environment: Record<string, string> = {
    ...Deno.env.toObject(),
    BETTER_AUTH_SECRET: "bakery-compose-security-test-secret",
  };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete environment[name];
    else environment[name] = value;
  }
  const result = await new Deno.Command("docker", {
    args: [
      "compose",
      "--profile",
      "worker",
      "-f",
      "infra/compose.yaml",
      "config",
      "--format",
      "json",
    ],
    cwd: Deno.cwd(),
    env: environment,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    throw new Error(
      "Docker/Compose is unavailable; security validation fails closed: " +
        new TextDecoder().decode(result.stderr),
    );
  }
  return JSON.parse(new TextDecoder().decode(result.stdout));
};

Deno.test("compose preserves optional server configuration intent", async () => {
  const optionalNames = [
    "BAKERY_SECRETS_KEY_FILE",
    "BAKERY_SECRETS_KEY_ID",
    "BAKERY_SECRET_IDENTITY_PROVIDER_FIXTURE_FILE",
  ] as const;
  const unsetOverrides = Object.fromEntries(
    optionalNames.map((name) => [name, undefined]),
  );
  const unset = await readCompose(unsetOverrides);
  const unsetEnvironment = (unset.services as Record<string, ComposeService>)
    .server.environment ?? {};
  for (const name of optionalNames) {
    assertEquals(unsetEnvironment[name], null);
  }

  const explicitEmpty = await readCompose({
    BAKERY_SECRETS_KEY_FILE: "",
    BAKERY_SECRETS_KEY_ID: "",
    BAKERY_SECRET_IDENTITY_PROVIDER_FIXTURE_FILE: "",
  });
  const explicitEmptyEnvironment = (
    explicitEmpty.services as Record<string, ComposeService>
  ).server.environment ?? {};
  for (const name of optionalNames) {
    assertEquals(explicitEmptyEnvironment[name], "");
  }

  const partial = await readCompose({
    BAKERY_SECRETS_KEY_FILE: "/run/secrets/bakery-key",
    BAKERY_SECRETS_KEY_ID: undefined,
    BAKERY_SECRET_IDENTITY_PROVIDER_FIXTURE_FILE: undefined,
  });
  const partialEnvironment =
    (partial.services as Record<string, ComposeService>)
      .server.environment ?? {};
  assertEquals(
    partialEnvironment.BAKERY_SECRETS_KEY_FILE,
    "/run/secrets/bakery-key",
  );
  assertEquals(partialEnvironment.BAKERY_SECRETS_KEY_ID, null);
  assertEquals(
    partialEnvironment.BAKERY_SECRET_IDENTITY_PROVIDER_FIXTURE_FILE,
    null,
  );
});

Deno.test("local stack pins services and isolates worker credentials", async () => {
  const document = await readCompose();
  const services = document.services as Record<string, ComposeService>;
  for (
    const name of [
      "config-guard",
      "postgres",
      "redis",
      "inngest",
      "server",
      "worker",
    ]
  ) {
    assert(services[name], `${name} service is required`);
    assert(
      services[name].image?.includes("@sha256:"),
      `${name} image must use a digest`,
    );
  }
  for (const name of ["postgres", "redis", "inngest", "server"]) {
    assert(services[name].healthcheck, `${name} must have a health check`);
  }
  for (const name of ["postgres", "inngest", "server"]) {
    for (const port of services[name].ports ?? []) {
      assertEquals(
        port.host_ip,
        "127.0.0.1",
        `${name} publishes a non-loopback port`,
      );
      assert(port.published, `${name} must publish a host port`);
    }
  }

  const redisCommand = (services.redis.command ?? []).join(" ");
  assert(redisCommand.includes("--appendonly yes"));
  assert(redisCommand.includes("--appendfsync everysec"));
  assert(redisCommand.includes("--maxmemory-policy noeviction"));
  const postgresHealthcheck = JSON.stringify(services.postgres.healthcheck);
  assert(postgresHealthcheck.includes("pg_database"));
  assert(postgresHealthcheck.includes("bakery"));
  assert(postgresHealthcheck.includes("inngest"));

  const worker = services.worker;
  assertEquals(worker.profiles, ["worker"]);
  assertEquals(worker.read_only, true);
  assertEquals(worker.ports?.length ?? 0, 0);
  assertEquals(Object.keys(worker.networks ?? {}).sort(), ["app"]);
  const workerMountTargets = (worker.volumes ?? []).map((volume) =>
    typeof volume === "string" ? volume.split(":").at(-1) : volume.target
  );
  assert(workerMountTargets.includes("/workspace/apps/worker"));
  assert(workerMountTargets.includes("/workspace/packages/config"));
  assert(!workerMountTargets.includes("/workspace"));
  assert(
    !(worker.volumes ?? []).some((volume) =>
      (typeof volume === "string"
        ? volume
        : `${volume.source ?? ""}:${volume.target ?? ""}`).includes(
          "docker.sock",
        )
    ),
  );
  const workerEnvironment = Object.keys(worker.environment ?? {}).join(" ");
  assert(!workerEnvironment.includes("DATABASE_URL"));
  assert(!workerEnvironment.includes("INNGEST_SIGNING_KEY"));
  assert(!workerEnvironment.includes("BAKERY_LOCAL_"));

  const serverNetworks = Object.keys(services.server.networks ?? {});
  assert(serverNetworks.includes("infra"));
  assert(serverNetworks.includes("app"));
  assert(
    String(services.server.environment?.INNGEST_EVENT_KEY).trim().length > 0,
  );
  assert((document.volumes as Record<string, unknown>)["postgres-data"]);
  assert((document.volumes as Record<string, unknown>)["redis-data"]);
  assertEquals(
    (document.networks as Record<string, { internal?: boolean }>).infra
      .internal,
    true,
  );
  assert(
    services.server.environment?.BAKERY_PUBLIC_BASE_URL?.includes(
      "http://127.0.0.1:8000",
    ),
  );
  assertEquals(
    services.worker.environment?.BAKERY_SERVER_URL,
    "http://server:8000",
  );
  const alternate = await readCompose({ BAKERY_SERVER_PORT: "18000" });
  const alternateServer = (alternate.services as Record<string, ComposeService>)
    .server;
  assertEquals(
    alternateServer.environment?.BAKERY_PUBLIC_BASE_URL,
    "http://127.0.0.1:18000",
  );
  const devcontainer = JSON.parse(
    await Deno.readTextFile(".devcontainer/devcontainer.json"),
  ) as { dockerComposeFile?: string[] };
  assertEquals(devcontainer.dockerComposeFile, [
    "../infra/compose.yaml",
    "docker-compose.override.yml",
  ]);
  const dockerfile = await Deno.readTextFile(".devcontainer/Dockerfile");
  assert(dockerfile.includes("denoland/deno:2.9.1@sha256:"));
  assert(dockerfile.includes("NODE_VERSION=22.22.0"));
  assert(dockerfile.includes("PNPM_SHA512="));
  assert(
    dockerfile.includes(
      "npm install --global --ignore-scripts --no-audit --no-fund /tmp/pnpm.tgz",
    ),
  );
  assert(dockerfile.includes("sha256sum --check --status"));
  assert(dockerfile.includes("sha512sum --check --status"));
  const override = await Deno.readTextFile(
    ".devcontainer/docker-compose.override.yml",
  );
  assert(override.includes("image: bakery-b01-02-devcontainer:local"));
  assert(override.includes("context: ../.devcontainer"));
  assert(
    dockerfile.includes("apt-get install --no-install-recommends --yes \\"),
  );
  assert(dockerfile.includes("ca-certificates=20250419"));
  const redisHealthcheck = JSON.stringify(services.redis.healthcheck);
  assert(redisHealthcheck.includes('"CMD-SHELL"'));
  assert(redisHealthcheck.includes("$$BAKERY_LOCAL_REDIS_PASSWORD"));
  assert(!redisHealthcheck.includes("BAKERY_LOCAL_REDIS_PASSWORD:-"));
  assert(redisHealthcheck.includes(" -e "));
  const configGuard = services["config-guard"];
  assertEquals(configGuard.ports?.length ?? 0, 0);
  assertEquals(configGuard.volumes?.length ?? 0, 0);
  assert(JSON.stringify(services.postgres.depends_on).includes("config-guard"));
  const inngestCommand = (services.inngest.command ?? []).join(" ");
  assert(inngestCommand.includes("URI-safe"));
  const serverCommand = (services.server.command ?? []).join(" ");
  assert(serverCommand.includes("URI-safe"));
});

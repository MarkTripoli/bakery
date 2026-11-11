import { assert, assertEquals, assertThrows } from "@std/assert";
import { createRequire } from "node:module";
import { isMap, isSeq, parseDocument } from "yaml";
import { implementedActions } from "../../packages/contracts/src/implemented-actions.ts";
import {
  generateContracts,
  toJsonSchema,
} from "../../packages/contracts/src/contracts.ts";
import { FAULTS } from "../../packages/contracts/src/http.ts";
import transportSchemas from "../../docs/technical-design/transport-schemas.json" with {
  type: "json",
};
import contractQualityPlugin from "../../scripts/lint/contract-quality.ts";
import { createStackServices } from "../../scripts/run-stack.ts";
import { dispatchEnvironment } from "../../apps/server/scripts/run-dispatch.ts";

const root = decodeURIComponent(new URL("../..", import.meta.url).pathname);
const read = async (path: string) => await Deno.readTextFile(`${root}${path}`);
const runPnpmScript = async (command: string): Promise<void> => {
  const result = await new Deno.Command("pnpm", {
    args: [command],
    cwd: root,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  assertEquals(
    result.code,
    0,
    `pnpm ${command} failed:\nstdout:\n${stdout}\nstderr:\n${stderr}`,
  );
};

Deno.test("workspace declares the server, worker, contracts, and config packages", async () => {
  const workspace = await read("pnpm-workspace.yaml");
  for (const packagePath of ["apps/*", "packages/*"]) {
    assert(workspace.includes(packagePath));
  }
  for (
    const path of [
      "apps/server/package.json",
      "apps/worker/package.json",
      "packages/contracts/package.json",
      "packages/config/package.json",
    ]
  ) {
    const packageJson = JSON.parse(await read(path));
    assert(typeof packageJson.name === "string");
  }
});

Deno.test("lint gate names every workspace package directory", async () => {
  const rootPackage = JSON.parse(await read("package.json"));
  const directories: string[] = [];
  for (const parent of ["apps", "packages"]) {
    for await (const entry of Deno.readDir(`${root}${parent}`)) {
      if (!entry.isDirectory) continue;
      const path = `${parent}/${entry.name}`;
      try {
        await Deno.stat(`${root}${path}/package.json`);
      } catch {
        continue;
      }
      directories.push(path);
    }
  }
  assert(directories.length >= 5);
  // The Deno directory walk only descends into a nested directory that carries
  // its own deno.json, so every workspace directory must be named explicitly or
  // its files silently leave the format and lint gate.
  for (const script of ["fmt", "lint"]) {
    const command = rootPackage.scripts[script] as string;
    for (const directory of directories) {
      assert(
        command.includes(`${directory} `),
        `${script} must name ${directory}`,
      );
    }
  }
});

Deno.test("startup, migration, and dispatch tasks are explicitly uncached", async () => {
  const turbo = JSON.parse(await read("turbo.json"));
  for (const task of ["startup", "migrate", "dispatch"]) {
    assertEquals(turbo.tasks[task].cache, false);
  }
  assertEquals(turbo.globalPassThroughEnv, undefined);
  const stackRunner = await read("scripts/run-stack.ts");
  assert(stackRunner.includes("WORKER_RUNTIME_ENVIRONMENT_NAMES"));
  assert(stackRunner.includes("BAKERY_WORKER_PROFILE"));
  assert(!stackRunner.includes('"--allow-read"'));
  assert(!stackRunner.includes('"--allow-write"'));
  assert(!stackRunner.includes('"--allow-net"'));
  assert(!stackRunner.includes('"--allow-sys=hostname"'));

  assert(stackRunner.includes("readWorkerLaunchPermissions"));
  assert(stackRunner.includes("clearEnv: service.clearEnv"));
  assert(stackRunner.includes('command: "bash"'));
  assert(stackRunner.includes('args: ["scripts/run-main.sh"]'));
  assert(
    !stackRunner.includes('"DATABASE_URL"'),
    "worker allowlist must not include database credentials",
  );
  assert(
    !stackRunner.includes('"INNGEST_URL"'),
    "worker allowlist must not include Inngest credentials",
  );
  assert(stackRunner.includes('args: ["-0", String(parentPid)]'));
  const workerPackage = JSON.parse(await read("apps/worker/package.json"));
  assert(workerPackage.scripts.start.includes("env -i"));
  assert(workerPackage.scripts.start.includes(
    'BAKERY_WORKER_OUTPUT_REDACTION_SECRETS="${BAKERY_WORKER_OUTPUT_REDACTION_SECRETS:-}"',
  ));
  assert(workerPackage.scripts.start.includes(
    'BAKERY_WORKER_LAUNCH_ID="${BAKERY_WORKER_LAUNCH_ID:-}"',
  ));
  assert(workerPackage.scripts.dev.includes(
    'BAKERY_WORKER_OUTPUT_REDACTION_SECRETS="${BAKERY_WORKER_OUTPUT_REDACTION_SECRETS:-}"',
  ));
  assert(workerPackage.scripts.dev.includes(
    'BAKERY_WORKER_LAUNCH_ID="${BAKERY_WORKER_LAUNCH_ID:-}"',
  ));
  assert(workerPackage.scripts.start.includes("bash scripts/run-worker.sh"));
  assert(
    !workerPackage.scripts.start.includes("--allow-read"),
    "worker package must not embed a broad read grant",
  );
  assert(
    !workerPackage.scripts.start.includes("--allow-write"),
    "worker package must not embed a broad write grant",
  );
  const workerLauncher = await read("apps/worker/scripts/run-worker.sh");
  assert(workerLauncher.includes("deno run --no-prompt --allow-env="));
  assert(workerLauncher.includes("BAKERY_WORKER_OUTPUT_REDACTION_SECRETS"));
  assert(workerLauncher.includes("BAKERY_WORKER_LAUNCH_ID"));
  assert(workerLauncher.includes("exec deno run \\"));
  assertEquals((workerLauncher.match(/--no-prompt/g) ?? []).length, 2);
  assert(workerLauncher.includes('"--allow-read=${worker_grants[0]}"'));
  assert(workerLauncher.includes('"--allow-write=${worker_grants[1]}"'));
  assert(workerLauncher.includes('"--allow-net=${worker_grants[2]}"'));
  assert(workerLauncher.includes('"--allow-run=${worker_grants[3]}"'));
  assert(workerLauncher.includes('"--allow-sys=${worker_grants[4]}"'));
  assert(!workerLauncher.includes("--allow-sys=hostname"));
  assert(workerLauncher.includes("BAKERY_WORKER_NATIVE_SMOKE"));
  assert(workerLauncher.includes("BAKERY_WORKER_NATIVE_OUTPUT_FIXTURE"));
  assert(workerLauncher.includes("PATH"));
  assert(workerLauncher.includes("DENO_DIR"));
  assert(workerLauncher.includes("TMPDIR"));
  const workerCompose = await read("infra/compose.yaml");
  const workerStart = workerCompose.indexOf("\n  worker:");
  const workerPairStart = workerCompose.indexOf("\n  worker-pair:");
  const workerComposeService = workerCompose.slice(
    workerStart,
    workerPairStart,
  );
  const workerPairService = workerCompose.slice(workerPairStart);
  assert(workerComposeService.startsWith("\n  worker:"));
  assert(workerPairService.startsWith("\n  worker-pair:"));
  assert(workerComposeService.includes("cd apps/worker"));
  assert(workerComposeService.includes("scripts/run-worker.sh"));
  assert(workerComposeService.includes("BAKERY_WORKER_CGROUP_ROOT"));
  assert(
    workerComposeService.includes("BAKERY_WORKER_OUTPUT_REDACTION_SECRETS"),
  );
  assert(workerComposeService.includes("cgroup.events"));
  assert(workerComposeService.includes("cgroup.procs"));
  assert(workerComposeService.includes("cgroup.kill"));
  assert(
    workerComposeService.includes("BAKERY_SERVER_URL: http://server:8000"),
  );
  assert(workerCompose.includes('profiles: ["worker"]'));
  assert(workerCompose.includes('profiles: ["worker-pair"]'));
  assert(workerCompose.includes(
    "BAKERY_WORKER_CGROUP_ROOT: /sys/fs/cgroup/bakery-worker",
  ));
  assert(workerPairService.includes(
    "BAKERY_WORKER_CGROUP_ROOT: /sys/fs/cgroup/bakery-worker-pair",
  ));
  assert(workerCompose.includes(
    "../node_modules/zod:/workspace/node_modules/zod:ro",
  ));
  assert(workerCompose.includes(
    "../docs/technical-design/api-catalog.json:/workspace/docs/technical-design/api-catalog.json:ro",
  ));
  assert(workerCompose.includes("- worker-state:/var/lib/bakery-worker"));
  assert(workerCompose.includes("worker_enrollment_token:"));
  assert(workerCompose.includes("environment: BAKERY_WORKER_ENROLLMENT_TOKEN"));
  assert(!workerComposeService.includes("privileged:"));
  assert(!workerComposeService.includes("--allow-all"));
  assert(!workerComposeService.includes("/sys/fs/cgroup:"));
  assert(
    !workerComposeService.includes(
      "BAKERY_WORKER_ENROLLMENT_TOKEN_FILE: /run/secrets/worker-enrollment",
    ),
    "normal worker restart must not require enrollment secret",
  );
  assert(workerPairService.includes(
    "BAKERY_WORKER_ENROLLMENT_TOKEN_FILE: /run/secrets/worker-enrollment",
  ));
  assert(workerPairService.includes("target: worker-enrollment"));
  assert(workerPairService.includes("mode: 0400"));
  const workerOverride = await read(
    ".devcontainer/docker-compose.override.yml",
  );
  const overrideWorkerStart = workerOverride.indexOf("\n  worker:");
  const overridePairStart = workerOverride.indexOf("\n  worker-pair:");
  const workerOverrideService = workerOverride.slice(
    overrideWorkerStart,
    overridePairStart,
  );
  const workerOverridePair = workerOverride.slice(overridePairStart);
  assert(workerOverride.includes("exec bash scripts/run-worker.sh"));
  assert(workerOverride.includes("BAKERY_WORKER_CGROUP_ROOT"));
  assert(workerOverride.includes("cgroup.kill"));
  assert(workerOverride.includes('profiles: ["worker"]'));
  assert(workerOverride.includes('profiles: ["worker-pair"]'));
  assert(!workerOverrideService.includes("privileged:"));
  assert(!workerOverrideService.includes("--allow-all"));
  assert(
    !workerOverrideService.includes(
      "BAKERY_WORKER_ENROLLMENT_TOKEN_FILE: /run/secrets/worker-enrollment",
    ),
  );
  assert(workerOverridePair.includes(
    "BAKERY_WORKER_ENROLLMENT_TOKEN_FILE: /run/secrets/worker-enrollment",
  ));
  assert(workerOverridePair.includes("source: worker_enrollment_token"));
  assert(workerOverridePair.includes("target: worker-enrollment"));
  assert(workerOverridePair.includes("mode: 0400"));
  assertEquals(
    JSON.parse(await read("package.json")).packageManager,
    "pnpm@10.33.0",
  );
  const rootPackage = JSON.parse(await read("package.json"));
  const serverPackage = JSON.parse(await read("apps/server/package.json"));
  for (const task of ["dev", "start"]) {
    const command = serverPackage.scripts[task] as string;
    assertEquals(command, "bash scripts/run-main.sh");
  }
  const serverLauncher = await read("apps/server/scripts/run-main.sh");
  assert(serverLauncher.includes('exec env -i "${sanitized_environment[@]}"'));
  assert(serverLauncher.includes("deno run --allow-env "));
  assert(serverLauncher.includes("INNGEST_EVENT_KEY"));
  const allowedLauncherNames = new Set(
    serverLauncher.slice(
      serverLauncher.indexOf("readonly allowed_names=("),
      serverLauncher.indexOf("\n)\n"),
    ).split("\n").map((line) => line.trim()),
  );
  for (
    const name of [
      "BAKERY_BUDGET_INSTALLATION_MONTHLY_LIMIT_USD",
      "BAKERY_BUDGET_RESERVATION_TTL_SECONDS",
      "BAKERY_BUDGET_MAX_RUN_DURATION_SECONDS",
      "BAKERY_INNGEST_PRIVATE_HOST_SUFFIX",
      "BAKERY_TRUSTED_PROXY_CIDRS",
      "DENO_DIR",
    ]
  ) {
    assert(allowedLauncherNames.has(name), `${name} missing from run-main.sh`);
  }
  assert(!allowedLauncherNames.has("BAKERY_SECRETS_KEY_B64"));
  assert(rootPackage.scripts["auth:migrations:generate"]);
  assert(rootPackage.scripts.createsuperuser);
  assertEquals(
    rootPackage.scripts["test:browser"],
    "playwright test --config tests/browser/playwright.config.ts",
  );
  assertEquals(rootPackage.devDependencies["@playwright/test"], "1.63.0");
  assertEquals(rootPackage.devDependencies["@axe-core/playwright"], "4.13.0");
  const migrationSources = [
    "src/platform/migrations",
    "src/modules/auth/migrations",
    "src/modules/work/migrations",
    "src/modules/projects/migrations",
    "src/modules/agents/migrations",
    "src/modules/repository-rules/migrations",
    "src/modules/integrations/migrations",
    "src/modules/delivery/migrations",
  ];
  for (const task of ["startup", "migrate", "createsuperuser"]) {
    const command = serverPackage.scripts[task] as string;
    const readAllowlist = command.split(" ").find((argument) =>
      argument.startsWith("--allow-read=")
    )?.slice("--allow-read=".length).split(",") ?? [];
    for (const source of migrationSources) {
      assert(readAllowlist.includes(source), `${task} must read ${source}`);
    }
  }
  const browserConfig = await read("tests/browser/playwright.config.ts");
  const browserReadAllowlist = browserConfig.split("--allow-read=")[1]
    ?.split(" ")[0].split(",") ?? [];
  for (const source of migrationSources) {
    assert(
      browserReadAllowlist.includes(`apps/server/${source}`),
      `browser web server must read apps/server/${source}`,
    );
  }
  assert(
    serverPackage.scripts["auth:migrations:generate"].includes(
      "--allow-write=src/modules/auth/migrations/provider",
    ),
  );
  const createsuperuser = serverPackage.scripts.createsuperuser as string;
  assert(createsuperuser.includes("FORCE_COLOR=0 deno run"));
  assert(createsuperuser.includes("src/tasks.ts createsuperuser"));
  assert(createsuperuser.includes("--allow-env=DATABASE_URL,"));
  assert(createsuperuser.includes("--allow-net"));
  assert(!createsuperuser.includes("--allow-all"));
  assert(!createsuperuser.includes("--allow-run"));
  const bootstrapDatabase = serverPackage.scripts["bootstrap:database"] as
    | string
    | undefined;
  assert(bootstrapDatabase, "bootstrap:database script missing");
  assert(bootstrapDatabase.startsWith("deno run "));
  assert(bootstrapDatabase.endsWith(" scripts/bootstrap-database.ts"));
  const bootstrapPermissions = bootstrapDatabase.split(/\s+/).filter(
    (argument) => argument.startsWith("-"),
  );
  assertEquals(bootstrapPermissions.length, 2);
  assert(bootstrapPermissions.includes("--allow-net"));
  const bootstrapEnvironment =
    bootstrapPermissions.find((argument) => argument.startsWith("--allow-env="))
      ?.slice("--allow-env=".length).split(",") ?? [];
  for (
    const name of [
      "BAKERY_BOOTSTRAP_DATABASE_URL",
      "BAKERY_OWNER_PASSWORD",
      "BAKERY_APP_PASSWORD",
      "BAKERY_INNGEST_DATABASE_PASSWORD",
    ]
  ) {
    assert(bootstrapEnvironment.includes(name), `${name} not allowed`);
  }
  // The privileged bootstrap sees its own inputs and the driver's PG* names,
  // never the runtime database URLs, auth secrets or the secrets key.
  for (
    const name of [
      "DATABASE_URL",
      "BAKERY_APP_DATABASE_URL",
      "BETTER_AUTH_SECRET",
      "BAKERY_SECRETS_KEY_B64",
      "BAKERY_ADMIN_DATABASE_URL",
    ]
  ) {
    assert(!bootstrapEnvironment.includes(name), `${name} must stay denied`);
  }
  for (
    const argument of ["--allow-all", "-A", "--allow-run", "--allow-read"]
  ) {
    assert(!bootstrapDatabase.includes(argument), `${argument} not allowed`);
  }
  const dispatch = serverPackage.scripts.dispatch as string;
  assert(dispatch.includes("src/dispatch.ts"));
  assert(!dispatch.includes("src/tasks.ts"));
  const expectedDispatchEnvironment = [
    "DENO_DIR",
    "BAKERY_PUBLIC_BASE_URL",
    "BAKERY_SERVER_SENTRY_DSN",
    "BAKERY_SENTRY_ENABLED",
    "BAKERY_SENTRY_ENVIRONMENT",
    "BAKERY_SENTRY_RELEASE",
    "BAKERY_SENTRY_TRACES_SAMPLE_RATE",
    "BAKERY_APP_DATABASE_URL",
    "BAKERY_ENV",
    "INNGEST_URL",
    "INNGEST_EVENT_KEY",
    "BAKERY_INNGEST_LOCAL_COMPOSE",
    "BAKERY_INNGEST_PRIVATE_HOST_SUFFIX",
    "USER",
    "NODE_PG_FORCE_NATIVE",
    "PGSSL",
    "PGMAX_LIFETIME",
    "PGMAX_PIPELINE",
    "PGBACKOFF",
    "PGKEEP_ALIVE",
    "PGPREPARE",
    "PGDEBUG",
    "PGFETCH_TYPES",
    "PGPUBLICATIONS",
    "PGTARGET_SESSION_ATTRS",
    "PGTARGETSESSIONATTRS",
    "PGUSER",
    "PGDATABASE",
    "PGPORT",
    "PGHOST",
    "PGPASSWORD",
    "PGBINARY",
    "PGOPTIONS",
    "PGSSLMODE",
    "PGSSLNEGOTIATION",
    "PGCLIENT_ENCODING",
    "PGREPLICATION",
    "PGAPPNAME",
    "PGCONNECT_TIMEOUT",
    "PATH",
  ];
  const assertDispatchEnvironment = (command: string): void => {
    const argumentsList = command.split(/\s+/);
    assert(!argumentsList.includes("--allow-all"));
    assert(!argumentsList.includes("-A"));
    const permissionArguments = argumentsList.filter((argument) =>
      argument.startsWith("--allow-env")
    );
    assertEquals(permissionArguments.length, 1);
    const [permissionArgument] = permissionArguments;
    assert(permissionArgument?.startsWith("--allow-env="));
    assertEquals(
      permissionArgument.slice("--allow-env=".length).split(",").sort(),
      [...expectedDispatchEnvironment].sort(),
    );
  };
  assertDispatchEnvironment(dispatch);
  // The launcher reads DENO_DIR with Deno.env.get, so the permission list must
  // name it; the child then keeps the baked module cache (clearEnv drops it
  // otherwise and Deno falls back to the passwd-home cache).
  assertEquals(
    dispatchEnvironment({ PATH: "/usr/bin", DENO_DIR: "/deno-dir" }).DENO_DIR,
    "/deno-dir",
  );
  const dispatchEnvironmentArgument = dispatch.split(/\s+/).find((argument) =>
    argument.startsWith("--allow-env=")
  );
  assert(dispatchEnvironmentArgument);
  assertDispatchEnvironment(dispatch.replace(
    dispatchEnvironmentArgument,
    `--allow-env=${[...expectedDispatchEnvironment].reverse().join(",")}`,
  ));
  for (
    const name of [
      "BAKERY_ADMIN_DATABASE_URL",
      "GITHUB_TOKEN",
      "SENTRY_AUTH_TOKEN",
    ]
  ) {
    assertThrows(() =>
      assertDispatchEnvironment(dispatch.replace(
        dispatchEnvironmentArgument,
        `${dispatchEnvironmentArgument},${name}`,
      ))
    );
  }
  for (
    const argument of [
      "--allow-env",
      "--allow-env=GITHUB_TOKEN",
      "--allow-env=",
      "--allow-all",
      "-A",
    ]
  ) {
    assertThrows(() => assertDispatchEnvironment(`${dispatch} ${argument}`));
  }
  assertThrows(() =>
    assertDispatchEnvironment(dispatch.replace(
      dispatchEnvironmentArgument,
      "--allow-env",
    ))
  );
  assertThrows(() =>
    assertDispatchEnvironment(dispatch.replace(
      ",BAKERY_SENTRY_RELEASE",
      "",
    ))
  );
});

Deno.test("root stack keeps the worker behind the explicit worker profile", () => {
  const inherited = {
    PATH: "/bin",
    HOME: "/home/fixture",
    TMPDIR: "/tmp",
    BAKERY_ENV: "development",
    BAKERY_SERVER_HOST: "127.0.0.2",
    BAKERY_SERVER_PORT: "8100",
    BAKERY_WEB_HOST: "127.0.0.4",
    BAKERY_WEB_PORT: "5100",
    DATABASE_URL: "postgres://worker-secret",
    BETTER_AUTH_SECRET: "auth-secret",
    INNGEST_EVENT_KEY: "provider-secret",
  };
  for (const mode of ["dev", "start"] as const) {
    const defaultServices = createStackServices({
      mode,
      root: "/workspace/",
      inherited,
      denoPath: "/bin/deno",
    });
    assertEquals(defaultServices.length, 2);
    assertEquals(defaultServices[0], {
      command: "bash",
      args: ["scripts/run-main.sh"],
      cwd: "/workspace/apps/server",
      clearEnv: false,
      env: inherited,
    });
    assertEquals(defaultServices[1].command, "pnpm");
    assertEquals(defaultServices[1].args, ["--filter", "@bakery/web", mode]);

    const services = createStackServices({
      mode,
      root: "/workspace/",
      inherited: {
        ...inherited,
        BAKERY_WORKER_PROFILE: "worker",
        BAKERY_WORKER_CGROUP_ROOT: "/sys/fs/cgroup/bakery-worker",
        BAKERY_WORKER_ENROLLMENT_TOKEN_FILE: "/run/secrets/worker-enrollment",
        BAKERY_WORKER_STATE_DIR: "/var/lib/bakery-worker",
      },
      denoPath: "/bin/deno",
    });
    assertEquals(services.length, 3);
    assertEquals(services[1].command, "/bin/deno");
    assertEquals(services[1].cwd, "/workspace/apps/worker");
    assertEquals(services[1].clearEnv, true);
    assertEquals(Object.keys(services[1].env).sort(), [
      "BAKERY_ENV",
      "BAKERY_SERVER_URL",
      "BAKERY_WORKER_CAPABILITIES",
      "BAKERY_WORKER_CGROUP_ROOT",
      "BAKERY_WORKER_ENROLLMENT_TOKEN_FILE",
      "BAKERY_WORKER_STATE_DIR",
      "HOME",
      "PATH",
      "TMPDIR",
    ]);
    assertEquals(services[1].env.BAKERY_SERVER_URL, "http://127.0.0.2:8100");
    assertEquals(services[1].env.BAKERY_WORKER_CAPABILITIES, "git");
    assertEquals(
      services[1].env.BAKERY_WORKER_ENROLLMENT_TOKEN_FILE,
      "/run/secrets/worker-enrollment",
    );
    assertEquals(
      services[1].env.BAKERY_WORKER_CGROUP_ROOT,
      "/sys/fs/cgroup/bakery-worker",
    );
    assertEquals(services[2].command, "pnpm");
    assertEquals(services[2].args, ["--filter", "@bakery/web", mode]);
    assertEquals(services[2].cwd, "/workspace/");
    assertEquals(services[2].clearEnv, true);
    assertEquals(Object.keys(services[2].env).sort(), [
      "BAKERY_ENV",
      "BAKERY_SERVER_HOST",
      "BAKERY_SERVER_PORT",
      "BAKERY_WEB_HOST",
      "BAKERY_WEB_PORT",
      "HOME",
      "PATH",
      "TMPDIR",
    ]);
    assertEquals(services[2].env.BAKERY_ENV, inherited.BAKERY_ENV);
    assertEquals(services[2].env.BAKERY_WEB_HOST, "127.0.0.4");
    assertEquals(services[2].env.BAKERY_WEB_PORT, "5100");
  }
  const productionServices = createStackServices({
    mode: "start",
    root: "/workspace/",
    inherited: {
      ...inherited,
      BAKERY_ENV: "production",
      BAKERY_SERVER_URL: "https://worker.example.test",
      BAKERY_WORKER_PROFILE: "worker",
      BAKERY_WORKER_CGROUP_ROOT: "/sys/fs/cgroup/bakery-worker",
      BAKERY_WORKER_ENROLLMENT_TOKEN_FILE: "/run/secrets/worker-enrollment",
      BAKERY_WORKER_STATE_DIR: "/var/lib/bakery-worker",
    },
    denoPath: "/bin/deno",
  });
  const productionWorker = productionServices[1];
  assert(
    !productionWorker.args.some((argument) =>
      argument.includes("BAKERY_WORKER_NATIVE_SMOKE")
    ),
  );
  assert(!Object.hasOwn(productionWorker.env, "BAKERY_WORKER_NATIVE_SMOKE"));
});

Deno.test("root stack rejects malformed web ports before spawning", () => {
  for (const BAKERY_WEB_PORT of ["nope", "0", "65536", "1.5"]) {
    assertThrows(
      () =>
        createStackServices({
          mode: "dev",
          root: "/workspace/",
          inherited: { BAKERY_WEB_PORT },
          denoPath: "/bin/deno",
        }),
      Error,
      "WEB_PORT_INVALID",
    );
  }
});

Deno.test("migration task requires an owner database URL", async () => {
  const output = await new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-env", "apps/server/src/tasks.ts", "migrate"],
    cwd: root,
    env: { DATABASE_URL: "" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder().decode(output.stderr);
  assert(output.code !== 0);
  assert(text.includes("DATABASE_URL_REQUIRED"));
});

Deno.test("createsuperuser reads only its declared environment variables", async () => {
  const args = Deno.build.os === "linux"
    ? [
      "-q",
      "-c",
      "pnpm --filter @bakery/server createsuperuser",
      "/dev/null",
    ]
    : [
      "-q",
      "/dev/null",
      "pnpm",
      "--filter",
      "@bakery/server",
      "createsuperuser",
    ];
  const result = await new Deno.Command("script", {
    args,
    cwd: root,
    env: {
      ...Deno.env.toObject(),
      DATABASE_URL: "postgres://bakery@example.test:1/bakery",
      BAKERY_ENV: "development",
      INNGEST_URL: "http://127.0.0.1:8288",
      BAKERY_INNGEST_LOCAL_COMPOSE: "0",
      BETTER_AUTH_SECRET: "short",
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const output = `${new TextDecoder().decode(result.stdout)}${
    new TextDecoder().decode(result.stderr)
  }`;
  assert(output.includes("AUTH_CONFIGURATION_INVALID"), output);
  assert(!output.includes("Requires env access"), output);
  assert(!output.includes("PermissionDenied"), output);
});

Deno.test("dispatch starts without auth imports or unrestricted environment access", async () => {
  const result = await new Deno.Command("pnpm", {
    args: ["--filter", "@bakery/server", "dispatch"],
    cwd: root,
    env: {
      ...Deno.env.toObject(),
      BAKERY_APP_DATABASE_URL: "postgres://bakery_app@127.0.0.1:1/bakery",
      BAKERY_ENV: "test",
      INNGEST_URL: "http://127.0.0.1:1",
      INNGEST_EVENT_KEY: "dispatch-startup-test",
      BAKERY_INNGEST_LOCAL_COMPOSE: "0",
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const output = `${new TextDecoder().decode(result.stdout)}${
    new TextDecoder().decode(result.stderr)
  }`;
  assert(result.code !== 0, output);
  assert(!output.includes("NotCapable"), output);
  assert(!output.includes("PermissionDenied"), output);
});

Deno.test("generated contract inventory is fresh and projects runtime capabilities", async () => {
  const generated = JSON.parse(
    await read("packages/contracts/generated/contracts.json"),
  );
  const source = generateContracts();
  assertEquals(generated.schemaVersion, 2);
  assertEquals(generated.actions.length, source.actions.length);
  assertEquals(
    Object.keys(generated.schemas).sort(),
    Object.keys(source.schemas).sort(),
  );
  assertEquals(
    generated.actions.filter((action: { implemented: boolean }) =>
      action.implemented
    ).map((action: { action: string }) => action.action).sort(),
    [...implementedActions].sort(),
  );
  assertEquals(generated.implementedActions, [...implementedActions]);
  assertEquals(generated.compatibilityDigest, source.compatibilityDigest);
  assertEquals(generated.actions, source.actions);
  assertEquals(generated.openapi, source.openapi);
  for (const [name, schema] of Object.entries(source.schemas)) {
    assertEquals(generated.schemas[name], toJsonSchema(schema));
  }
});

Deno.test("every problem code is registered in the transport-schemas fault catalog", () => {
  for (const code of Object.keys(FAULTS)) {
    assert(
      code in transportSchemas.faults,
      `${code} is missing from docs/technical-design/transport-schemas.json faults`,
    );
  }
});

Deno.test("client roots cannot import server authority", () => {
  const clientFile = `${root}apps/web/src/example.ts`;
  const safe = Deno.lint.runPlugin(
    contractQualityPlugin,
    clientFile,
    `import { healthResponseSchema } from "../../../packages/contracts/src/health.ts";
     export { healthResponseSchema };`,
  );
  assertEquals(
    safe.filter((diagnostic) =>
      diagnostic.id === "bakery-contracts/no-client-server-import"
    ),
    [],
  );

  const forbidden = Deno.lint.runPlugin(
    contractQualityPlugin,
    clientFile,
    `export { default as serverApp } from "../../../apps/server/src/main.ts";
     export * from "../../../apps/server/src/main.ts";
     const load = () => import("../../../apps/server/src/main.ts");
     const loadTemplate = () => import(
       \`../../../apps/server/src/main.ts\`
     );`,
  );
  assertEquals(
    forbidden.filter((diagnostic) =>
      diagnostic.id === "bakery-contracts/no-client-server-import"
    ).length,
    4,
  );
});

Deno.test("semantic metadata runs only on supported backend events", async () => {
  const workflow = await read(".github/workflows/ci.yml");
  assert(workflow.includes(
    "types: [opened, synchronize, reopened]",
  ));
  const document = parseDocument(workflow);
  assertEquals(document.errors, []);
  const steps = document.getIn(["jobs", "semantic_metadata", "steps"], true);
  assert(isSeq(steps));
  const validationSteps = steps.items.filter((step) =>
    isMap(step) && typeof step.get("run") === "string" &&
    String(step.get("run")).includes("scripts/ci/validate-semantic.ts")
  );
  assertEquals(validationSteps.length, 3);
  for (
    const [name, event] of [
      ["Validate pull request title", "pull_request"],
      ["Validate pull request commit subjects", "pull_request"],
      ["Validate pushed commit subjects", "push"],
    ]
  ) {
    const step = validationSteps.find((step) =>
      isMap(step) && step.get("name") === name
    );
    assert(isMap(step), `missing semantic validation step: ${name}`);
    assertEquals(step.get("if"), `github.event_name == '${event}'`);
  }
  assert(!workflow.includes("Reject unsupported semantic metadata event"));
});

Deno.test("UI contraction uses current main for feature dispatch", async () => {
  const workflow = await read(".github/workflows/ci.yml");
  // A manual dispatch and the nightly schedule carry no event base, so the
  // router must resolve one (current main) and the contraction ratchet must
  // consume it: `github.event.before` alone hands the lane an empty argument
  // and fails the whole full route.
  assert(
    workflow.includes("      base_sha: ${{ steps.base.outputs.base_sha }}"),
  );
  assert(workflow.includes("origin/$DEFAULT_BRANCH^{commit}"));
  assert(workflow.includes(
    "UI_ARCHITECTURE_BASE: ${{ github.event.pull_request.base.sha || github.event.before || needs.changes.outputs.base_sha }}",
  ));
  assert(
    !workflow.includes(
      "UI_ARCHITECTURE_BASE: ${{ github.event.pull_request.base.sha || github.event.before }}",
    ),
  );
});

Deno.test("UI browser CI runs every package Playwright spec", async () => {
  const workflow = await read(".github/workflows/ci.yml");
  const document = parseDocument(workflow);
  assertEquals(document.errors, []);
  const steps = document.getIn(["jobs", "ui_storybook_browser", "steps"], true);
  assert(isSeq(steps));
  assert(steps.items.some((step) =>
    isMap(step) &&
    step.get("run") === "node scripts/ci/run-browser-checks.mjs storybook"
  ));
  const { browserCommands } = await import("../../scripts/ci/browser-plan.mjs");
  assertEquals(
    browserCommands("storybook", { full: true, storybook: true, webSpecs: [] }),
    [{ packageDir: "packages/ui", mode: "full", requireCore: false }],
  );
  const executor = await read("scripts/ci/run-browser-checks.mjs");
  assert(
    /spawnSync\("pnpm", \[\s*"--dir",\s*packageDir,\s*"exec",\s*"playwright",\s*"test",\s*\.\.\.args,?\s*\], \{/
      .test(executor),
    "Storybook executor must run Playwright without a file selector",
  );
  // The only arguments are project and shard flags, never a spec path.
  assert(executor.includes('flatMap((project) => ["--project", project])'));
  assert(executor.includes("`--shard=${slice}`"));
  assert(
    executor.includes(
      "const commands = browserCommands(lane, selection, shard);",
    ),
  );
  assert(executor.includes("run(command);"));
  const uiRequire = createRequire(
    new URL("../../packages/ui/package.json", import.meta.url),
  );
  const frameworkRequire = createRequire(
    uiRequire.resolve("@storybook/react-vite"),
  );
  const reactRequire = createRequire(
    frameworkRequire.resolve("@storybook/react"),
  );
  const docgenRequire = createRequire(reactRequire.resolve("react-docgen"));
  const parser: unknown = docgenRequire("@babel/parser");
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  const node = (value: unknown, type: string): Record<string, unknown> => {
    assert(isRecord(value));
    assertEquals(value.type, type);
    return value;
  };
  const properties = (value: unknown): Map<string, unknown> => {
    const object = node(value, "ObjectExpression");
    assert(Array.isArray(object.properties));
    const entries = new Map<string, unknown>();
    for (const member of object.properties) {
      const property = node(member, "ObjectProperty");
      assertEquals(property.computed, false);
      assertEquals(property.shorthand, false);
      assert(isRecord(property.key));
      const name = property.key.type === "Identifier"
        ? property.key.name
        : node(property.key, "StringLiteral").value;
      assert(typeof name === "string");
      assert(!entries.has(name), `duplicate config property: ${name}`);
      entries.set(name, property.value);
    }
    return entries;
  };
  assert(isRecord(parser) && typeof parser.parse === "function");
  const tree: unknown = parser.parse(
    await read("packages/ui/playwright.config.ts"),
    {
      sourceType: "module",
      plugins: ["typescript"],
    },
  );
  const program = node(node(tree, "File").program, "Program");
  assert(Array.isArray(program.body));
  assertEquals(program.body.length, 2);
  const imports = node(program.body[0], "ImportDeclaration");
  assertEquals(node(imports.source, "StringLiteral").value, "@playwright/test");
  assert(Array.isArray(imports.specifiers));
  assert(imports.specifiers.some((value: unknown) => {
    const specifier = node(value, "ImportSpecifier");
    return node(specifier.imported, "Identifier").name === "defineConfig" &&
      node(specifier.local, "Identifier").name === "defineConfig";
  }));
  const exported = node(program.body[1], "ExportDefaultDeclaration");
  const call = node(exported.declaration, "CallExpression");
  assertEquals(node(call.callee, "Identifier").name, "defineConfig");
  assert(Array.isArray(call.arguments));
  assertEquals(call.arguments.length, 1);
  const config = properties(call.arguments[0]);
  assertEquals(node(config.get("testDir"), "StringLiteral").value, "./tests");
  const projects = node(config.get("projects"), "ArrayExpression");
  assert(Array.isArray(projects.elements));
  assertEquals(projects.elements.length, 1);
  const project = properties(projects.elements[0]);
  assertEquals(node(project.get("name"), "StringLiteral").value, "chromium");
  assert(!project.has("testDir"));
  for (const scope of [config, project]) {
    for (const filter of ["testMatch", "testIgnore", "grep", "grepInvert"]) {
      assert(
        !scope.has(filter),
        `config must not narrow discovery with ${filter}`,
      );
    }
  }
  assert(
    !workflow.includes(
      "playwright test tests/storybook.spec.ts",
    ),
  );
});
Deno.test("backend CI requires the auth browser lane and its evidence", async () => {
  const workflow = await read(".github/workflows/ci.yml");
  assert(workflow.includes("browser:\n"));
  assert(workflow.includes("run: pnpm test:browser --"));
  assert(workflow.includes("playwright install chromium"));
  assert(
    workflow.includes('LANE_BROWSER_TESTS: "${{ needs.browser.result }}"'),
  );
});

Deno.test("every required-checks policy names the exact workflow it targets", async () => {
  const policyDir = "scripts/ci";
  const policyFiles: string[] = [];
  for await (const entry of Deno.readDir(`${root}${policyDir}`)) {
    if (entry.isFile && /^required-checks.*\.json$/.test(entry.name)) {
      policyFiles.push(`${policyDir}/${entry.name}`);
    }
  }
  assert(
    policyFiles.length > 0,
    "expected at least one scripts/ci/required-checks*.json policy",
  );
  for (const policyFile of policyFiles) {
    const policy = JSON.parse(await read(policyFile));
    const workflow = await read(policy.workflowPath);
    const nameMatch = workflow.match(/^name:\s*(.+)$/m);
    assert(
      nameMatch,
      `${policy.workflowPath} must declare a top-level name:`,
    );
    assertEquals(
      policy.workflow,
      nameMatch![1].trim(),
      `${policyFile}: "workflow" must equal ${policy.workflowPath}'s name:`,
    );
  }
});

Deno.test("runner-label policy rail runs through the Node test package", async () => {
  await runPnpmScript("test:runner-label-policy");
});

Deno.test("UI architecture rails run in the lane that owns their execution", async () => {
  // ui:architecture:check and ui:architecture:test are the two heaviest rails
  // in the repository (around nine minutes together on a gate runner). The
  // `ui / tokens and architecture` lane executes both on every run this lane
  // runs in, so re-executing them here only bought a second copy of the same
  // nine minutes. This test keeps the invariant that matters — the rails are
  // declared and a CI lane runs them — and fails if either script or either
  // lane step disappears.
  const scripts = JSON.parse(await read("package.json")).scripts as
    | Record<string, string>
    | undefined;
  for (const command of ["ui:architecture:check", "ui:architecture:test"]) {
    assert(
      typeof scripts?.[command] === "string",
      `${command} must remain a workspace script`,
    );
  }
  const workflow = await read(".github/workflows/ci.yml");
  const start = workflow.indexOf("\n  ui_quality:\n");
  const end = workflow.indexOf("\n  ui_storybook_browser:\n", start);
  assert(start >= 0 && end > start, "ui_quality job block not found");
  const lane = workflow.slice(start, end);
  for (const command of ["ui:architecture:check", "ui:architecture:test"]) {
    assert(
      lane.includes(command),
      `the ui / tokens and architecture lane must run ${command}`,
    );
  }
});

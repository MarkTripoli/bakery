import { assert, assertEquals, assertThrows } from "@std/assert";
import { z } from "zod";
import {
  dependencyHealthSchema,
  healthResponseSchema,
  healthStateSchema,
} from "../../packages/contracts/src/health.ts";
import { readiness } from "../../packages/contracts/src/health-app.ts";
import { boundedShutdown } from "../../packages/contracts/src/shutdown.ts";
import {
  assertRuntimeConfig,
  readDatabaseConfig,
  readInngestEventConfig,
  readRuntimeConfig,
  readTestDatabaseConfig,
} from "../../packages/config/src/env.ts";
import { createInngestEventClient } from "../../apps/server/src/platform/inngest-event-client.ts";
import { readAuthTaskEnvironment } from "../../apps/server/src/platform/auth-task-config.ts";
import {
  closePgDatabase,
  openPgDatabase,
} from "../../apps/server/src/platform/database.ts";

Deno.test("production readiness names missing config without exposing values", async () => {
  const config = readRuntimeConfig({ BAKERY_ENV: "production" });
  const response = await readiness({
    service: "bakery-server",
    version: "test",
    config,
  });

  assertEquals(response.state, "unavailable");
  assertEquals(response.dependencies[0], {
    name: "configuration",
    state: "unavailable",
    reason: "CONFIGURATION_MISSING",
  });
  assert(!JSON.stringify(response).includes("postgres://"));
});

Deno.test("production requires the Inngest URL", () => {
  const config = readRuntimeConfig({
    BAKERY_ENV: "production",
    BAKERY_APP_DATABASE_URL: "postgres://bakery-app.example.test/bakery",
    BAKERY_PUBLIC_BASE_URL: "https://bakery.example.test",
    BETTER_AUTH_SECRET: "a".repeat(32),
  });
  assertEquals(config.missingConfig, ["INNGEST_URL"]);
});

Deno.test("server startup rejects invalid configuration by name", () => {
  const config = readRuntimeConfig({
    BAKERY_ENV: "production",
    BAKERY_APP_DATABASE_URL: "postgres://bakery-app.example.test/bakery",
    INNGEST_URL: "https://inngest.example.test",
    INNGEST_SIGNING_KEY: "a".repeat(32),
    INNGEST_EVENT_KEY: "production-event-key",
    BAKERY_PUBLIC_BASE_URL: "https://bakery.example.test",
    BETTER_AUTH_SECRET: "short",
  });
  assertThrows(
    () => assertRuntimeConfig(config),
    Error,
    "RUNTIME_CONFIGURATION_INVALID:BETTER_AUTH_SECRET",
  );
});

Deno.test("production server configuration includes the Inngest event key", () => {
  const config = readRuntimeConfig({
    BAKERY_ENV: "production",
    BAKERY_APP_DATABASE_URL: "postgres://bakery-app.example.test/bakery",
    INNGEST_URL: "https://inngest.example.test",
    INNGEST_SIGNING_KEY: "a".repeat(32),
    INNGEST_EVENT_KEY: "production-event-key",
    BAKERY_PUBLIC_BASE_URL: "https://bakery.example.test",
    BETTER_AUTH_SECRET: "a".repeat(32),
  });

  assertRuntimeConfig(config);
  assertEquals(config.inngest?.eventKey, "production-event-key");
  assertThrows(
    () =>
      readInngestEventConfig({
        BAKERY_ENV: "production",
        INNGEST_URL: "https://inngest.example.test",
      }),
    Error,
    "INNGEST_EVENT_KEY_REQUIRED",
  );
});

Deno.test("Inngest signing is required exactly when the runtime URL enables it", () => {
  const base = {
    BAKERY_ENV: "test",
    BAKERY_APP_DATABASE_URL: "postgres://bakery-app.example.test/bakery",
    BETTER_AUTH_SECRET: "a".repeat(32),
  };
  const disabled = readRuntimeConfig({
    ...base,
    INNGEST_SIGNING_KEY: "a".repeat(32),
  });
  assertEquals(disabled.missingConfig, []);
  assertEquals(disabled.inngest, undefined);

  const missingKey = readRuntimeConfig({
    ...base,
    INNGEST_URL: "http://127.0.0.1:8288",
    INNGEST_EVENT_KEY: "event-key",
  });
  assertEquals(missingKey.missingConfig, ["INNGEST_SIGNING_KEY"]);
  assertEquals(missingKey.inngest, undefined);

  const shortKey = readRuntimeConfig({
    ...base,
    INNGEST_URL: "http://127.0.0.1:8288",
    INNGEST_SIGNING_KEY: "short",
    INNGEST_EVENT_KEY: "event-key",
  });
  assertEquals(shortKey.missingConfig, []);
  assertEquals(shortKey.invalidConfig, ["INNGEST_SIGNING_KEY"]);
  assertEquals(shortKey.inngest, undefined);

  const enabled = readRuntimeConfig({
    ...base,
    INNGEST_URL: "http://127.0.0.1:8288",
    INNGEST_SIGNING_KEY: "a".repeat(32),
    INNGEST_EVENT_KEY: "event-key",
  });
  assertEquals(enabled.missingConfig, []);
  assertEquals(enabled.inngest?.signingKey, "a".repeat(32));
  assertEquals(enabled.inngest?.eventKey, "event-key");

  const invalidTimeout = readRuntimeConfig({
    ...base,
    INNGEST_URL: "http://127.0.0.1:8288",
    INNGEST_SIGNING_KEY: "a".repeat(32),
    INNGEST_EVENT_KEY: "event-key",
    INNGEST_JOB_COMPLETION_TIMEOUT: "not-a-duration",
  });
  assertEquals(invalidTimeout.invalidConfig, [
    "INNGEST_JOB_COMPLETION_TIMEOUT",
  ]);
  assertEquals(invalidTimeout.inngest, undefined);
  assertThrows(
    () => assertRuntimeConfig(invalidTimeout),
    Error,
    "RUNTIME_CONFIGURATION_INVALID:INNGEST_JOB_COMPLETION_TIMEOUT",
  );
});

Deno.test("Inngest event configuration keeps credentials on HTTPS or local development", () => {
  const base = {
    BAKERY_ENV: "development",
    INNGEST_EVENT_KEY: "local-event-key",
  };
  assertEquals(
    readInngestEventConfig({
      ...base,
      INNGEST_URL: "http://127.0.0.1:8288",
    }),
    { url: "http://127.0.0.1:8288", eventKey: "local-event-key" },
  );
  assertEquals(
    readInngestEventConfig({
      ...base,
      INNGEST_URL: "http://inngest:8288",
      BAKERY_INNGEST_LOCAL_COMPOSE: "1",
    }),
    { url: "http://inngest:8288", eventKey: "local-event-key" },
  );
  assertEquals(
    readInngestEventConfig({
      BAKERY_ENV: "production",
      INNGEST_URL: "https://inngest.example.test",
      INNGEST_EVENT_KEY: "production-event-key",
    }),
    {
      url: "https://inngest.example.test",
      eventKey: "production-event-key",
    },
  );
  for (const environment of ["development", "test", "production"]) {
    assertThrows(
      () =>
        readInngestEventConfig({
          BAKERY_ENV: environment,
          INNGEST_URL: "http://inngest.example.test",
          INNGEST_EVENT_KEY: "event-key",
        }),
      Error,
      "INNGEST_URL_INVALID",
    );
  }
  for (
    const url of [
      "http://127.0.0.1:8288?",
      "http://127.0.0.1:8288#",
      "http://127.0.0.1:8288?credential=leak",
      "http://127.0.0.1:8288#fragment",
    ]
  ) {
    assertThrows(
      () =>
        readInngestEventConfig({
          ...base,
          INNGEST_URL: url,
        }),
      Error,
      "INNGEST_URL_INVALID",
    );
  }
});

Deno.test("Inngest event client rejects remote HTTP before sending its event key", () => {
  assertThrows(
    () =>
      createInngestEventClient({
        baseUrl: "http://inngest.example.test",
        eventKey: "event-key",
      }),
    TypeError,
    "INNGEST_URL_INVALID",
  );
});

const privateSuffix = ".railway.internal";
const acceptedPrivateUrls = [
  "http://inngest.railway.internal:8288",
  "http://inngest.railway.internal",
  "http://inngest.railway.internal:8288/",
  "http://a.b.railway.internal:8288",
];
const rejectedPrivateUrls = [
  "http://inngest:8288",
  "http://evil.example.test",
  "http://railway.internal",
  "http://x.railway.internal.evil.test",
  "http://xrailway.internal",
  "http://user@inngest.railway.internal:8288",
  "http://user:pass@inngest.railway.internal:8288",
  "http://inngest.railway.internal:8288/path",
  "http://inngest.railway.internal:8288?q=1",
  "http://inngest.railway.internal:8288#frag",
  "http://inngest.railway.internal:8288?",
  "http://inngest.railway.internal.:8288",
  "http://[::1]:8288",
];

Deno.test("private host suffix lets production Inngest use plain HTTP only on matching hosts", () => {
  const production = {
    BAKERY_ENV: "production",
    INNGEST_EVENT_KEY: "production-event-key",
    BAKERY_INNGEST_PRIVATE_HOST_SUFFIX: privateSuffix,
  };
  for (const url of acceptedPrivateUrls) {
    assertEquals(
      readInngestEventConfig({ ...production, INNGEST_URL: url }),
      {
        url,
        eventKey: "production-event-key",
        privateHostSuffix: privateSuffix,
      },
      url,
    );
    createInngestEventClient({
      baseUrl: url,
      eventKey: "event-key",
      privateHostSuffix: privateSuffix,
    });
  }
  for (const url of rejectedPrivateUrls) {
    assertThrows(
      () => readInngestEventConfig({ ...production, INNGEST_URL: url }),
      Error,
      "INNGEST_URL_INVALID",
      url,
    );
    // The client has no environment: it already accepts the Compose host
    // and loopback, and URL parsing drops a bare trailing "?", all of which
    // the production config reader rejects before the client sees them.
    if (
      url === "http://inngest:8288" || url === "http://[::1]:8288" ||
      url.endsWith("?")
    ) continue;
    assertThrows(
      () =>
        createInngestEventClient({
          baseUrl: url,
          eventKey: "event-key",
          privateHostSuffix: privateSuffix,
        }),
      TypeError,
      "INNGEST_URL_INVALID",
      url,
    );
  }
  // HTTPS keeps working with the suffix set.
  assertEquals(
    readInngestEventConfig({
      ...production,
      INNGEST_URL: "https://inngest.example.test",
    }).url,
    "https://inngest.example.test",
  );
});

Deno.test("private host suffix applies in every environment and stays off by default", () => {
  for (const environment of ["development", "test", "production"]) {
    const url = "http://inngest.railway.internal:8288";
    assertEquals(
      readInngestEventConfig({
        BAKERY_ENV: environment,
        INNGEST_URL: url,
        INNGEST_EVENT_KEY: "event-key",
        BAKERY_INNGEST_PRIVATE_HOST_SUFFIX: privateSuffix,
      }).url,
      url,
    );
    assertThrows(
      () =>
        readInngestEventConfig({
          BAKERY_ENV: environment,
          INNGEST_URL: url,
          INNGEST_EVENT_KEY: "event-key",
        }),
      Error,
      "INNGEST_URL_INVALID",
    );
    assertThrows(
      () =>
        readInngestEventConfig({
          BAKERY_ENV: environment,
          INNGEST_URL: url,
          INNGEST_EVENT_KEY: "event-key",
          BAKERY_INNGEST_PRIVATE_HOST_SUFFIX: "",
        }),
      Error,
      "INNGEST_URL_INVALID",
    );
  }
  assertThrows(
    () =>
      createInngestEventClient({
        baseUrl: "http://inngest.railway.internal:8288",
        eventKey: "event-key",
      }),
    TypeError,
    "INNGEST_URL_INVALID",
  );
});

Deno.test("invalid private host suffix values are rejected as configuration errors", () => {
  const runtime = {
    BAKERY_ENV: "production",
    BAKERY_APP_DATABASE_URL: "postgres://bakery-app.example.test/bakery",
    BAKERY_PUBLIC_BASE_URL: "https://bakery.example.test",
    BETTER_AUTH_SECRET: "a".repeat(32),
    INNGEST_URL: "http://inngest.railway.internal:8288",
    INNGEST_SIGNING_KEY: "a".repeat(32),
    INNGEST_EVENT_KEY: "event-key",
  };
  const accepted = readRuntimeConfig({
    ...runtime,
    BAKERY_INNGEST_PRIVATE_HOST_SUFFIX: privateSuffix,
  }, "server");
  assertEquals(accepted.invalidConfig, []);
  assertEquals(accepted.inngest?.privateHostSuffix, privateSuffix);
  assertEquals(accepted.inngest?.baseUrl, runtime.INNGEST_URL);
  assertRuntimeConfig(accepted);

  const withoutSuffix = readRuntimeConfig(runtime, "server");
  assertEquals(withoutSuffix.invalidConfig, ["INNGEST_URL"]);
  assertEquals(withoutSuffix.inngest, undefined);

  for (
    const suffix of [
      ".com",
      ".internal",
      "railway.internal",
      ".RAILWAY.internal",
      ".railway.internal.",
      ".example.internal.",
      "..railway.internal",
      ".railway.internal/",
      " .railway.internal",
      ".rail_way.internal",
    ]
  ) {
    const config = readRuntimeConfig({
      ...runtime,
      BAKERY_INNGEST_PRIVATE_HOST_SUFFIX: suffix,
    }, "server");
    assert(
      config.invalidConfig.includes("BAKERY_INNGEST_PRIVATE_HOST_SUFFIX"),
      suffix,
    );
    assertEquals(config.inngest, undefined, suffix);
    assertThrows(
      () => assertRuntimeConfig(config),
      Error,
      "BAKERY_INNGEST_PRIVATE_HOST_SUFFIX",
    );
    assertThrows(
      () =>
        readInngestEventConfig({
          BAKERY_ENV: "production",
          INNGEST_URL: "https://inngest.example.test",
          INNGEST_EVENT_KEY: "event-key",
          BAKERY_INNGEST_PRIVATE_HOST_SUFFIX: suffix,
        }),
      Error,
      "INNGEST_URL_INVALID",
      suffix,
    );
    assertThrows(
      () =>
        createInngestEventClient({
          baseUrl: "https://inngest.example.test",
          eventKey: "event-key",
          privateHostSuffix: suffix,
        }),
      TypeError,
      "INNGEST_URL_INVALID",
      suffix,
    );
  }
});

Deno.test("createsuperuser carries the private host suffix to its Inngest check", () => {
  const environment = readAuthTaskEnvironment(
    {
      BAKERY_ENV: "production",
      BAKERY_INNGEST_PRIVATE_HOST_SUFFIX: privateSuffix,
      BAKERY_PUBLIC_BASE_URL: "https://bakery.example.test",
      BETTER_AUTH_SECRET: "a".repeat(32),
      INNGEST_URL: "http://inngest.railway.internal:8288",
      INNGEST_SIGNING_KEY: "a".repeat(32),
      INNGEST_EVENT_KEY: "event-key",
    },
    { url: "postgres://bakery-app.example.test/bakery" },
  );
  assertEquals(environment.BAKERY_INNGEST_PRIVATE_HOST_SUFFIX, privateSuffix);
  assertEquals(readRuntimeConfig(environment, "server").invalidConfig, []);
});

Deno.test("createsuperuser preserves the local Compose Inngest marker", () => {
  const environment = readAuthTaskEnvironment(
    {
      BAKERY_ENV: "development",
      BAKERY_INNGEST_LOCAL_COMPOSE: "1",
      BETTER_AUTH_SECRET: "a".repeat(32),
      INNGEST_URL: "http://inngest:8288",
    },
    { url: "postgres://bakery-app.example.test/bakery" },
  );

  assertEquals(environment.BAKERY_INNGEST_LOCAL_COMPOSE, "1");
  assertEquals(readRuntimeConfig(environment, "server").invalidConfig, []);
});

Deno.test("production readiness fails closed without injected dependency checks", async () => {
  const response = await readiness({
    service: "bakery-server",
    version: "test",
    config: {
      environment: "production",
      missingConfig: [],
      invalidConfig: [],
    },
  });

  assertEquals(response.state, "unavailable");
  assertEquals(response.dependencies, [{
    name: "runtime",
    state: "unavailable",
    reason: "DEPENDENCY_CHECKS_MISSING",
  }]);
});

Deno.test("production config validates URL schemes without retaining values", () => {
  const config = readRuntimeConfig({
    BAKERY_ENV: "production",
    BAKERY_APP_DATABASE_URL: "https://user:secret@example.test/db",
    INNGEST_URL: "file:///tmp/inngest",
  });
  assertEquals(config.invalidConfig, [
    "BAKERY_APP_DATABASE_URL",
    "INNGEST_URL",
  ]);
  assert(!JSON.stringify(config).includes("user:secret"));
});

Deno.test("runtime config preserves the public problem base URL", () => {
  const config = readRuntimeConfig({
    BAKERY_ENV: "test",
    BAKERY_PUBLIC_BASE_URL: "https://bakery.example.test",
  });
  assertEquals(config.publicBaseUrl, "https://bakery.example.test");
});

Deno.test("runtime config rejects malformed public problem base URLs", () => {
  for (
    const publicBaseUrl of [
      "not a URL",
      "https://user:pass@bakery.example.test",
      "https://bakery.example.test/path",
      "https://bakery.example.test?",
      "https://bakery.example.test#",
      "https://bakery.example.test?tenant=one",
      "https://bakery.example.test#fragment",
    ]
  ) {
    const config = readRuntimeConfig({
      BAKERY_ENV: "production",
      BAKERY_APP_DATABASE_URL: "postgres://bakery-app.example.test/bakery",
      INNGEST_URL: "https://inngest.example.test",
      INNGEST_SIGNING_KEY: "a".repeat(32),
      BAKERY_PUBLIC_BASE_URL: publicBaseUrl,
    });
    assertEquals(config.invalidConfig, ["BAKERY_PUBLIC_BASE_URL"]);
    assertEquals(config.publicBaseUrl, "http://localhost:8000", publicBaseUrl);
  }
});

Deno.test("default server auth origin follows the configured listener port", () => {
  const config = readRuntimeConfig({
    BAKERY_ENV: "development",
    BAKERY_SERVER_PORT: "8123",
    BAKERY_APP_DATABASE_URL: "postgres://bakery-app.example.test/bakery",
    BETTER_AUTH_SECRET: "a".repeat(32),
  });
  assertEquals(config.publicBaseUrl, "http://localhost:8123");
  assertEquals(config.auth?.publicOrigin, "http://localhost:8123");
  assertEquals(config.auth?.trustedOrigins, ["http://localhost:8123"]);
});

Deno.test("server auth config normalizes exact origins and paired GitHub credentials", () => {
  const config = readRuntimeConfig({
    BAKERY_ENV: "production",
    BAKERY_APP_DATABASE_URL: "postgres://bakery-app.example.test/bakery",
    INNGEST_URL: "https://inngest.example.test",
    INNGEST_SIGNING_KEY: "a".repeat(32),
    INNGEST_EVENT_KEY: "event-key",
    BETTER_AUTH_SECRET: "a".repeat(32),
    BAKERY_PUBLIC_BASE_URL: "https://bakery.example.test/",
    BETTER_AUTH_TRUSTED_ORIGINS:
      "https://bakery.example.test/, https://admin.example.test",
    GITHUB_CLIENT_ID: "client-id",
    GITHUB_CLIENT_SECRET: "client-secret",
  });

  assertEquals(config.missingConfig, []);
  assertEquals(config.invalidConfig, []);
  assertEquals(config.auth, {
    secret: "a".repeat(32),
    publicOrigin: "https://bakery.example.test",
    trustedOrigins: [
      "https://bakery.example.test",
      "https://admin.example.test",
    ],
    github: { clientId: "client-id", clientSecret: "client-secret" },
  });
});

Deno.test("server auth config permits plain HTTP only on loopback outside production", () => {
  const loopback = readRuntimeConfig({
    BAKERY_ENV: "test",
    BAKERY_APP_DATABASE_URL: "postgres://bakery-app.example.test/bakery",
    BETTER_AUTH_SECRET: "é".repeat(16),
    BAKERY_PUBLIC_BASE_URL: "http://127.0.0.1:8000",
  });
  assertEquals(loopback.missingConfig, []);
  assertEquals(loopback.invalidConfig, []);

  const remote = readRuntimeConfig({
    BAKERY_ENV: "development",
    BAKERY_APP_DATABASE_URL: "postgres://bakery-app.example.test/bakery",
    BETTER_AUTH_SECRET: "a".repeat(32),
    BAKERY_PUBLIC_BASE_URL: "http://bakery.example.test",
  });
  assertEquals(remote.invalidConfig, ["BAKERY_PUBLIC_BASE_URL"]);
});

Deno.test("the Better Auth pool is bounded without connecting", async () => {
  const pool = openPgDatabase("postgres://bakery.example.test/bakery");
  try {
    const options = (pool as unknown as {
      options: {
        max: number;
        idleTimeoutMillis: number;
        connectionTimeoutMillis: number;
        options: string;
      };
    }).options;
    assertEquals(options.max, 4);
    assertEquals(options.idleTimeoutMillis, 20_000);
    assertEquals(options.connectionTimeoutMillis, 5_000);
    assertEquals(options.options, "-c search_path=public");
  } finally {
    await closePgDatabase(pool);
  }
});

Deno.test("production config rejects authority-less PostgreSQL URLs", () => {
  for (
    const databaseUrl of [
      "postgres:",
      "postgres:garbage",
      "postgres://",
      "postgres:///",
    ]
  ) {
    const config = readRuntimeConfig({
      BAKERY_ENV: "production",
      DATABASE_URL: databaseUrl,
      INNGEST_URL: "http://127.0.0.1:8288",
    }, "worker");
    assertEquals(
      config.invalidConfig,
      ["DATABASE_URL", "INNGEST_URL"],
      databaseUrl,
    );
  }
});

Deno.test("database roles select the intended centralized URL", () => {
  const env = {
    DATABASE_URL: "postgres://owner.example.test/bakery",
    BAKERY_APP_DATABASE_URL: "postgres://app.example.test/bakery",
  };
  assertEquals(readDatabaseConfig(env), {
    url: env.BAKERY_APP_DATABASE_URL,
  });
  assertEquals(readDatabaseConfig(env, "owner"), { url: env.DATABASE_URL });
  assertThrows(
    () => readDatabaseConfig({ DATABASE_URL: env.DATABASE_URL }),
    Error,
    "BAKERY_APP_DATABASE_URL_REQUIRED",
  );
  assertThrows(
    () =>
      readDatabaseConfig({
        BAKERY_APP_DATABASE_URL: env.BAKERY_APP_DATABASE_URL,
      }, "owner"),
    Error,
    "DATABASE_URL_REQUIRED",
  );
});

Deno.test("database test config fails closed locally and keeps CI defaults", () => {
  assertThrows(
    () => readTestDatabaseConfig({}),
    Error,
    "DATABASE_URL_REQUIRED",
  );
  assertThrows(
    () =>
      readTestDatabaseConfig({
        DATABASE_URL: "postgres://bakery.example.test/bakery",
      }),
    Error,
    "BAKERY_APP_DATABASE_URL_REQUIRED",
  );
  assertThrows(
    () =>
      readTestDatabaseConfig({
        DATABASE_URL: "postgres://bakery.example.test/bakery",
        BAKERY_APP_DATABASE_URL: "postgres://bakery-app.example.test/bakery",
      }, { requireAdmin: true }),
    Error,
    "BAKERY_ADMIN_DATABASE_URL_REQUIRED",
  );
  assertEquals(
    readTestDatabaseConfig({ CI: "true" }, { requireAdmin: true }),
    {
      databaseUrl: "postgres://bakery:bakery-ci-bakery@127.0.0.1:5432/bakery",
      appDatabaseUrl:
        "postgres://bakery_app:bakery-ci-app@127.0.0.1:5432/bakery",
      adminDatabaseUrl:
        "postgres://postgres:bakery-ci-postgres@127.0.0.1:5432/bakery",
    },
  );
  assertEquals(
    readTestDatabaseConfig({
      CI: "true",
      DATABASE_URL: "postgres://owner.example.test/bakery",
      BAKERY_APP_DATABASE_URL: "postgres://app.example.test/bakery",
      BAKERY_ADMIN_DATABASE_URL: "postgres://admin.example.test/bakery",
    }, { requireAdmin: true }),
    {
      databaseUrl: "postgres://owner.example.test/bakery",
      appDatabaseUrl: "postgres://app.example.test/bakery",
      adminDatabaseUrl: "postgres://admin.example.test/bakery",
    },
  );
  assertThrows(
    () => readTestDatabaseConfig({ BAKERY_ENV: "production" }),
    Error,
    "TEST_DATABASE_CONFIG_FORBIDDEN_IN_PRODUCTION",
  );
  assertThrows(
    () => readTestDatabaseConfig({ NODE_ENV: "production" }),
    Error,
    "TEST_DATABASE_CONFIG_FORBIDDEN_IN_PRODUCTION",
  );
});

Deno.test("dependency checks are bounded and report a safe reason", async () => {
  let signal: AbortSignal | undefined;
  const response = await readiness({
    service: "bakery-worker",
    version: "test",
    config: { missingConfig: [] },
    dependencyTimeoutMs: 5,
    dependencies: [{
      name: "stuck",
      check: (candidate) => {
        signal = candidate;
        return new Promise<boolean>(() => {});
      },
    }],
  });

  assertEquals(response.state, "unavailable");
  assertEquals(response.dependencies[0]?.reason, "DEPENDENCY_UNAVAILABLE");
  assert(signal?.aborted);
});

Deno.test("completed dependency checks clear their timeout", async () => {
  let scheduled = 0;
  let cleared = 0;
  const handle = 1 as unknown as ReturnType<typeof setTimeout>;
  const response = await readiness({
    service: "bakery-server",
    version: "test",
    config: { missingConfig: [] },
    dependencies: [{ name: "database", check: () => true }],
    timers: {
      setTimeout: () => {
        scheduled += 1;
        return handle;
      },
      clearTimeout: () => cleared += 1,
    },
  });

  assertEquals(response.state, "ok");
  assertEquals(scheduled, 1);
  assertEquals(cleared, 1);
});

function assertSchemaDescriptions(
  value: unknown,
  path = "schema",
  seen = new Set<unknown>(),
): void {
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  const candidate = value as {
    description?: unknown;
    _zod?: { def?: unknown };
  };
  if (candidate._zod !== undefined) {
    assert(
      typeof candidate.description === "string" &&
        candidate.description.trim() !== "",
      `${path} is missing a description`,
    );
    assertSchemaDescriptions(candidate._zod.def, `${path}.def`, seen);
    if (value instanceof z.ZodLazy) {
      assertSchemaDescriptions(value.unwrap(), `${path}.lazy`, seen);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) =>
      assertSchemaDescriptions(child, `${path}[${index}]`, seen)
    );
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "checks") continue;
    assertSchemaDescriptions(child, `${path}.${key}`, seen);
  }
}

Deno.test("health contract recursively describes every authored schema", () => {
  for (
    const [name, schema] of Object.entries({
      healthStateSchema,
      dependencyHealthSchema,
      healthResponseSchema,
    })
  ) {
    assertSchemaDescriptions(schema, name);
  }
});

Deno.test("schema checker visits described custom catchalls", () => {
  const catchall = z.string().describe(
    "Fallback value schema used to verify recursive catchall traversal.",
  );
  const schema = z.object({}).catchall(catchall).describe(
    "Object fixture whose unknown keys must retain child schema metadata.",
  );
  assertSchemaDescriptions(schema, "custom");
});

Deno.test("schema checker rejects undescribed lazy and explicit never children", () => {
  const lazyInner = z.string().describe(
    "Lazily resolved value used to verify recursive child metadata enforcement.",
  );
  const lazyChild = z.lazy(() => lazyInner).describe(
    "Lazy wrapper whose resolved child metadata is removed for negative validation.",
  );
  const lazyParent = z.object({ child: lazyChild }).describe(
    "Parent object used to reject an undescribed lazily resolved child.",
  );
  const lazyMetadata = z.globalRegistry.get(lazyInner);
  z.globalRegistry.remove(lazyInner);
  let rejected = false;
  try {
    assertSchemaDescriptions(lazyParent, "lazy");
  } catch {
    rejected = true;
  }
  if (lazyMetadata) z.globalRegistry.add(lazyInner, lazyMetadata);
  assert(rejected);

  const neverChild = z.never().describe(
    "Impossible child fixture whose metadata is removed for recursive validation.",
  );
  const neverParent = z.object({}).catchall(neverChild).describe(
    "Catchall fixture used to reject an undescribed explicit never child.",
  );
  const metadata = z.globalRegistry.get(neverChild);
  z.globalRegistry.remove(neverChild);
  rejected = false;
  try {
    assertSchemaDescriptions(neverParent, "never");
  } catch {
    rejected = true;
  }
  if (metadata) z.globalRegistry.add(neverChild, metadata);
  assert(rejected);
});

Deno.test("schema checker rejects a missing child description", () => {
  const child = z.string().describe(
    "String field fixture whose metadata is removed to prove child checks fail.",
  );
  const parent = z.object({ child }).describe(
    "Object fixture expected to fail when its child description is absent.",
  );
  const metadata = z.globalRegistry.get(child);
  z.globalRegistry.remove(child);
  let rejected = false;
  try {
    assertSchemaDescriptions(parent, "invalid");
  } catch {
    rejected = true;
  }
  if (metadata) z.globalRegistry.add(child, metadata);
  assert(rejected);
});

Deno.test("bounded shutdown invokes the timeout hook", async () => {
  let timedOut = false;
  await boundedShutdown(
    () => new Promise<void>(() => {}),
    5,
    () => timedOut = true,
  );
  assert(timedOut);
});

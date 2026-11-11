import { assertEquals, assertThrows } from "@std/assert";
import {
  readSentryConfig,
  SentryConfigurationError,
} from "../../packages/config/src/sentry.ts";

const dsn = "https://publickey@o123.ingest.us.sentry.io/123";
const production = {
  BAKERY_SERVER_SENTRY_DSN: dsn,
  BAKERY_SENTRY_RELEASE: "bakery@0123456789abcdef",
};

Deno.test("Sentry stays off for ordinary development and unconfigured production", () => {
  assertEquals(readSentryConfig(production, "server", "development"), {
    enabled: false,
  });
  assertEquals(readSentryConfig({}, "server", "production"), {
    enabled: false,
  });
});

Deno.test("Sentry tests stay off even with a full production override", () => {
  assertEquals(
    readSentryConfig(
      {
        ...production,
        BAKERY_SENTRY_ENABLED: "true",
        BAKERY_SENTRY_ENVIRONMENT: "production",
      },
      "server",
      "test",
    ),
    { enabled: false },
  );
});

Deno.test("configured production carries its release and bounded default sampling", () => {
  assertEquals(readSentryConfig(production, "server", "production"), {
    enabled: true,
    dsn,
    environment: "production",
    release: "bakery@0123456789abcdef",
    tracesSampleRate: 0.1,
  });
});

Deno.test("staging and preview require explicit enable even in production builds", () => {
  for (const environment of ["staging", "preview"] as const) {
    const env = { ...production, BAKERY_SENTRY_ENVIRONMENT: environment };
    assertEquals(readSentryConfig(env, "server", "production"), {
      enabled: false,
    });
    const config = readSentryConfig(
      { ...env, BAKERY_SENTRY_ENABLED: "1" },
      "server",
      "development",
    );
    assertEquals(config.enabled && config.environment, environment);
  }
});

Deno.test("explicit false disables production without validating unused secrets", () => {
  assertEquals(
    readSentryConfig(
      {
        ...production,
        BAKERY_SENTRY_ENABLED: "false",
        BAKERY_SERVER_SENTRY_DSN: "invalid",
      },
      "server",
      "production",
    ),
    { enabled: false },
  );
});

Deno.test("web and worker never borrow another runtime's DSN", () => {
  assertEquals(readSentryConfig(production, "web", "production"), {
    enabled: false,
  });
  assertEquals(readSentryConfig(production, "worker", "production"), {
    enabled: false,
  });
  const web = readSentryConfig(
    { VITE_SENTRY_DSN: dsn, VITE_SENTRY_RELEASE: "bakery@0123456789abcdef" },
    "web",
    "production",
  );
  assertEquals(web.enabled && web.dsn, dsn);
});

Deno.test("invalid enabled config reports field names without leaking values", () => {
  for (
    const [field, value] of [
      ["BAKERY_SENTRY_ENABLED", "secret-invalid-flag"],
      ["BAKERY_SENTRY_ENVIRONMENT", "secret-environment"],
      ["BAKERY_SENTRY_RELEASE", "secret release\n"],
      ["BAKERY_SENTRY_TRACES_SAMPLE_RATE", "-1"],
      ["BAKERY_SENTRY_TRACES_SAMPLE_RATE", "1.1"],
      ["BAKERY_SENTRY_TRACES_SAMPLE_RATE", "Infinity"],
      ["BAKERY_SERVER_SENTRY_DSN", "https://key:secret@example.com/123"],
      ["BAKERY_SERVER_SENTRY_DSN", "https://key@example.com/123?secret=value"],
    ]
  ) {
    const error = assertThrows(
      () =>
        readSentryConfig(
          { ...production, BAKERY_SENTRY_ENABLED: "true", [field]: value },
          "server",
          "production",
        ),
      SentryConfigurationError,
    );
    assertEquals(error.message, `SENTRY_CONFIGURATION_INVALID:${field}`);
  }
});

Deno.test("explicit enable requires a project, deploy environment, and release", () => {
  for (
    const [env, field] of [
      [{ BAKERY_SENTRY_ENABLED: "true" }, "BAKERY_SERVER_SENTRY_DSN"],
      [
        { BAKERY_SENTRY_ENABLED: "true", BAKERY_SERVER_SENTRY_DSN: dsn },
        "BAKERY_SENTRY_ENVIRONMENT",
      ],
      [{
        BAKERY_SENTRY_ENABLED: "true",
        BAKERY_SERVER_SENTRY_DSN: dsn,
        BAKERY_SENTRY_ENVIRONMENT: "preview",
      }, "BAKERY_SENTRY_RELEASE"],
    ] as const
  ) {
    const error = assertThrows(
      () => readSentryConfig(env, "server", "development"),
      SentryConfigurationError,
    );
    assertEquals(error.field, field);
  }
});

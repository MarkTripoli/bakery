import { z } from "zod";

const services = ["web", "server", "worker"] as const;
export type SentryService = (typeof services)[number];

const applicationEnvironmentSchema = z.enum([
  "development",
  "test",
  "production",
])
  .describe("Application execution mode; tests never initialize telemetry.");
const environmentSchema = z.enum(["production", "staging", "preview"])
  .describe(
    "Deployment attributed to telemetry; ordinary development and tests are excluded.",
  );
const enabledSchema = z.enum(["true", "false", "1", "0"])
  .describe(
    "Explicit telemetry override; preview and staging require true or 1.",
  );
const dsnSchema = z.string().url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && url.username.length > 0 &&
    url.password === "" && url.search === "" && url.hash === "" &&
    /^\/\d+$/.test(url.pathname);
}).describe(
  "HTTPS project DSN with a public key and numeric project ID; no password, query, or fragment.",
);
const releaseSchema = z.string().regex(/^[A-Za-z0-9_.@+-]{1,200}$/)
  .describe(
    "Deploy-owned release identifier, normally bakery@ followed by the exact Git SHA.",
  );
const sampleRateSchema = z.coerce.number().min(0).max(1)
  .describe(
    "Fraction of traces sent, inclusive zero to one; defaults to 0.1 for enabled telemetry.",
  );

const enabledConfigSchema = z.object({
  enabled: z.literal(true).describe(
    "SDK initialization is permitted for this runtime.",
  ),
  dsn: dsnSchema,
  environment: environmentSchema,
  release: releaseSchema,
  tracesSampleRate: sampleRateSchema,
}).readonly().describe(
  "Validated runtime telemetry options; never contains an upload or authentication token.",
);

export type SentryConfig =
  | z.infer<typeof enabledConfigSchema>
  | { readonly enabled: false };

const commonEnvironmentNames = [
  "BAKERY_SENTRY_ENABLED",
  "BAKERY_SENTRY_ENVIRONMENT",
  "BAKERY_SENTRY_RELEASE",
  "BAKERY_SENTRY_TRACES_SAMPLE_RATE",
] as const;

export const SENTRY_SERVER_ENVIRONMENT_NAMES = [
  ...commonEnvironmentNames,
  "BAKERY_SERVER_SENTRY_DSN",
] as const;
export const SENTRY_WORKER_ENVIRONMENT_NAMES = [
  ...commonEnvironmentNames,
  "BAKERY_WORKER_SENTRY_DSN",
] as const;
export const SENTRY_WEB_ENVIRONMENT_NAMES = [
  "VITE_SENTRY_ENABLED",
  "VITE_SENTRY_ENVIRONMENT",
  "VITE_SENTRY_RELEASE",
  "VITE_SENTRY_TRACES_SAMPLE_RATE",
  "VITE_SENTRY_DSN",
] as const;

const environmentNames = {
  web: SENTRY_WEB_ENVIRONMENT_NAMES,
  server: SENTRY_SERVER_ENVIRONMENT_NAMES,
  worker: SENTRY_WORKER_ENVIRONMENT_NAMES,
} as const satisfies Record<SentryService, readonly string[]>;

export class SentryConfigurationError extends Error {
  override readonly name = "SentryConfigurationError";
  readonly field: string;

  constructor(field: string) {
    super(`SENTRY_CONFIGURATION_INVALID:${field}`);
    this.field = field;
  }
}

function parseField<T>(schema: z.ZodType<T>, value: unknown, field: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new SentryConfigurationError(field);
  return parsed.data;
}

export function readSentryConfig(
  env: Readonly<Record<string, string | undefined>>,
  service: SentryService,
  applicationEnvironment: string,
): SentryConfig {
  const mode = parseField(
    applicationEnvironmentSchema,
    applicationEnvironment,
    "applicationEnvironment",
  );
  if (mode === "test") return { enabled: false };
  const [enabledName, environmentName, releaseName, sampleRateName, dsnName] =
    environmentNames[service];
  const explicitEnabled = env[enabledName]?.trim();
  const environment = env[environmentName]?.trim() ||
    (mode === "production" ? "production" : undefined);
  const dsn = env[dsnName]?.trim();
  const enabled = explicitEnabled
    ? ["true", "1"].includes(
      parseField(enabledSchema, explicitEnabled, enabledName),
    )
    : mode === "production" && environment === "production" && Boolean(dsn);
  if (!enabled) return { enabled: false };

  return enabledConfigSchema.parse({
    enabled: true,
    dsn: parseField(dsnSchema, dsn, dsnName),
    environment: parseField(environmentSchema, environment, environmentName),
    release: parseField(releaseSchema, env[releaseName]?.trim(), releaseName),
    tracesSampleRate: parseField(
      sampleRateSchema,
      env[sampleRateName]?.trim() || "0.1",
      sampleRateName,
    ),
  });
}

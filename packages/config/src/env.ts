import { z } from "zod";
import { readSentryConfig, type SentryConfig } from "./sentry.ts";
import {
  readTrustedProxyCidrs,
  type TrustedProxies,
} from "./trusted-proxies.ts";

export {
  formatIpAddress,
  isTrustedProxyAddress,
  parseIpAddress,
  parseTrustedProxyCidrs,
  readTrustedProxyCidrs,
  TrustedProxyCidrsSchema,
} from "./trusted-proxies.ts";
export type {
  ParsedIpAddress,
  TrustedProxies,
  TrustedProxyRange,
} from "./trusted-proxies.ts";

export { readSentryConfig, SentryConfigurationError } from "./sentry.ts";
export type { SentryConfig, SentryService } from "./sentry.ts";

export type RuntimeEnvironment = "development" | "test" | "production";

/**
 * BCP 47 locales the server offers for selection. Production offers English
 * only; development and test add the pseudo-locales so evidence and tests can
 * pick them through the real language picker.
 */
export function availableLocalesFor(
  environment: RuntimeEnvironment,
): readonly string[] {
  return environment === "production" ? ["en"] : ["en", "en-XA", "ar-XB"];
}

export type ServerAuthConfig = {
  secret: string;
  publicOrigin: string;
  trustedOrigins: readonly string[];
  github?: { clientId: string; clientSecret: string };
};

export const INNGEST_MAX_BODY_BYTES = 512 * 1024;
export const INNGEST_WAIT_MS = 1_000;
export const INNGEST_JOB_COMPLETION_TIMEOUT = "5m";
export const INNGEST_ENGINE_RETRIES = 3;
export const INNGEST_MAX_ATTEMPTS = 3;

export const REPOSITORY_EXECUTION_CUTOVER_BATCH_SIZE = 100;
const MAX_INNGEST_WAIT_MILLISECONDS = 24 * 60 * 60 * 1_000;

function readInngestDuration(value: string): number {
  const match = /^(?<amount>\d+)(?<unit>ms|s|m|h)$/.exec(value.trim());
  if (!match?.groups) throw new Error("INNGEST_JOB_COMPLETION_TIMEOUT_INVALID");
  const amount = Number(match.groups.amount);
  const multiplier = match.groups.unit === "ms"
    ? 1
    : match.groups.unit === "s"
    ? 1_000
    : match.groups.unit === "m"
    ? 60_000
    : 3_600_000;
  const milliseconds = amount * multiplier;
  if (
    !Number.isSafeInteger(milliseconds) || milliseconds < 1 ||
    milliseconds > MAX_INNGEST_WAIT_MILLISECONDS
  ) {
    throw new Error("INNGEST_JOB_COMPLETION_TIMEOUT_INVALID");
  }
  return milliseconds;
}

export const InngestPrivateHostSuffixSchema = z.string().max(253).regex(
  /^(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+\.internal$/,
  "Private host suffix must be lowercase, start with a dot, carry at least two labels and end in .internal.",
).describe(
  "Opt-in private-network DNS suffix such as .railway.internal; the only way plain-HTTP Inngest URLs are accepted in production, and only for hosts with at least one label before it.",
);
export type InngestPrivateHostSuffix = z.infer<
  typeof InngestPrivateHostSuffixSchema
>;

/**
 * Returns the validated private host suffix, or undefined when unset or blank.
 * Throws INNGEST_PRIVATE_HOST_SUFFIX_INVALID for a set but malformed value.
 */
export function readInngestPrivateHostSuffix(
  env: Record<string, string | undefined>,
): InngestPrivateHostSuffix | undefined {
  const raw = env.BAKERY_INNGEST_PRIVATE_HOST_SUFFIX;
  if (raw === undefined || raw === "") return undefined;
  const parsed = InngestPrivateHostSuffixSchema.safeParse(raw);
  if (!parsed.success) throw new Error("INNGEST_PRIVATE_HOST_SUFFIX_INVALID");
  return parsed.data;
}

function readValidInngestPrivateHostSuffix(
  env: Record<string, string | undefined>,
): InngestPrivateHostSuffix | undefined {
  try {
    return readInngestPrivateHostSuffix(env);
  } catch {
    throw new Error("INNGEST_URL_INVALID");
  }
}

/**
 * True when the URL is plain HTTP, has no userinfo, query or fragment, uses the
 * root path, and its hostname is one or more DNS labels followed by the suffix.
 */
export function isInngestPrivateHostUrl(
  url: URL,
  suffix: InngestPrivateHostSuffix,
): boolean {
  if (url.protocol !== "http:") return false;
  if (
    url.username !== "" || url.password !== "" || url.search !== "" ||
    url.hash !== "" || url.pathname !== "/"
  ) return false;
  if (!url.hostname.endsWith(suffix)) return false;
  const prefix = url.hostname.slice(0, url.hostname.length - suffix.length);
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/
    .test(prefix);
}

export type InngestRuntimeConfig = {
  signingKey: string;
  eventKey: string;
  baseUrl: string;
  privateHostSuffix?: InngestPrivateHostSuffix;
  serveOrigin: string;
  maxBodyBytes: number;
  waitMs: number;
  jobCompletionTimeout: string;
  engineRetries: number;
  maxAttempts: number;
};

export const SecretsKeyConfigSchema = z.object({
  file: z.string().min(1).max(4096).regex(/^\//).refine(
    (value) =>
      Array.from(value).every((character) =>
        character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127
      ),
    "Invalid mounted key reference.",
  ).describe(
    "Absolute server-only mounted file containing exactly 32 raw AES key bytes; never action input.",
  ),
  keyId: z.string().min(1).max(100).regex(/^[A-Za-z0-9._-]+$/).describe(
    "Immutable external key identifier included in each encrypted version AAD.",
  ),
}).strict().describe(
  "Server-only encryption reference pair; absence disables credential writes without a key fallback.",
);
export type SecretsKeyConfig = z.infer<typeof SecretsKeyConfigSchema>;

/**
 * Secrets key reference alone, for operator tooling that decrypts installation
 * secrets without booting the server config. Undefined when neither variable
 * is set; throws a content-free error when the pair is partial or malformed.
 */
export function readSecretsKeyConfig(
  env: Record<string, string | undefined>,
): SecretsKeyConfig | undefined {
  if (
    env.BAKERY_SECRETS_KEY_FILE === undefined &&
    env.BAKERY_SECRETS_KEY_ID === undefined
  ) return undefined;
  const parsed = SecretsKeyConfigSchema.safeParse({
    file: env.BAKERY_SECRETS_KEY_FILE,
    keyId: env.BAKERY_SECRETS_KEY_ID,
  });
  if (!parsed.success) throw new Error("SECRETS_KEY_CONFIG_INVALID");
  return parsed.data;
}

export const SecretIdentityProviderFixtureConfigSchema = z.object({
  file: z.string().min(1).max(4096).regex(/^\//).describe(
    "Absolute server-only file containing the controlled GitHub identity response for local full-stack proof.",
  ),
}).strict().describe(
  "Development-only controlled provider fixture; production configuration always rejects it.",
);
export type SecretIdentityProviderFixtureConfig = z.infer<
  typeof SecretIdentityProviderFixtureConfigSchema
>;

export const SkillFileRootConfigSchema = z.object({
  root: z.string().min(1).max(4096).regex(/^\//).refine(
    (value) =>
      Array.from(value).every((character) =>
        character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127
      ),
    "Invalid private skill-file root path.",
  ).describe(
    "Absolute Linux path to the server-owned private skill object root; upload paths never select names beneath it.",
  ),
}).strict().describe(
  "Server-only private filesystem location for immutable skill objects; absence disables local publication storage.",
);
export type SkillFileRootConfig = z.infer<typeof SkillFileRootConfigSchema>;

type SkillFileRootStat = {
  isDirectory: boolean;
  isSymlink: boolean;
  mode: number | null;
  uid: number | null;
};

export function readSkillFileRootConfig(
  value: string | undefined,
  options: {
    platform?: string;
    uid?: number | null;
    lstat?: (path: string) => SkillFileRootStat;
  } = {},
): SkillFileRootConfig | undefined {
  if (value === undefined || value === "") return undefined;
  if ((options.platform ?? Deno.build.os) !== "linux") {
    throw new Error("SKILL_FILE_STORE_UNSUPPORTED");
  }
  const parsed = SkillFileRootConfigSchema.safeParse({ root: value });
  if (!parsed.success) throw new Error("SKILL_FILE_ROOT_INVALID");
  const lstat = options.lstat ?? ((path: string) => Deno.lstatSync(path));
  let stat: SkillFileRootStat;
  try {
    stat = lstat(parsed.data.root);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return parsed.data;
    throw error;
  }
  const uid = options.uid === undefined ? Deno.uid() : options.uid;
  if (
    stat.isSymlink || !stat.isDirectory || stat.uid === null || uid === null ||
    stat.uid !== uid || stat.mode === null || (stat.mode & 0o777) !== 0o700
  ) {
    throw new Error("SKILL_FILE_ROOT_UNSAFE");
  }
  return parsed.data;
}

export type BudgetRuntimeConfig = {
  installationMonthlyLimitUsd: string;
  reservationTtlSeconds: number;
  maxRunDurationSeconds: number;
};

export type RuntimeConfig = {
  sentry?: SentryConfig;
  environment: RuntimeEnvironment;
  host: string;
  port: number;
  publicBaseUrl: string;
  version: string;
  requiredConfig: readonly string[];
  missingConfig: readonly string[];
  invalidConfig: readonly string[];
  budget?: BudgetRuntimeConfig;
  secretsKey?: SecretsKeyConfig;
  secretIdentityProviderFixture?: SecretIdentityProviderFixtureConfig;
  skillFileRoot?: SkillFileRootConfig;
  auth?: ServerAuthConfig;
  /**
   * Separate origin that serves artifact previews (`BAKERY_ARTIFACT_PREVIEW_ORIGIN`).
   * A public origin, not a credential. Absent means previews fail closed.
   */
  artifactPreviewOrigin?: string;
  inngest?: InngestRuntimeConfig;
  /** Reverse proxies whose X-Forwarded-For the server trusts; server only. */
  trustedProxies?: TrustedProxies;
  /**
   * Isolated draft workers at once (`BAKERY_DRAFT_WORKER_POOL_SIZE`); server
   * only. Absent means the built-in default pool.
   */
  draftWorkerPoolSize?: number;
  /**
   * How draft isolation workers start (`BAKERY_DRAFT_ISOLATION`); server
   * only. Read here with the rest of the configuration, so the app never
   * reads the environment itself (#306).
   */
  draftIsolationLauncher?: DraftIsolationLauncher;
};

const BUDGET_INSTALLATION_LIMIT =
  "BAKERY_BUDGET_INSTALLATION_MONTHLY_LIMIT_USD";
const BUDGET_RESERVATION_TTL = "BAKERY_BUDGET_RESERVATION_TTL_SECONDS";
const BUDGET_RUN_DURATION = "BAKERY_BUDGET_MAX_RUN_DURATION_SECONDS";
const BUDGET_USD = /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/;

export function readBudgetRuntimeConfig(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): BudgetRuntimeConfig | undefined {
  const rawLimit = env[BUDGET_INSTALLATION_LIMIT]?.trim();
  const rawTtl = env[BUDGET_RESERVATION_TTL]?.trim();
  const rawDuration = env[BUDGET_RUN_DURATION]?.trim();
  if (
    rawLimit === undefined && rawTtl === undefined && rawDuration === undefined
  ) {
    return undefined;
  }
  if (
    !rawLimit || !rawTtl || !rawDuration || !BUDGET_USD.test(rawLimit)
  ) {
    throw new Error("BUDGET_POLICY_INVALID");
  }
  const reservationTtlSeconds = Number(rawTtl);
  const maxRunDurationSeconds = Number(rawDuration);
  if (
    !Number.isSafeInteger(reservationTtlSeconds) ||
    reservationTtlSeconds < 1 ||
    !Number.isSafeInteger(maxRunDurationSeconds) ||
    maxRunDurationSeconds < 1
  ) {
    throw new Error("BUDGET_POLICY_INVALID");
  }
  return {
    installationMonthlyLimitUsd: rawLimit,
    reservationTtlSeconds,
    maxRunDurationSeconds,
  };
}

const runtimeEnvironments = new Set<RuntimeEnvironment>([
  "development",
  "test",
  "production",
]);

function readPort(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT_INVALID");
  }
  return port;
}

function readRequiredText(
  value: string | undefined,
  errorCode: string,
  fallback: string,
): string {
  const result = value ?? fallback;
  if (result.trim() === "") throw new Error(errorCode);
  return result;
}

function hasValidUrl(
  value: string | undefined,
  protocols: readonly string[],
): boolean {
  if (!value?.trim()) return false;
  try {
    const url = new URL(value);
    return protocols.includes(url.protocol) && url.hostname.trim() !== "";
  } catch {
    return false;
  }
}

function invalidInngestPrivateHostSuffix(
  env: Record<string, string | undefined>,
): boolean {
  try {
    readInngestPrivateHostSuffix(env);
    return false;
  } catch {
    return true;
  }
}

function invalidTrustedProxyCidrs(
  env: Record<string, string | undefined>,
): boolean {
  try {
    readTrustedProxyCidrs(env);
    return false;
  } catch {
    return true;
  }
}

function isSafeInngestUrl(
  value: string,
  environment: RuntimeEnvironment,
  env: Record<string, string | undefined>,
): boolean {
  const trimmed = value.trim();
  if (/[?#]$/.test(trimmed)) return false;
  if (!hasValidUrl(trimmed, ["http:", "https:"])) return false;
  const url = new URL(trimmed);
  if (
    url.username !== "" || url.password !== "" || url.search !== "" ||
    url.hash !== ""
  ) return false;
  if (url.protocol === "https:") return true;
  let privateSuffix: InngestPrivateHostSuffix | undefined;
  try {
    privateSuffix = readInngestPrivateHostSuffix(env);
  } catch {
    return false;
  }
  if (privateSuffix && isInngestPrivateHostUrl(url, privateSuffix)) return true;
  if (environment === "production") return false;
  const loopback = url.hostname === "localhost" || url.hostname === "[::1]" ||
    /^127(?:\.[0-9]{1,3}){3}$/.test(url.hostname);
  const localCompose = env.BAKERY_INNGEST_LOCAL_COMPOSE === "1" &&
    (environment === "development" || environment === "test") &&
    url.hostname === "inngest" &&
    (url.port === "" || url.port === "8288") && url.pathname === "/";
  return loopback || localCompose;
}

export type DatabaseConfig = { url: string };
export type InngestEventConfig = {
  url: string;
  eventKey: string;
  privateHostSuffix?: InngestPrivateHostSuffix;
};
export type DatabaseRole = "application" | "owner";
export type TestDatabaseResetOptions = {
  confirmation?: string;
  allowRemote?: boolean;
};
export type TestDatabaseConfig = {
  databaseUrl: string;
  appDatabaseUrl: string;
};
export type AdminTestDatabaseConfig = TestDatabaseConfig & {
  adminDatabaseUrl: string;
};

type EnvironmentSource = {
  get(name: string): string | undefined;
};

export function readEnvironmentSnapshot(
  names: readonly string[],
  source: EnvironmentSource = Deno.env,
): Record<string, string | undefined> {
  const snapshot: Record<string, string | undefined> = {};
  for (const name of names) snapshot[name] = source.get(name);
  return snapshot;
}

export function readDatabaseConfig(
  env: Record<string, string | undefined> = Deno.env.toObject(),
  role: DatabaseRole = "application",
): DatabaseConfig {
  const name = role === "owner" ? "DATABASE_URL" : "BAKERY_APP_DATABASE_URL";
  const url = env[name]?.trim();
  if (!url) throw new Error(`${name}_REQUIRED`);
  if (!hasValidUrl(url, ["postgres:", "postgresql:"])) {
    throw new Error("DATABASE_URL_INVALID");
  }
  return { url };
}

export function readInngestEventConfig(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): InngestEventConfig {
  const url = env.INNGEST_URL?.trim();
  if (!url) throw new Error("INNGEST_URL_REQUIRED");
  const environment: RuntimeEnvironment = env.BAKERY_ENV === "development"
    ? "development"
    : env.BAKERY_ENV === "test"
    ? "test"
    : "production";
  if (!isSafeInngestUrl(url, environment, env)) {
    throw new Error("INNGEST_URL_INVALID");
  }
  const eventKey = env.INNGEST_EVENT_KEY?.trim();
  if (!eventKey) throw new Error("INNGEST_EVENT_KEY_REQUIRED");
  const privateHostSuffix = readValidInngestPrivateHostSuffix(env);
  return privateHostSuffix
    ? { url, eventKey, privateHostSuffix }
    : { url, eventKey };
}

export function readTestDatabaseConfig(
  env: Record<string, string | undefined>,
  options: { requireAdmin: true },
): AdminTestDatabaseConfig;
export function readTestDatabaseConfig(
  env?: Record<string, string | undefined>,
  options?: { requireAdmin?: false },
): TestDatabaseConfig;
export function readTestDatabaseConfig(
  env: Record<string, string | undefined> = Deno.env.toObject(),
  options: { requireAdmin?: boolean } = {},
): TestDatabaseConfig | AdminTestDatabaseConfig {
  if (env.BAKERY_ENV === "production" || env.NODE_ENV === "production") {
    throw new Error("TEST_DATABASE_CONFIG_FORBIDDEN_IN_PRODUCTION");
  }
  const defaults = env.CI === "true"
    ? {
      databaseUrl: "postgres://bakery:bakery-ci-bakery@127.0.0.1:5432/bakery",
      appDatabaseUrl:
        "postgres://bakery_app:bakery-ci-app@127.0.0.1:5432/bakery",
      adminDatabaseUrl:
        "postgres://postgres:bakery-ci-postgres@127.0.0.1:5432/bakery",
    }
    : undefined;
  const readUrl = (name: string, fallback?: string): string => {
    const value = env[name]?.trim() || fallback;
    if (!value) throw new Error(`${name}_REQUIRED`);
    if (!hasValidUrl(value, ["postgres:", "postgresql:"])) {
      throw new Error(`${name}_INVALID`);
    }
    return value;
  };
  const result: TestDatabaseConfig = {
    databaseUrl: readUrl("DATABASE_URL", defaults?.databaseUrl),
    appDatabaseUrl: readUrl(
      "BAKERY_APP_DATABASE_URL",
      defaults?.appDatabaseUrl,
    ),
  };
  return options.requireAdmin
    ? {
      ...result,
      adminDatabaseUrl: readUrl(
        "BAKERY_ADMIN_DATABASE_URL",
        defaults?.adminDatabaseUrl,
      ),
    }
    : result;
}

export function readInngestRuntimeConfig(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): InngestRuntimeConfig {
  const signingKey = env.INNGEST_SIGNING_KEY?.trim();
  if (!signingKey) throw new Error("INNGEST_SIGNING_KEY_REQUIRED");
  const eventKey = env.INNGEST_EVENT_KEY?.trim();
  if (!eventKey) throw new Error("INNGEST_EVENT_KEY_REQUIRED");
  const environment: RuntimeEnvironment = env.BAKERY_ENV === "production"
    ? "production"
    : env.BAKERY_ENV === "test"
    ? "test"
    : "development";
  const baseUrl = env.INNGEST_URL?.trim() || "http://127.0.0.1:8288";
  if (!isSafeInngestUrl(baseUrl, environment, env)) {
    throw new Error("INNGEST_URL_INVALID");
  }
  const privateHostSuffix = readValidInngestPrivateHostSuffix(env);
  const serveOrigin = normalizeOrigin(env.BAKERY_CONTAINER_BASE_URL) ??
    normalizeOrigin(env.BAKERY_PUBLIC_BASE_URL) ??
    "http://127.0.0.1:8000";
  const jobCompletionTimeout = env.INNGEST_JOB_COMPLETION_TIMEOUT?.trim() ||
    INNGEST_JOB_COMPLETION_TIMEOUT;
  readInngestDuration(jobCompletionTimeout);
  return {
    signingKey,
    eventKey,
    baseUrl,
    ...(privateHostSuffix ? { privateHostSuffix } : {}),
    serveOrigin,
    maxBodyBytes: INNGEST_MAX_BODY_BYTES,
    waitMs: INNGEST_WAIT_MS,
    jobCompletionTimeout,
    engineRetries: INNGEST_ENGINE_RETRIES,
    maxAttempts: INNGEST_MAX_ATTEMPTS,
  };
}

export function readTestDatabaseResetOptions(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): TestDatabaseResetOptions {
  const confirmation = env.BAKERY_TEST_DATABASE_RESET_CONFIRMATION?.trim();
  return {
    confirmation,
    allowRemote: env.BAKERY_TEST_DATABASE_ALLOW_REMOTE_RESET === "1",
  };
}

function normalizeOrigin(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.hostname.trim() === "" || url.username !== "" ||
      url.password !== "" || url.href !== `${url.origin}/`
    ) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" ||
    /^127(?:\.[0-9]{1,3}){3}$/.test(hostname);
}

/**
 * Browsers refuse WebAuthn on IP hosts, so a production deployment whose
 * public origin is an IP literal (bracketed IPv6 or dotted IPv4) could never
 * complete a passkey ceremony.
 */
function isIpLiteral(hostname: string): boolean {
  return hostname.startsWith("[") ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);
}

function hasSafeAuthProtocol(
  origin: string,
  environment: RuntimeEnvironment,
): boolean {
  const url = new URL(origin);
  return url.protocol === "https:" ||
    (environment !== "production" && url.protocol === "http:" &&
      isLoopback(url.hostname));
}

/**
 * Validates the artifact preview origin. It must be a plain origin that is safe
 * for its environment and must share no host with the application: a cookie
 * jar ignores ports, so an equal host would let preview content reach Bakery
 * cookies. It also must not be a trusted origin (CORS and origin guard).
 * Returns the normalized origin, or undefined when it is unusable.
 */
export function readArtifactPreviewOrigin(
  value: string,
  environment: RuntimeEnvironment,
  publicOrigin: string,
  trustedOrigins: readonly string[],
): string | undefined {
  const origin = normalizeOrigin(value);
  if (
    origin === undefined || !hasSafeAuthProtocol(origin, environment) ||
    origin.includes("*")
  ) return undefined;
  // Compare hostnames the way the preview dispatch does (lower-cased, no
  // trailing dot), so a dotted spelling of an app host cannot pass here and
  // then capture that host's requests.
  const comparable = (url: string) =>
    new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  const hostname = comparable(origin);
  const shared = [publicOrigin, ...trustedOrigins].some((candidate) => {
    try {
      return candidate === origin || comparable(candidate) === hostname;
    } catch {
      return false;
    }
  });
  return shared ? undefined : origin;
}

export function readRuntimeConfig(
  env: Record<string, string | undefined> = Deno.env.toObject(),
  kind: "server" | "worker" = "server",
): RuntimeConfig {
  const environmentValue = env.BAKERY_ENV ?? "development";
  if (!runtimeEnvironments.has(environmentValue as RuntimeEnvironment)) {
    throw new Error("ENVIRONMENT_INVALID");
  }
  const environment = environmentValue as RuntimeEnvironment;
  const host = readRequiredText(
    env[kind === "server" ? "BAKERY_SERVER_HOST" : "BAKERY_WORKER_HOST"],
    "HOST_INVALID",
    "127.0.0.1",
  );
  const port = readPort(
    env[kind === "server" ? "BAKERY_SERVER_PORT" : "BAKERY_WORKER_PORT"],
    kind === "server" ? 8000 : 8001,
  );
  const databaseEnvironmentName = kind === "server"
    ? "BAKERY_APP_DATABASE_URL"
    : "DATABASE_URL";
  const inngestUrl = env.INNGEST_URL?.trim();
  const inngestSigningKey = env.INNGEST_SIGNING_KEY?.trim();
  const inngestEventKey = env.INNGEST_EVENT_KEY?.trim();
  const inngestJobCompletionTimeout =
    env.INNGEST_JOB_COMPLETION_TIMEOUT?.trim() ||
    INNGEST_JOB_COMPLETION_TIMEOUT;
  const requiredConfig = environment === "production"
    ? [
      databaseEnvironmentName,
      ...(kind === "server"
        ? [
          "BETTER_AUTH_SECRET",
          "BAKERY_PUBLIC_BASE_URL",
          "INNGEST_URL",
        ]
        : []),
    ]
    : kind === "server"
    ? ["BAKERY_APP_DATABASE_URL", "BETTER_AUTH_SECRET"]
    : [];
  const missingConfig = requiredConfig.filter((name) => !env[name]?.trim());
  const invalidConfig = [
    ...(env[databaseEnvironmentName]?.trim() &&
        !hasValidUrl(env[databaseEnvironmentName], [
          "postgres:",
          "postgresql:",
        ])
      ? [databaseEnvironmentName]
      : []),
    ...(inngestUrl && !isSafeInngestUrl(inngestUrl, environment, env)
      ? ["INNGEST_URL"]
      : []),
    ...(kind === "server" && invalidInngestPrivateHostSuffix(env)
      ? ["BAKERY_INNGEST_PRIVATE_HOST_SUFFIX"]
      : []),
    ...(kind === "server" && invalidTrustedProxyCidrs(env)
      ? ["BAKERY_TRUSTED_PROXY_CIDRS"]
      : []),
  ];
  const budgetNames = [
    BUDGET_INSTALLATION_LIMIT,
    BUDGET_RESERVATION_TTL,
    BUDGET_RUN_DURATION,
  ];
  const budgetConfigured = budgetNames.some((name) => env[name]?.trim());
  let budget: BudgetRuntimeConfig | undefined;
  if (budgetConfigured) {
    const missingBudget = budgetNames.filter((name) => !env[name]?.trim());
    missingConfig.push(...missingBudget);
    if (missingBudget.length === 0) {
      try {
        budget = readBudgetRuntimeConfig(env);
      } catch {
        invalidConfig.push(...budgetNames);
      }
    }
  }
  if (kind === "server" && inngestUrl) {
    if (!inngestSigningKey) {
      missingConfig.push("INNGEST_SIGNING_KEY");
    } else if (inngestSigningKey.length < 16) {
      invalidConfig.push("INNGEST_SIGNING_KEY");
    }
    if (!inngestEventKey) missingConfig.push("INNGEST_EVENT_KEY");
    try {
      readInngestDuration(inngestJobCompletionTimeout);
    } catch {
      invalidConfig.push("INNGEST_JOB_COMPLETION_TIMEOUT");
    }
  }
  const configuredPublicBaseUrl = env.BAKERY_PUBLIC_BASE_URL?.trim();
  const defaultPublicBaseUrl = `http://localhost:${port}`;
  const configuredPublicOrigin = normalizeOrigin(configuredPublicBaseUrl);
  if (configuredPublicBaseUrl && !configuredPublicOrigin) {
    invalidConfig.push("BAKERY_PUBLIC_BASE_URL");
  }
  const publicOrigin = configuredPublicOrigin ?? defaultPublicBaseUrl;
  if (
    kind === "server" && configuredPublicOrigin &&
    (!hasSafeAuthProtocol(configuredPublicOrigin, environment) ||
      (environment === "production" &&
        (configuredPublicOrigin.includes("*") ||
          isIpLiteral(new URL(configuredPublicOrigin).hostname))))
  ) invalidConfig.push("BAKERY_PUBLIC_BASE_URL");

  const configuredTrustedOrigins = env.BETTER_AUTH_TRUSTED_ORIGINS;
  const trustedOriginValues = configuredTrustedOrigins === undefined
    ? [publicOrigin]
    : configuredTrustedOrigins.split(",").map((value) => value.trim());
  const normalizedTrustedOrigins = trustedOriginValues.map(normalizeOrigin);
  const trustedOriginsAreValid = configuredTrustedOrigins === undefined ||
    normalizedTrustedOrigins.every((origin) =>
      origin !== undefined && hasSafeAuthProtocol(origin, environment) &&
      !(environment === "production" && origin.includes("*"))
    );
  if (kind === "server" && !trustedOriginsAreValid) {
    invalidConfig.push("BETTER_AUTH_TRUSTED_ORIGINS");
  }
  const trustedOrigins = trustedOriginsAreValid
    ? [...new Set(normalizedTrustedOrigins as string[])]
    : [publicOrigin];

  let artifactPreviewOrigin: string | undefined;
  const configuredPreviewOrigin = env.BAKERY_ARTIFACT_PREVIEW_ORIGIN?.trim();
  if (kind === "server" && configuredPreviewOrigin) {
    artifactPreviewOrigin = readArtifactPreviewOrigin(
      configuredPreviewOrigin,
      environment,
      publicOrigin,
      trustedOrigins,
    );
    if (artifactPreviewOrigin === undefined) {
      invalidConfig.push("BAKERY_ARTIFACT_PREVIEW_ORIGIN");
    }
  }

  const secret = env.BETTER_AUTH_SECRET ?? "";
  if (
    kind === "server" && secret.trim() !== "" &&
    new TextEncoder().encode(secret).byteLength < 32
  ) invalidConfig.push("BETTER_AUTH_SECRET");

  const githubClientId = env.GITHUB_CLIENT_ID?.trim();
  const githubClientSecret = env.GITHUB_CLIENT_SECRET?.trim();
  if (
    kind === "server" && Boolean(githubClientId) !== Boolean(githubClientSecret)
  ) {
    invalidConfig.push(
      githubClientId ? "GITHUB_CLIENT_SECRET" : "GITHUB_CLIENT_ID",
    );
  }

  const configuredSecretsKey = kind === "server" &&
      (env.BAKERY_SECRETS_KEY_FILE !== undefined ||
        env.BAKERY_SECRETS_KEY_ID !== undefined)
    ? SecretsKeyConfigSchema.safeParse({
      file: env.BAKERY_SECRETS_KEY_FILE,
      keyId: env.BAKERY_SECRETS_KEY_ID,
    })
    : undefined;
  if (configuredSecretsKey && !configuredSecretsKey.success) {
    invalidConfig.push("BAKERY_SECRETS_KEY_FILE", "BAKERY_SECRETS_KEY_ID");
  }
  const configuredProviderFixture = kind === "server" &&
      Boolean(env.BAKERY_SECRET_IDENTITY_PROVIDER_FIXTURE_FILE?.trim())
    ? SecretIdentityProviderFixtureConfigSchema.safeParse({
      file: env.BAKERY_SECRET_IDENTITY_PROVIDER_FIXTURE_FILE,
    })
    : undefined;
  if (
    configuredProviderFixture &&
    (!configuredProviderFixture.success || environment === "production")
  ) invalidConfig.push("BAKERY_SECRET_IDENTITY_PROVIDER_FIXTURE_FILE");
  let skillFileRoot: SkillFileRootConfig | undefined;
  if (kind === "server" && env.BAKERY_SKILL_FILE_ROOT !== undefined) {
    try {
      skillFileRoot = readSkillFileRootConfig(env.BAKERY_SKILL_FILE_ROOT);
    } catch {
      invalidConfig.push("BAKERY_SKILL_FILE_ROOT");
    }
  }
  // An invalid size fails start-up (DRAFT_WORKER_POOL_SIZE_INVALID).
  const draftWorkerPoolSize = kind === "server"
    ? readDraftWorkerPoolSize(env)
    : undefined;
  // An unknown launcher fails start-up (DRAFT_ISOLATION_CONFIG_INVALID), as
  // it did when the app read it: never fall back to a weaker isolation.
  const draftIsolationLauncher = kind === "server"
    ? readDraftIsolationLauncher(env)
    : undefined;
  const config: RuntimeConfig = {
    sentry: readSentryConfig(env, kind, environment),
    ...(draftIsolationLauncher ? { draftIsolationLauncher } : {}),
    ...(draftWorkerPoolSize === undefined ? {} : { draftWorkerPoolSize }),
    ...(budget ? { budget } : {}),
    ...(configuredSecretsKey?.success
      ? { secretsKey: configuredSecretsKey.data }
      : {}),
    ...(configuredProviderFixture?.success && environment !== "production"
      ? { secretIdentityProviderFixture: configuredProviderFixture.data }
      : {}),
    ...(skillFileRoot ? { skillFileRoot } : {}),
    ...(artifactPreviewOrigin ? { artifactPreviewOrigin } : {}),
    environment,
    host,
    port,
    publicBaseUrl: publicOrigin,
    version: readRequiredText(
      env.BAKERY_VERSION,
      "VERSION_INVALID",
      "0.0.0-dev",
    ),
    requiredConfig,
    missingConfig,
    invalidConfig: [...new Set(invalidConfig)],
  };
  if (kind === "server") {
    const trustedProxies = invalidTrustedProxyCidrs(env)
      ? undefined
      : readTrustedProxyCidrs(env);
    if (trustedProxies) config.trustedProxies = trustedProxies;
    config.auth = {
      secret,
      publicOrigin,
      trustedOrigins,
      ...(githubClientId && githubClientSecret
        ? {
          github: {
            clientId: githubClientId,
            clientSecret: githubClientSecret,
          },
        }
        : {}),
    };
  }
  if (
    kind === "server" && inngestUrl &&
    !missingConfig.includes("INNGEST_SIGNING_KEY") &&
    !missingConfig.includes("INNGEST_EVENT_KEY") &&
    !invalidConfig.includes("INNGEST_SIGNING_KEY") &&
    !invalidConfig.includes("INNGEST_JOB_COMPLETION_TIMEOUT") &&
    !invalidConfig.includes("INNGEST_URL") &&
    !invalidConfig.includes("BAKERY_INNGEST_PRIVATE_HOST_SUFFIX")
  ) {
    config.inngest = readInngestRuntimeConfig(env);
  }
  return config;
}

export function assertRuntimeConfig(config: RuntimeConfig): void {
  const problems = [...config.missingConfig, ...config.invalidConfig];
  if (problems.length > 0) {
    throw new Error(
      `RUNTIME_CONFIGURATION_INVALID:${[...new Set(problems)].join(",")}`,
    );
  }
}

/** Inspection ceilings are code-owned and cannot be enlarged by job input. */
export const REPOSITORY_INSPECTION_LIMITS = Object.freeze({
  decodedBytes: 4 * 1024 * 1024,
  fileBytes: 1024 * 1024,
  entries: 1024,
  pathBytes: 512,
  pathSegments: 16,
  chunkBytes: 32 * 1024,
  envelopeBytes: 8 * 1024 * 1024,
  durationMs: 60_000,
  commandMs: 5_000,
  outputBytes: 8 * 1024,
  reportBytes: 64 * 1024,
  memoryBytes: 512 * 1024 * 1024,
  processes: 64,
});

export const REPOSITORY_INSPECTION_EXECUTABLES = Object.freeze({
  git: "/usr/bin/git",
  node: "/usr/bin/node",
});

/** How draft isolation starts its worker; see apps/server/src/modules/knowledge/draft-isolation.ts. */
export type DraftIsolationLauncher = "systemd" | "process";

/**
 * `BAKERY_DRAFT_ISOLATION`: `systemd` (default) runs each draft worker in a
 * transient systemd unit; `process` starts it through the fixed launcher
 * (infra/draft-worker/launch.sh) as a bounded child process, for containers
 * without systemd.
 */
export function readDraftIsolationLauncher(
  // No default: a whole-environment read here crashed apps run with a scoped
  // --allow-env (#306). readRuntimeConfig passes its env.
  env: Record<string, string | undefined>,
): DraftIsolationLauncher {
  const value = env.BAKERY_DRAFT_ISOLATION?.trim() || "systemd";
  if (value !== "systemd" && value !== "process") {
    throw new Error("DRAFT_ISOLATION_CONFIG_INVALID");
  }
  return value;
}

/**
 * `BAKERY_DRAFT_WORKER_POOL_SIZE`: how many isolated draft workers may run at
 * once, process-wide (#243, #297). Unset means the built-in default. Each
 * organization always gets half of it (rounded up, at least 1), and more
 * while one slot stays free. Read once by readRuntimeConfig; the app never
 * reads the environment itself.
 */
export function readDraftWorkerPoolSize(
  env: Record<string, string | undefined>,
): number | undefined {
  const raw = env.BAKERY_DRAFT_WORKER_POOL_SIZE?.trim();
  if (!raw) return undefined;
  if (!/^[1-9][0-9]?$/.test(raw)) {
    throw new Error("DRAFT_WORKER_POOL_SIZE_INVALID");
  }
  return Number(raw);
}

export type ArtifactStorageConfig = {
  readonly collectionEnabled: boolean;
  readonly warnPercent: number;
  readonly pausePercent: number;
  readonly dataDirectory: string | undefined;
};

export function readArtifactStorageConfig(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): ArtifactStorageConfig {
  const enabled = env.BAKERY_ARTIFACT_COLLECTION_ENABLED ?? "false";
  const warnPercent = Number(env.BAKERY_ARTIFACT_CAPACITY_WARN_PERCENT ?? "75");
  const pausePercent = Number(
    env.BAKERY_ARTIFACT_CAPACITY_PAUSE_PERCENT ?? "90",
  );
  if (
    !["true", "false"].includes(enabled) || !Number.isFinite(warnPercent) ||
    !Number.isFinite(pausePercent) || warnPercent <= 0 ||
    warnPercent >= pausePercent || pausePercent > 100
  ) {
    throw new Error("ARTIFACT_STORAGE_CONFIG_INVALID");
  }
  return {
    collectionEnabled: enabled === "true",
    warnPercent,
    pausePercent,
    dataDirectory: env.BAKERY_ARTIFACT_DATA_DIRECTORY,
  };
}

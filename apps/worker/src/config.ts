import { join } from "node:path";
import { GIT_EXECUTABLE } from "./git-executable.ts";
import { assertAbsolutePath } from "./storage.ts";
import { WORKER_SPOOL_MIN_BYTES, WORKER_SPOOL_MIN_RECORDS } from "./types.ts";
import {
  readSentryConfig,
  SENTRY_WORKER_ENVIRONMENT_NAMES,
  type SentryConfig,
} from "@bakery/config/sentry";

export type CodingHarnessConfig = {
  /** Stable adapter identifier selected by the enabled environment prefix. */
  name: string;
  executable: string;
  timeLimitMs: number;
  repository: string;
  /** Harness-specific model selector; each adapter validates its own vocabulary. */
  model?: string;
  /** Reasoning-effort selector; adapters that do not support one fault truthfully. */
  effort?: string;
};

type HarnessSettings = Omit<CodingHarnessConfig, "name">;

const CODING_HARNESS_ENVIRONMENT_PREFIXES = [
  "CODEX",
  "PI",
  "CLAUDE",
] as const;

const CODING_HARNESS_ENVIRONMENT_NAMES = CODING_HARNESS_ENVIRONMENT_PREFIXES
  .flatMap((prefix) => [
    `BAKERY_${prefix}_HARNESS`,
    `BAKERY_${prefix}_HARNESS_REPOSITORY`,
    `BAKERY_${prefix}_HARNESS_EXECUTABLE`,
    `BAKERY_${prefix}_HARNESS_TIME_LIMIT_MS`,
    `BAKERY_${prefix}_HARNESS_MODEL`,
    `BAKERY_${prefix}_HARNESS_EFFORT`,
  ]);
/**
 * Upper bound for the heartbeat interval. The server judges a host stale after
 * 30 s without a heartbeat and the claim gate refuses stale hosts, so the
 * interval stays well below that threshold (about two thirds) to leave margin
 * for network and scheduling delay.
 */
export const MAX_HEARTBEAT_INTERVAL_MS = 20_000;
const WORKER_ENVIRONMENTS: Record<WorkerConfig["environment"], true> = {
  development: true,
  test: true,
  production: true,
};

export type WorkerConfig = {
  sentry?: SentryConfig;
  environment: "development" | "test" | "production";
  serverUrl: string;
  version: string;
  name: string;
  os: "linux" | "macos";
  architecture: string;
  /**
   * Capabilities this host enrolls (`BAKERY_WORKER_CAPABILITIES`). A host
   * claims a job only when every capability the job requires is in this list.
   * `review.independent` requires `model` and `reviewer`; nothing adds
   * `reviewer` for the operator, so a host opts in by listing it and only a
   * Claude-harness host can run the job.
   */
  capabilities: string[];
  /** Steering capabilities the harness adapters advertise; empty accepts only cancel. */
  adapterCapabilities?: string[];
  toolchainVersions: Record<string, string>;
  slots: number;
  enrollmentToken?: string;
  enrollmentTokenPath?: string;
  enrollmentTokenFromDescriptor?: boolean;
  stateDir: string;
  nativeCgroupRoot?: string;
  registrationPath: string;
  spoolPath: string;
  heartbeatIntervalMs: number;
  claimBackoffBaseMs: number;
  claimBackoffMaxMs: number;
  requestTimeoutMs: number;
  drainTimeoutMs: number;
  terminationGraceMs: number;
  spoolMaxRecords: number;
  spoolMaxBytes: number;
  outputRedactionSecrets?: string[];
  shutdownReceiptLaunchId?: string;
  /** Test-only directory the scripted harness uses for its start and release files. */
  scriptedHarnessDir?: string;
  /** The single coding harness enabled for this worker, when configured. */
  codingHarness?: CodingHarnessConfig;
  /**
   * Directory holding the Claude Code credentials, for the claude harness only:
   * `BAKERY_CLAUDE_AUTH_SOURCE_DIR`, else `$HOME/.claude`. Feeds both the
   * harness auth copy and the `capability:model` readiness check.
   */
  claudeAuthSourceDir?: string;
  /** `BAKERY_CLAUDE_COORDINATOR_TIME_LIMIT_MS`, 1000-3600000; claude harness only. */
  claudeCoordinatorTimeLimitMs?: number;
  /** `BAKERY_CLAUDE_COORDINATOR_EFFORT`; validated against the CLI vocabulary at startup. */
  claudeCoordinatorEffort?: string;
  /**
   * Directory holding the Codex `auth.json`, for the codex harness only:
   * `BAKERY_CODEX_AUTH_SOURCE_DIR`, else `CODEX_HOME`, else `$HOME/.codex`.
   * The harness copies only `auth.json` into the isolated per-attempt home.
   */
  codexAuthSourceDir?: string;
  /**
   * Legacy Codex-shaped view retained for existing callers and keys.
   * Production Codex selection uses the shared `codingHarness` value.
   */
  codexHarness?: HarnessSettings;
};

function harnessName(prefix: string): string {
  return prefix.toLowerCase().replaceAll("_", "-");
}

function harnessDefaultExecutable(prefix: string): string {
  return prefix === "CLAUDE" ? "claude" : prefix.toLowerCase();
}

function enabledHarnessPrefixes(
  env: Record<string, string | undefined>,
): string[] {
  return Object.entries(env).flatMap(([name, value]) => {
    const match = /^BAKERY_([A-Z][A-Z0-9_]*)_HARNESS$/.exec(name);
    return match && value?.trim() === "1" ? [match[1]] : [];
  });
}

function readHarnessSettings(
  env: Record<string, string | undefined>,
  prefix: string,
): HarnessSettings {
  const base = `BAKERY_${prefix}_HARNESS`;
  const repositoryKey = `${base}_REPOSITORY`;
  const executableKey = `${base}_EXECUTABLE`;
  const timeLimitKey = `${base}_TIME_LIMIT_MS`;
  const repository = assertAbsolutePath(
    env[repositoryKey]?.trim() || "",
    repositoryKey,
  );
  const executable = env[executableKey]?.trim() ||
    harnessDefaultExecutable(prefix);
  const timeLimitText = env[timeLimitKey]?.trim();
  const timeLimitMs = timeLimitText
    ? Number.parseInt(timeLimitText, 10)
    : 120_000;
  if (
    !Number.isSafeInteger(timeLimitMs) || timeLimitMs < 1_000 ||
    timeLimitMs > 3_600_000
  ) {
    throw new Error(`${timeLimitKey}_INVALID`);
  }
  const modelKey = `${base}_MODEL`;
  const effortKey = `${base}_EFFORT`;
  const model = env[modelKey]?.trim();
  const effort = env[effortKey]?.trim();
  for (
    const [key, value] of [[modelKey, model], [effortKey, effort]] as const
  ) {
    if (value !== undefined && !/^[a-zA-Z0-9._:\/-]{1,100}$/.test(value)) {
      throw new Error(`${key}_INVALID`);
    }
  }
  return {
    executable,
    timeLimitMs,
    repository,
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
  };
}

function rejectUnenabledHarnessRepositories(
  env: Record<string, string | undefined>,
): void {
  for (const [name, value] of Object.entries(env)) {
    const match = /^BAKERY_([A-Z][A-Z0-9_]*)_HARNESS_REPOSITORY$/.exec(name);
    if (
      match && value?.trim() &&
      env[`BAKERY_${match[1]}_HARNESS`]?.trim() !== "1"
    ) {
      throw new Error(`${name}_WITHOUT_ENABLE`);
    }
  }
}

function readCodingHarness(
  env: Record<string, string | undefined>,
): {
  codingHarness?: CodingHarnessConfig;
  codexHarness?: HarnessSettings;
} {
  const enabled = enabledHarnessPrefixes(env);
  if (enabled.length > 1) {
    throw new Error(`BAKERY_CODING_HARNESS_CONFLICT:${enabled.join(",")}`);
  }
  if (enabled.length === 0) {
    rejectUnenabledHarnessRepositories(env);
    return {};
  }
  const prefix = enabled[0]!;
  const settings = readHarnessSettings(env, prefix);
  const codingHarness = { name: harnessName(prefix), ...settings };
  return prefix === "CODEX"
    ? { codingHarness, codexHarness: settings }
    : { codingHarness };
}

/**
 * The scripted harness replaces the honest "no coding harness" fault, so it is
 * accepted only in the test environment and never in development or production.
 */
function readScriptedHarnessDir(
  env: Record<string, string | undefined>,
  environment: WorkerConfig["environment"],
): string | undefined {
  const value = env.BAKERY_WORKER_SCRIPTED_HARNESS_DIR?.trim();
  if (!value) return undefined;
  if (environment !== "test") {
    throw new Error("BAKERY_WORKER_SCRIPTED_HARNESS_DIR_TEST_ONLY");
  }
  return assertAbsolutePath(value, "BAKERY_WORKER_SCRIPTED_HARNESS_DIR");
}

function requiredText(
  env: Record<string, string | undefined>,
  name: string,
): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

function boundedInteger(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name}_INVALID`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name}_INVALID`);
  }
  return value;
}

function parseCapabilities(value: string): string[] {
  const capabilities = [
    ...new Set(value.split(",").map((item) => item.trim()).filter(Boolean)),
  ];
  if (
    capabilities.length === 0 || capabilities.some((item) => item.length > 100)
  ) {
    throw new Error("BAKERY_WORKER_CAPABILITIES_INVALID");
  }
  return capabilities;
}

export const WORKER_ADAPTER_CAPABILITIES = [
  "stream",
  "resume",
  "steer",
  "follow_up",
  "interrupt",
] as const;

/** Closed vocabulary; default empty means no adapter accepts steering. */
export function parseAdapterCapabilities(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  const requested = value.split(",").map((item) => item.trim()).filter(Boolean);
  const allowed: readonly string[] = WORKER_ADAPTER_CAPABILITIES;
  if (requested.some((item) => !allowed.includes(item))) {
    throw new Error("BAKERY_WORKER_ADAPTER_CAPABILITIES_INVALID");
  }
  return [...new Set(requested)];
}

function parseOutputRedactionSecrets(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("BAKERY_WORKER_OUTPUT_REDACTION_SECRETS_INVALID");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.some((secret) => typeof secret !== "string" || secret.length === 0)
  ) throw new Error("BAKERY_WORKER_OUTPUT_REDACTION_SECRETS_INVALID");
  const unique = [...new Set(parsed as string[])];
  const bytes = unique.reduce(
    (sum, secret) => sum + new TextEncoder().encode(secret).byteLength,
    0,
  );
  if (bytes > 4_096) {
    throw new Error("BAKERY_WORKER_OUTPUT_REDACTION_SECRETS_INVALID");
  }
  return unique;
}

function parseToolchains(value: string | undefined): Record<string, string> {
  if (!value?.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("BAKERY_WORKER_TOOLCHAINS_INVALID");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("BAKERY_WORKER_TOOLCHAINS_INVALID");
  }
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(parsed)) {
    if (
      !key || key.length > 100 || typeof item !== "string" || item.length > 200
    ) {
      throw new Error("BAKERY_WORKER_TOOLCHAINS_INVALID");
    }
    result[key] = item;
  }
  return result;
}

function readServerUrl(
  value: string,
  environment: WorkerConfig["environment"],
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("BAKERY_SERVER_URL_INVALID");
  }
  if (
    !["http:", "https:"].includes(url.protocol) || url.username ||
    url.password || url.search || url.hash || !url.hostname
  ) throw new Error("BAKERY_SERVER_URL_INVALID");
  if (environment === "production" && url.protocol !== "https:") {
    throw new Error("BAKERY_SERVER_URL_INVALID");
  }
  if (url.protocol === "http:" && environment !== "production") {
    const loopback = url.hostname === "localhost" || url.hostname === "[::1]" ||
      /^127(?:\.[0-9]{1,3}){3}$/.test(url.hostname);
    const composeService = url.origin === "http://server:8000" &&
      url.pathname === "/";
    if (!loopback && !composeService) {
      throw new Error("BAKERY_SERVER_URL_INVALID");
    }
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

function defaultStateDir(env: Record<string, string | undefined>): string {
  const home = env.HOME?.trim();
  if (!home || !home.startsWith("/")) throw new Error("HOME_REQUIRED");
  return `${home}/.local/state/bakery-worker`;
}
function enrollmentInputPath(
  env: Record<string, string | undefined>,
): { path: string; fromDescriptor: boolean } | undefined {
  const legacy = env.BAKERY_WORKER_ENROLLMENT_TOKEN?.trim();
  if (legacy) throw new Error("BAKERY_WORKER_ENROLLMENT_TOKEN_ENV_UNSUPPORTED");

  const file = env.BAKERY_WORKER_ENROLLMENT_TOKEN_FILE?.trim();
  const fd = env.BAKERY_WORKER_ENROLLMENT_TOKEN_FD?.trim();
  if (file && fd) {
    throw new Error("BAKERY_WORKER_ENROLLMENT_TOKEN_INPUT_CONFLICT");
  }
  if (!file && !fd) return undefined;

  if (file) {
    return {
      path: assertAbsolutePath(file, "BAKERY_WORKER_ENROLLMENT_TOKEN_FILE"),
      fromDescriptor: false,
    };
  }
  if (!/^\d+$/.test(fd!)) {
    throw new Error("BAKERY_WORKER_ENROLLMENT_TOKEN_FD_INVALID");
  }
  const descriptor = Number(fd);
  if (!Number.isSafeInteger(descriptor) || descriptor < 0) {
    throw new Error("BAKERY_WORKER_ENROLLMENT_TOKEN_FD_INVALID");
  }
  return {
    path: Deno.build.os === "linux"
      ? `/proc/self/fd/${descriptor}`
      : `/dev/fd/${descriptor}`,
    fromDescriptor: true,
  };
}

export function readWorkerEnrollmentToken(input: {
  path: string;
  fromDescriptor?: boolean;
}): string {
  try {
    const info = Deno.statSync(input.path);
    if (
      (!input.fromDescriptor && !info.isFile) ||
      (info.mode !== null && (info.mode & 0o077) !== 0)
    ) {
      throw new Error("protected input");
    }
    const token = Deno.readTextFileSync(input.path).trim();
    if (!token || /[\r\n]/.test(token)) {
      throw new Error("empty or multiline input");
    }
    return token;
  } catch {
    throw new Error("BAKERY_WORKER_ENROLLMENT_TOKEN_INPUT_INVALID");
  }
}

export const WORKER_RUNTIME_ENVIRONMENT_NAMES = [
  ...SENTRY_WORKER_ENVIRONMENT_NAMES,
  "HOME",
  "PATH",
  "DENO_DIR",
  "PI_CODING_AGENT_DIR",
  "CODEX_HOME",
  "TMPDIR",
  "BAKERY_ENV",
  "BAKERY_SERVER_URL",
  "BAKERY_VERSION",
  "BAKERY_WORKER_STARTUP_MARKER",
  "BAKERY_WORKER_NATIVE_SMOKE",
  "BAKERY_WORKER_NATIVE_OUTPUT_FIXTURE",
  "BAKERY_WORKER_CGROUP_ROOT",
  "BAKERY_WORKER_ENROLLMENT_TOKEN_FILE",
  "BAKERY_WORKER_ENROLLMENT_TOKEN_FD",
  "BAKERY_WORKER_STATE_DIR",
  "BAKERY_WORKER_NAME",
  "BAKERY_WORKER_CAPABILITIES",
  "BAKERY_WORKER_ADAPTER_CAPABILITIES",
  "BAKERY_WORKER_TOOLCHAINS",
  "BAKERY_WORKER_SLOTS",
  "BAKERY_WORKER_HEARTBEAT_MS",
  "BAKERY_WORKER_CLAIM_BACKOFF_MS",
  "BAKERY_WORKER_CLAIM_BACKOFF_MAX_MS",
  "BAKERY_WORKER_REQUEST_TIMEOUT_MS",
  "BAKERY_WORKER_DRAIN_MS",
  "BAKERY_WORKER_SPOOL_RECORDS",
  "BAKERY_WORKER_SPOOL_BYTES",
  "BAKERY_WORKER_OUTPUT_REDACTION_SECRETS",
  "BAKERY_WORKER_LAUNCH_ID",
  "BAKERY_WORKER_SCRIPTED_HARNESS_DIR",
  "BAKERY_CLAUDE_AUTH_SOURCE_DIR",
  "BAKERY_CODEX_AUTH_SOURCE_DIR",
  "BAKERY_CLAUDE_COORDINATOR_TIME_LIMIT_MS",
  "BAKERY_CLAUDE_COORDINATOR_EFFORT",
  ...CODING_HARNESS_ENVIRONMENT_NAMES,
] as const;

export type WorkerLaunchPermissions = {
  read: readonly string[];
  write: readonly string[];
  net: readonly string[];
  run: readonly string[];
  sys: readonly string[];
};

/**
 * Launch run grants. Base set is Deno, bwrap and ldd; setsid, git and the
 * harness executable are granted only when a coding harness is configured.
 */
export function workerRunExecutables(
  denoPath: string,
  harnessExecutable?: string,
): readonly string[] {
  return [
    denoPath,
    "/usr/bin/bwrap",
    "/usr/bin/ldd",
    "/usr/bin/kill",
    ...(harnessExecutable
      ? ["/usr/bin/setsid", GIT_EXECUTABLE, harnessExecutable]
      : []),
  ];
}

export function workerRuntimeReadPaths(
  denoPath: string,
  options: { codingHarness?: boolean } = {},
): readonly string[] {
  return [
    denoPath,
    "/bin/sh",
    "/usr/bin/bash",
    // Deno checks symlink targets too: /bin/sh -> dash and /usr/bin/true ->
    // gnutrue on Debian/Ubuntu runners.
    "/usr/bin/dash",
    "/usr/bin/gnutrue",
    GIT_EXECUTABLE,
    "/usr/bin/bwrap",
    "/usr/bin/node",
    "/usr/bin/true",
    "/usr/bin/ldd",
    "/usr/bin/kill",
    ...(options.codingHarness ? ["/usr/bin/setsid"] : []),
    // ldd reports the loader and libraries by their merged-usr symlink
    // paths; Deno checks the path as given, so grant those spellings too.
    "/lib",
    "/lib64",
    "/usr/lib",
    "/usr/lib64",
  ];
}

function pathUnder(root: string, suffix: string): string {
  const normalizedRoot = root.trim().replace(/\/+$/, "");
  if (!normalizedRoot.startsWith("/") || normalizedRoot.includes("/../")) {
    throw new Error("WORKER_LAUNCH_ROOT_INVALID");
  }
  return `${normalizedRoot}/${suffix}`;
}

function launchPath(value: string, field: string): string {
  const path = assertAbsolutePath(value, field);
  if (path.includes(",") || /[\r\n]/.test(path)) {
    throw new Error(`${field}_INVALID`);
  }
  return path;
}

function piAgentSourcePath(
  env: Record<string, string | undefined>,
  codingHarness: CodingHarnessConfig | undefined,
): string | undefined {
  if (codingHarness?.name !== "pi") return undefined;
  const configured = env.PI_CODING_AGENT_DIR?.trim();
  if (configured) return launchPath(configured, "PI_CODING_AGENT_DIR");
  const home = env.HOME?.trim();
  if (!home) throw new Error("HOME_REQUIRED_FOR_PI_HARNESS");
  return launchPath(join(home, ".pi", "agent"), "HOME/.pi/agent");
}

function claudeAuthSourcePath(
  env: Record<string, string | undefined>,
  codingHarness: CodingHarnessConfig | undefined,
): string | undefined {
  if (codingHarness?.name !== "claude") return undefined;
  const configured = env.BAKERY_CLAUDE_AUTH_SOURCE_DIR?.trim();
  if (configured) {
    return launchPath(configured, "BAKERY_CLAUDE_AUTH_SOURCE_DIR");
  }
  const home = env.HOME?.trim();
  if (!home) throw new Error("HOME_REQUIRED_FOR_CLAUDE_HARNESS");
  return launchPath(join(home, ".claude"), "HOME/.claude");
}

function codexAuthSourcePath(
  env: Record<string, string | undefined>,
  codingHarness: CodingHarnessConfig | undefined,
): string | undefined {
  if (codingHarness?.name !== "codex") return undefined;
  const configured = env.BAKERY_CODEX_AUTH_SOURCE_DIR?.trim();
  if (configured) {
    return launchPath(configured, "BAKERY_CODEX_AUTH_SOURCE_DIR");
  }
  const codexHome = env.CODEX_HOME?.trim();
  if (codexHome) return launchPath(codexHome, "CODEX_HOME");
  const home = env.HOME?.trim();
  if (!home) throw new Error("HOME_REQUIRED_FOR_CODEX_HARNESS");
  return launchPath(join(home, ".codex"), "HOME/.codex");
}

function assertCgroupRoot(value: string, field: string): string {
  const path = launchPath(value, field);
  const relative = path.startsWith("/sys/fs/cgroup/")
    ? path.slice("/sys/fs/cgroup/".length)
    : "";
  if (
    !relative ||
    path.endsWith("/") ||
    relative.split("/").some((segment) =>
      segment === "" || segment === "." || segment === ".."
    )
  ) {
    throw new Error(`${field}_INVALID`);
  }
  return path;
}

export function readWorkerLaunchPermissions(
  env: Record<string, string | undefined>,
  root: string,
): WorkerLaunchPermissions {
  const environmentValue = env.BAKERY_ENV?.trim() || "development";
  if (!Object.hasOwn(WORKER_ENVIRONMENTS, environmentValue)) {
    throw new Error("ENVIRONMENT_INVALID");
  }
  const environment = environmentValue as WorkerConfig["environment"];
  const serverUrl = readServerUrl(
    requiredText(env, "BAKERY_SERVER_URL"),
    environment,
  );
  const stateDir = launchPath(
    env.BAKERY_WORKER_STATE_DIR?.trim() || defaultStateDir(env),
    "BAKERY_WORKER_STATE_DIR",
  );
  const nativeCgroupRoot = env.BAKERY_WORKER_CGROUP_ROOT?.trim()
    ? assertCgroupRoot(
      env.BAKERY_WORKER_CGROUP_ROOT,
      "BAKERY_WORKER_CGROUP_ROOT",
    )
    : undefined;
  const tokenInput = enrollmentInputPath(env);
  const scriptedHarnessDir = readScriptedHarnessDir(env, environment);
  const codingHarness = readCodingHarness(env).codingHarness;
  const claudeAuthSource = claudeAuthSourcePath(env, codingHarness);
  const piAgentSource = piAgentSourcePath(env, codingHarness);
  const codexAuthSource = codexAuthSourcePath(env, codingHarness);

  const harnessPrefix = codingHarness?.name.toUpperCase().replaceAll("-", "_");
  const harnessRepository = codingHarness
    ? launchPath(
      codingHarness.repository,
      `BAKERY_${harnessPrefix}_HARNESS_REPOSITORY`,
    )
    : undefined;
  const readPaths = new Set([
    pathUnder(root, "apps/worker"),
    pathUnder(root, "packages/config"),
    pathUnder(root, "packages/contracts"),
    pathUnder(root, "docs/technical-design/api-catalog.json"),
    pathUnder(root, "deno.json"),
    pathUnder(root, "deno.lock"),
    pathUnder(root, "node_modules/zod"),
    ...workerRuntimeReadPaths(Deno.execPath(), {
      codingHarness: codingHarness !== undefined,
    }),
    stateDir,
    ...(harnessRepository ? [harnessRepository] : []),
    ...(claudeAuthSource ? [claudeAuthSource] : []),
    ...(piAgentSource ? [piAgentSource] : []),
    ...(codexAuthSource ? [codexAuthSource] : []),
    ...(tokenInput
      ? [launchPath(tokenInput.path, "BAKERY_WORKER_ENROLLMENT_TOKEN_FILE")]
      : []),
    ...(nativeCgroupRoot ? [nativeCgroupRoot] : []),
    ...(scriptedHarnessDir
      ? [launchPath(scriptedHarnessDir, "BAKERY_WORKER_SCRIPTED_HARNESS_DIR")]
      : []),
  ]);
  const url = new URL(serverUrl);
  const hostname = url.hostname.includes(":") &&
      !url.hostname.startsWith("[")
    ? `[${url.hostname}]`
    : url.hostname;
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  const sentry = readSentryConfig(env, "worker", environment);
  const ingestUrl = sentry.enabled ? new URL(sentry.dsn) : undefined;
  return {
    read: [...readPaths],
    write: [
      stateDir,
      ...(harnessRepository ? [harnessRepository] : []),
      ...(nativeCgroupRoot ? [nativeCgroupRoot] : []),
      ...(scriptedHarnessDir
        ? [launchPath(scriptedHarnessDir, "BAKERY_WORKER_SCRIPTED_HARNESS_DIR")]
        : []),
    ],
    net: [
      `${hostname}:${port}`,
      ...(ingestUrl
        ? [`${ingestUrl.hostname}:${ingestUrl.port || "443"}`]
        : []),
    ],
    run: workerRunExecutables(
      Deno.execPath(),
      codingHarness?.executable,
    ),
    sys: ["uid"],
  };
}

// Smoke hooks are read separately by main only when their permission is granted.
const WORKER_ENVIRONMENT_NAMES = WORKER_RUNTIME_ENVIRONMENT_NAMES.filter(
  (name) =>
    name !== "BAKERY_WORKER_STARTUP_MARKER" &&
    name !== "BAKERY_WORKER_NATIVE_SMOKE" &&
    name !== "BAKERY_WORKER_NATIVE_OUTPUT_FIXTURE",
);

function normalizedArchitecture(): string {
  switch (Deno.build.arch) {
    case "x86_64":
      return "x64";
    case "aarch64":
      return "arm64";
    default:
      return Deno.build.arch;
  }
}

export function readWorkerEnvironment(): Record<
  string,
  string | undefined
> {
  const environment: Record<string, string | undefined> = {};
  for (const name of WORKER_ENVIRONMENT_NAMES) {
    environment[name] = Deno.env.get(name);
  }
  return environment;
}

export function readWorkerConfig(
  env: Record<string, string | undefined> = readWorkerEnvironment(),
): WorkerConfig {
  const environmentValue = env.BAKERY_ENV?.trim() || "development";
  if (!Object.hasOwn(WORKER_ENVIRONMENTS, environmentValue)) {
    throw new Error("ENVIRONMENT_INVALID");
  }
  const environment = environmentValue as WorkerConfig["environment"];
  const serverUrl = readServerUrl(
    requiredText(env, "BAKERY_SERVER_URL"),
    environment,
  );
  const os = Deno.build.os === "darwin"
    ? "macos"
    : Deno.build.os === "linux"
    ? "linux"
    : null;
  if (!os) throw new Error("WORKER_PLATFORM_UNSUPPORTED");
  const stateDir = assertAbsolutePath(
    env.BAKERY_WORKER_STATE_DIR?.trim() || defaultStateDir(env),
    "BAKERY_WORKER_STATE_DIR",
  );
  const slots = boundedInteger(env, "BAKERY_WORKER_SLOTS", 1, 1, 100);
  const heartbeatIntervalMs = boundedInteger(
    env,
    "BAKERY_WORKER_HEARTBEAT_MS",
    15_000,
    100,
    MAX_HEARTBEAT_INTERVAL_MS,
  );
  const claimBackoffBaseMs = boundedInteger(
    env,
    "BAKERY_WORKER_CLAIM_BACKOFF_MS",
    1_000,
    100,
    60_000,
  );
  const claimBackoffMaxMs = boundedInteger(
    env,
    "BAKERY_WORKER_CLAIM_BACKOFF_MAX_MS",
    15_000,
    claimBackoffBaseMs,
    300_000,
  );
  const requestTimeoutMs = boundedInteger(
    env,
    "BAKERY_WORKER_REQUEST_TIMEOUT_MS",
    10_000,
    100,
    120_000,
  );
  const drainTimeoutMs = boundedInteger(
    env,
    "BAKERY_WORKER_DRAIN_MS",
    5_000,
    100,
    120_000,
  );
  const terminationGraceMs = drainTimeoutMs;
  const spoolMaxRecords = boundedInteger(
    env,
    "BAKERY_WORKER_SPOOL_RECORDS",
    1_000,
    WORKER_SPOOL_MIN_RECORDS,
    100_000,
  );
  const spoolMaxBytes = boundedInteger(
    env,
    "BAKERY_WORKER_SPOOL_BYTES",
    1_048_576,
    WORKER_SPOOL_MIN_BYTES,
    64 * 1024 * 1024,
  );

  const capabilities = parseCapabilities(
    requiredText(env, "BAKERY_WORKER_CAPABILITIES"),
  );
  const enrollmentInput = enrollmentInputPath(env);
  const shutdownReceiptLaunchId = env.BAKERY_WORKER_LAUNCH_ID?.trim();
  if (
    shutdownReceiptLaunchId &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(shutdownReceiptLaunchId)
  ) throw new Error("BAKERY_WORKER_LAUNCH_ID_INVALID");
  const scriptedHarnessDir = readScriptedHarnessDir(env, environment);
  const harnessConfiguration = readCodingHarness(env);
  const claudeAuthSourceDir = claudeAuthSourcePath(
    env,
    harnessConfiguration.codingHarness,
  );
  const codexAuthSourceDir = codexAuthSourcePath(
    env,
    harnessConfiguration.codingHarness,
  );
  const coordinatorEffort = env.BAKERY_CLAUDE_COORDINATOR_EFFORT?.trim();
  if (coordinatorEffort && !/^[a-z]{1,20}$/.test(coordinatorEffort)) {
    throw new Error("BAKERY_CLAUDE_COORDINATOR_EFFORT_INVALID");
  }
  const coordinatorTimeLimitMs = env.BAKERY_CLAUDE_COORDINATOR_TIME_LIMIT_MS
      ?.trim()
    ? boundedInteger(
      env,
      "BAKERY_CLAUDE_COORDINATOR_TIME_LIMIT_MS",
      180_000,
      1_000,
      3_600_000,
    )
    : undefined;
  return {
    sentry: readSentryConfig(env, "worker", environment),
    environment,
    serverUrl,
    version: env.BAKERY_VERSION?.trim() || "0.0.0-dev",
    name: env.BAKERY_WORKER_NAME?.trim() || "bakery-worker",
    os,
    architecture: normalizedArchitecture(),
    capabilities,
    adapterCapabilities: parseAdapterCapabilities(
      env.BAKERY_WORKER_ADAPTER_CAPABILITIES,
    ),
    toolchainVersions: parseToolchains(env.BAKERY_WORKER_TOOLCHAINS),
    slots,
    ...(enrollmentInput
      ? {
        enrollmentTokenPath: enrollmentInput.path,
        enrollmentTokenFromDescriptor: enrollmentInput.fromDescriptor,
      }
      : {}),
    ...(env.BAKERY_WORKER_CGROUP_ROOT
      ? {
        nativeCgroupRoot: assertCgroupRoot(
          env.BAKERY_WORKER_CGROUP_ROOT,
          "BAKERY_WORKER_CGROUP_ROOT",
        ),
      }
      : {}),
    stateDir,
    registrationPath: `${stateDir}/registration.json`,
    spoolPath: `${stateDir}/spool.json`,
    heartbeatIntervalMs,
    claimBackoffBaseMs,
    claimBackoffMaxMs,
    requestTimeoutMs,
    drainTimeoutMs,
    terminationGraceMs,
    spoolMaxRecords,
    spoolMaxBytes,
    outputRedactionSecrets: parseOutputRedactionSecrets(
      env.BAKERY_WORKER_OUTPUT_REDACTION_SECRETS,
    ),
    ...(shutdownReceiptLaunchId ? { shutdownReceiptLaunchId } : {}),
    ...(scriptedHarnessDir ? { scriptedHarnessDir } : {}),
    ...(harnessConfiguration.codingHarness
      ? { codingHarness: harnessConfiguration.codingHarness }
      : {}),
    ...(claudeAuthSourceDir ? { claudeAuthSourceDir } : {}),
    ...(codexAuthSourceDir ? { codexAuthSourceDir } : {}),
    ...(coordinatorTimeLimitMs === undefined
      ? {}
      : { claudeCoordinatorTimeLimitMs: coordinatorTimeLimitMs }),
    ...(coordinatorEffort
      ? { claudeCoordinatorEffort: coordinatorEffort }
      : {}),
    ...(harnessConfiguration.codexHarness
      ? { codexHarness: harnessConfiguration.codexHarness }
      : {}),
  };
}

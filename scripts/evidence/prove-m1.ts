/**
 * M1 (#132) real-journey proof orchestrator.
 *
 *   deno run --allow-all scripts/evidence/prove-m1.ts --out <dir> \
 *     [--keep-stack-on-failure]
 *
 * One command boots a fresh per-worktree compose stack under
 * `BAKERY_ENV=development` (no scripted adapter can load), a web build served
 * by `vite preview`, a dedicated clean harness clone and a Claude Code worker
 * unit, then runs the owner journey spec (`desktop-real-m1`) and a $0 fs06
 * regression leg of the shared helpers on the same stack. The revision-bound
 * `m1-proof-manifest.json` is written only after both legs, the guards, the
 * spend check and the cleanup passed; any other outcome writes
 * `m1-proof-failure.json` and exits non-zero. Nothing here spends model money
 * itself: the funded steps are the spec's.
 *
 * The orchestrator takes `/run/user/1000/bakery-verification.lock` itself for
 * its whole run. Never wrap it in another `flock`.
 *
 * ## Cross-phase contracts
 *
 * The Phase 2 helpers (`apps/web/tests/helpers/m1-stack-*.ts`) and the Phase 3
 * spec (`apps/web/tests/m1-journey-real.spec.ts`) cite this section. Change a
 * name here and the rail test fails, so keep the code and this list together.
 *
 * Environment the journey spec receives: all of `stack.env`, plus
 * `BAKERY_REAL_API=1`, `BAKERY_REAL_API_M1=1`, `BAKERY_M1_STATE_DIR`,
 * `BAKERY_M1_COMPOSE_PROJECT`, `BAKERY_M1_SPEND_CAP_USD`,
 * `BAKERY_M1_CANARIES_FILE`, `BAKERY_M1_HARNESS_REPO`, `BAKERY_M1_SHOTS`
 * (`<out>/journey`: screenshots and evidence JSON go here), `BASE_URL`,
 * `BAKERY_REAL_EMAIL` (`m1-proof-owner@example.test`), `BAKERY_REAL_PASSWORD`
 * and, for debugging only, `BAKERY_M1_STOP_AFTER=P<n>` (a partial run proves
 * nothing and writes no manifest). The fs06 leg gets the `BAKERY_FS06_*`
 * variables of `run-observation-real-harness.spec.ts`, with
 * `BAKERY_FS06_SHOTS=<out>/fs06`.
 *
 * State directory `~/.local/state/bakery-proof/m1-<sha8>/` (mode 0700),
 * written by the orchestrator: `stack.env` (0600, plain `KEY=value`: the whole
 * first-start compose environment plus the resolved ports), `billing.json`,
 * `worker-launch.sh`, `worker-kill.sh` (both run as `bash <state>/<name>` and
 * exit 0 on success), `secrets-to-scan.txt`, `fake/` (leg 2), `worker.env`,
 * `canaries.json`, `canaries.txt`, `adapter-guards.json`, `harness-repo/`,
 * `web/`.
 *
 * Files the spec writes:
 * - `<state>/worker-host-id.txt`: the enrolled host UUID, read for leg 2.
 * - `<state>/enrollment-token`: the one-time token (0600). The orchestrator
 *   registers it for redaction and adds it to `secrets-to-scan.txt`, on every
 *   path including a failed journey. The spec must never print it.
 * - `<state>/fault-log.txt`: appended by the helpers (copied into the
 *   evidence). See the operator-step formats below.
 * - `<BAKERY_M1_SHOTS>/ids.json` (optional): a flat string-to-string map,
 *   merged into the manifest `ids` as `journey.<key>`.
 *
 * Worker: unit `bakery-m1-<sha8>-worker`, worker name `m1-claude-worker`,
 * capabilities `git,shell,web,model`. The orchestrator cannot start it (the
 * enrollment token does not exist yet), so the spec starts it with
 * `bash <state>/worker-launch.sh` after the Machines UI enrollment and kills
 * it with `worker-kill.sh`. The journey MUST end with the unit active: the
 * orchestrator then reads the unit's environment, and a dead unit fails the
 * proof (`M1_WORKER_NOT_ACTIVE`).
 *
 * Operator steps copied into the manifest `operatorSteps` (besides the pricing
 * snapshot the orchestrator runs itself) are read from `fault-log.txt`, one
 * per line, in either of two shapes:
 * - the helper line `<ISO time> forceApprovalExpiry approvalId=<uuid>
 *   rowCount=<n> sql=<statement>` (`rowCount=1` is exit code 0, any other
 *   count 1; the step is named `force-approval-expiry`); and
 * - a line holding the JSON object `{"m1":"operator-step","name":...,
 *   "sql" or "command":..., "rowCount" or "exitCode":...}`, for a step such as
 *   the `createsuperuser` fallback.
 *
 * Secrets and evidence: output the orchestrator captures and every text file
 * under `<out>` is redacted with the registered secrets (auth secret, Inngest
 * keys, owner password, canaries, enrollment token) before it is hashed.
 * Binary files (traces, screenshots, video) are not text-scrubbed: their bytes
 * are searched for the same secrets (a hit fails the proof), and the manifest
 * `evidenceScan` lists them as not text-scanned.
 *
 * Plain TypeScript types on purpose: this is evidence tooling, not a contract
 * surface.
 */
import { dirname, join, relative, resolve } from "node:path";
import {
  billingFile,
  M1_PROOF_MODEL,
  pricingSnapshotSql,
} from "./m1-billing.ts";

// ---- constants --------------------------------------------------------------

export const M1_SPEND_CAP_LIMIT_USD = 40;
export const M1_MIN_MEM_AVAILABLE_KB = 3 * 1024 * 1024;
export const M1_VERIFICATION_LOCK = "/run/user/1000/bakery-verification.lock";
export const M1_LOCK_TIMEOUT_MS = 3_600_000;
/**
 * Wall-clock limit of the journey Playwright step. It must be at least the sum
 * of the journey spec's per-phase timeouts (`apps/web/tests/m1-journey-real.spec.ts`),
 * or the orchestrator kills a run that the spec still considers on budget.
 * Raise it together with a spec budget, never alone.
 */
export const M1_JOURNEY_TIMEOUT_MS = 300 * 60 * 1_000;
/** Wall-clock limit of the $0 fs06 fake regression leg (about 3 minutes real). */
export const M1_REGRESSION_TIMEOUT_MS = 20 * 60 * 1_000;
export const M1_WORKER_SETTLE_MS = 20_000;
/** Evidence files above this size are listed, not scrubbed or searched. */
export const M1_MAX_SCAN_BYTES = 64 * 1024 * 1024;
/** Tracked source the proof runs: it must be clean before and after. */
export const M1_SOURCE_PATHS = [
  "apps",
  "scripts",
  "tests",
  "packages",
  "infra",
] as const;

/**
 * Every key `<state>/stack.env` must hold so a restart that loads it verbatim
 * keeps the budget policy, the public origin and the pinned ports. The web
 * helpers (`apps/web/tests/helpers/m1-stack-env.ts`) carry the same list; the
 * names must stay identical.
 */
export const M1_REQUIRED_STACK_ENV_KEYS = [
  "BAKERY_ENV",
  "BAKERY_BUDGET_INSTALLATION_MONTHLY_LIMIT_USD",
  "BAKERY_BUDGET_RESERVATION_TTL_SECONDS",
  "BAKERY_BUDGET_MAX_RUN_DURATION_SECONDS",
  "BETTER_AUTH_SECRET",
  "BAKERY_INNGEST_EVENT_KEY",
  "INNGEST_EVENT_KEY",
  "BAKERY_INNGEST_SIGNING_KEY",
  "INNGEST_SIGNING_KEY",
  "BAKERY_PUBLIC_BASE_URL",
  "BAKERY_WEB_PORT",
  "BAKERY_SERVER_PORT",
  "BAKERY_POSTGRES_PORT",
  "BAKERY_INNGEST_PORT",
  "DATABASE_URL",
  "DOCKER_HOST",
] as const;

/** Key pairs that name one value under two spellings (compose and SDK). */
export const M1_EQUAL_STACK_ENV_PAIRS = [
  ["INNGEST_EVENT_KEY", "BAKERY_INNGEST_EVENT_KEY"],
  ["INNGEST_SIGNING_KEY", "BAKERY_INNGEST_SIGNING_KEY"],
] as const;

/** Ports compose resolves after the first start; every later call pins them. */
export const M1_RESOLVED_PORT_KEYS = [
  "BAKERY_SERVER_PORT",
  "BAKERY_POSTGRES_PORT",
  "BAKERY_INNGEST_PORT",
] as const;

/** The first-start variables: everything required before ports resolve. */
export const M1_FIRST_START_ENV_KEYS = M1_REQUIRED_STACK_ENV_KEYS.filter(
  (key) =>
    key !== "DATABASE_URL" &&
    !(M1_RESOLVED_PORT_KEYS as readonly string[]).includes(key),
);

/** Names of the files the orchestrator and the spec helpers share. */
export const M1_STATE_FILES = {
  stackEnv: "stack.env",
  billing: "billing.json",
  workerLaunch: "worker-launch.sh",
  workerKill: "worker-kill.sh",
  secretsToScan: "secrets-to-scan.txt",
  fakeDirectory: "fake",
  workerEnv: "worker.env",
  canariesJson: "canaries.json",
  canariesText: "canaries.txt",
  adapterGuards: "adapter-guards.json",
  workerHostId: "worker-host-id.txt",
  enrollmentToken: "enrollment-token",
  faultLog: "fault-log.txt",
  harnessRepository: "harness-repo",
  web: "web",
} as const;

export const M1_MANIFEST_FILE = "m1-proof-manifest.json";
export const M1_FAILURE_FILE = "m1-proof-failure.json";
const COMPOSE_FILE = "infra/compose.yaml";
const FS06_FAKE_SOURCE = "tests/fixtures/fake-harness/fake-claude-slow.sh";
const MAX_LOG_BYTES = 64 * 1024;
const DEFAULT_LOCAL_BAKERY_PASSWORD = "bakery-local-bakery";
const DEFAULT_LOCAL_APP_PASSWORD = "bakery-local-app";
/** What the child processes may inherit; nothing compose interpolates. */
const AMBIENT_ENV_NAMES = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "TMPDIR",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "DBUS_SESSION_BUS_ADDRESS",
  "DOCKER_HOST",
  "DOCKER_CONFIG",
  "PLAYWRIGHT_BROWSERS_PATH",
] as const;
const SETTLED_SPEND_SQL =
  "select coalesce(sum(settled_usd), 0)::text from bakery.budget_accounts where scope = 'installation'";

// ---- types ------------------------------------------------------------------

export type M1CommandSpec = {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly stdin?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
};

export type M1CommandResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type M1BackgroundProcess = {
  readonly stop: () => Promise<void>;
};

export type M1Runner = {
  readonly run: (spec: M1CommandSpec) => Promise<M1CommandResult>;
  readonly start: (spec: M1CommandSpec) => Promise<M1BackgroundProcess>;
};

export type M1FileSystem = {
  readonly readText: (path: string) => Promise<string>;
  readonly readBytes: (path: string) => Promise<Uint8Array>;
  readonly exists: (path: string) => Promise<boolean>;
  readonly writeText: (
    path: string,
    text: string,
    mode?: number,
  ) => Promise<void>;
  readonly makeDirectory: (path: string, mode?: number) => Promise<void>;
  /** Absolute paths of every regular file under `directory`, recursively. */
  readonly listFiles: (directory: string) => Promise<readonly string[]>;
  readonly remove: (path: string) => Promise<void>;
};

export type M1Services = {
  readonly runner: M1Runner;
  readonly fileSystem: M1FileSystem;
  /** The orchestrator's own environment; children get an allow-listed subset. */
  readonly environment: Readonly<Record<string, string>>;
  /** The checkout under proof (the working directory of every command). */
  readonly root: string;
  readonly now: () => Date;
  readonly randomHex: (bytes: number) => string;
  readonly pickPort: () => Promise<number>;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly acquireLock: (
    path: string,
    timeoutMs: number,
  ) => Promise<() => Promise<void>>;
  readonly waitForHttp: (url: string, timeoutMs: number) => Promise<void>;
  readonly lockPath: string;
  /** Files above this size are neither scrubbed nor searched (listed). */
  readonly maxScanBytes: number;
  /** Parent of the per-run state directory. */
  readonly stateRoot: string;
};

export type M1ProofOptions = {
  readonly out: string;
  readonly keepStackOnFailure?: boolean;
  readonly services?: Partial<M1Services>;
  readonly signal?: AbortSignal;
};

export type M1CommandRecord = {
  command: string;
  exitCode: number;
  outputPath: string;
};

export type M1OperatorStep = {
  name: string;
  command: string;
  exitCode: number;
};

/** What the post-run scrub covered, so nobody reads "scrubbed" as "all files". */
export type M1EvidenceScan = {
  textFilesScanned: number;
  binaryFilesSearched: number;
  /** Binary files whose bytes held a registered secret (the proof fails). */
  secretHits: string[];
  /** Files the scrub could not read (the proof fails). */
  unreadable: string[];
  notTextScanned: {
    path: string;
    kind: "trace" | "media" | "binary" | "text";
    /** `binary`: bytes searched, not rewritten. `oversize`: skipped entirely. */
    reason: "binary" | "oversize";
  }[];
  note: string;
};

export type M1AdapterGuard = {
  name: string;
  step: string;
  passed: boolean;
};

export type M1ProofManifest = {
  schema: "bakery.m1-proof/v1";
  revision: string;
  workingTreeDirty: boolean;
  composeProject: string;
  spendCapUsd: number;
  spendSettledUsd: string;
  adapters: { scriptedCoordinator: false; scriptedHarness: false };
  operatorSteps: M1OperatorStep[];
  commands: M1CommandRecord[];
  ids: Record<string, string>;
  files: { path: string; bytes: number; sha256: string }[];
  evidenceScan: M1EvidenceScan;
  cleanup: "passed";
  startedAt: string;
  finishedAt: string;
};

export type M1ProofFailure =
  & Omit<M1ProofManifest, "adapters" | "cleanup" | "spendSettledUsd">
  & {
    adapters: {
      scriptedCoordinator: boolean | null;
      scriptedHarness: boolean | null;
    };
    cleanup: "passed" | "failed" | "skipped";
    spendSettledUsd: string | null;
    /** The first failure. */
    error: string;
    failedStep: string;
    /** Every failure in order, so a later secret leak is never hidden. */
    errors: { code: string; step: string; error: string }[];
  };

export class M1ProofError extends Error {
  readonly code: string;
  readonly step: string;
  readonly detail: string;
  constructor(code: string, detail = "", step = "orchestrator") {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "M1ProofError";
    this.code = code;
    this.step = step;
    this.detail = detail;
  }
}

// ---- pure helpers -----------------------------------------------------------

export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", `'\\''`)}'`;
}

export function renderCommand(
  command: string,
  args: readonly string[],
): string {
  return [command, ...args].map(shellQuote).join(" ");
}

/**
 * One `KEY="value"` line for a systemd `EnvironmentFile`. Double quotes keep
 * leading/trailing whitespace, and `\\` and `\"` are the escapes systemd
 * understands inside them (a canary may hold a quote or a backslash).
 */
export function systemdEnvLine(key: string, value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new M1ProofError("M1_ENV_KEY_INVALID", key);
  }
  if (/[\r\n\0]/.test(value)) {
    throw new M1ProofError("M1_ENV_VALUE_INVALID", key);
  }
  return `${key}="${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/**
 * Fails closed (naming keys only, never values) unless `env` holds every
 * required key non-empty, the paired keys agree and the resolved ports are
 * real. A restart that loads such a file verbatim keeps the first-start
 * environment.
 */
export function assertStackEnvComplete(
  env: Readonly<Record<string, string>>,
): void {
  for (const key of M1_REQUIRED_STACK_ENV_KEYS) {
    if (!Object.hasOwn(env, key)) {
      throw new M1ProofError("M1_STACK_ENV_MISSING", key);
    }
    if (env[key].trim() === "") {
      throw new M1ProofError("M1_STACK_ENV_EMPTY", key);
    }
  }
  for (const [first, second] of M1_EQUAL_STACK_ENV_PAIRS) {
    if (env[first] !== env[second]) {
      throw new M1ProofError(
        "M1_STACK_ENV_PAIR_MISMATCH",
        `${first}:${second}`,
      );
    }
  }
  for (const key of [...M1_RESOLVED_PORT_KEYS, "BAKERY_WEB_PORT"] as const) {
    const port = Number(env[key]);
    if (!/^[0-9]+$/.test(env[key]) || port < 1 || port > 65_535) {
      throw new M1ProofError("M1_STACK_ENV_PORT_INVALID", key);
    }
  }
}

/** `KEY=value` per line, required keys first, no quoting, no `export`. */
export function formatStackEnv(env: Readonly<Record<string, string>>): string {
  assertStackEnvComplete(env);
  const required: readonly string[] = M1_REQUIRED_STACK_ENV_KEYS;
  const keys = [
    ...required,
    ...Object.keys(env).filter((key) => !required.includes(key)),
  ];
  return keys.map((key) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || /[\r\n]/.test(env[key])) {
      throw new M1ProofError("M1_STACK_ENV_LINE_INVALID", key);
    }
    return `${key}=${env[key]}`;
  }).join("\n") + "\n";
}

/** Decimal USD text to micro-USD, exactly (no floating point). */
export function microUsd(text: string): bigint {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!match) throw new M1ProofError("M1_USD_INVALID", "not a decimal amount");
  const fraction = (match[2] ?? "").padEnd(6, "0").slice(0, 6);
  return BigInt(match[1]) * 1_000_000n + BigInt(fraction);
}

/** Replaces every registered secret and every token or cookie shape. */
export class M1Redactor {
  readonly #secrets = new Set<string>();

  add(value: string | undefined): void {
    if (value === undefined || value.length < 6) return;
    this.#secrets.add(value);
    const escaped = JSON.stringify(value).slice(1, -1);
    if (escaped.length >= 6) this.#secrets.add(escaped);
  }

  /** True when any registered secret appears in `text`. */
  matches(text: string): boolean {
    for (const secret of this.#secrets) {
      if (text.includes(secret)) return true;
    }
    return false;
  }

  apply(text: string): string {
    let result = text;
    const secrets = [...this.#secrets].sort((a, b) => b.length - a.length);
    for (const secret of secrets) {
      result = result.split(secret).join("[REDACTED]");
    }
    return result
      .replace(/((?:set-)?cookie:\s*)[^\r\n]+/gi, "$1[REDACTED]")
      .replace(
        /(authorization:\s*(?:bearer|basic)\s+)[^\s"']+/gi,
        "$1[REDACTED]",
      )
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, "Bearer [REDACTED]")
      .replace(/(better-auth\.[A-Za-z_.-]+=)[^;\s"']+/gi, "$1[REDACTED]")
      .replace(
        /\b((?:session[_-]?)?token|secret|password|api[_-]?key)=([^\s&"']+)/gi,
        "$1=[REDACTED]",
      );
  }
}

function boundedTail(text: string, maxBytes = MAX_LOG_BYTES): string {
  const bytes = new TextEncoder().encode(text);
  return bytes.byteLength <= maxBytes
    ? text
    : new TextDecoder().decode(bytes.slice(bytes.byteLength - maxBytes));
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes as unknown as BufferSource,
  );
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function parseEnvLines(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trimEnd());
    if (match) values[match[1]] = match[2];
  }
  return values;
}

function emptyEvidenceScan(): M1EvidenceScan {
  return {
    textFilesScanned: 0,
    binaryFilesSearched: 0,
    secretHits: [],
    unreadable: [],
    notTextScanned: [],
    note: "Traces, screenshots, video and other binary files are not " +
      "text-scrubbed: their bytes were searched for the registered secrets " +
      "(a hit fails the proof) and they are hashed in files. A compressed " +
      "trace cannot be searched reliably; review it before publishing. " +
      "Files above the scan limit are neither scrubbed nor searched: they " +
      "are listed with reason oversize and hashed.",
  };
}

/** UTF-8 text without NUL bytes, or undefined for a binary file. */
function decodeUtf8Text(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function fileKind(name: string): "trace" | "media" | "binary" | "text" {
  if (/\.zip$/i.test(name)) return "trace";
  if (/\.(png|jpe?g|webp|gif|webm|mp4|mov)$/i.test(name)) return "media";
  if (/\.(log|txt|json|jsonl|ndjson|md|html|xml|csv|env)$/i.test(name)) {
    return "text";
  }
  return "binary";
}

// ---- default services -------------------------------------------------------

function signalTree(child: Deno.ChildProcess, signal: Deno.Signal): void {
  try {
    Deno.kill(-child.pid, signal);
  } catch {
    // The group may already be gone.
  }
  try {
    child.kill(signal);
  } catch {
    // The child may already be gone.
  }
}

function createDefaultRunner(): M1Runner {
  const spawn = (spec: M1CommandSpec): Deno.ChildProcess =>
    new Deno.Command("setsid", {
      args: [spec.command, ...spec.args],
      cwd: spec.cwd,
      clearEnv: true,
      env: { ...spec.env },
      stdin: spec.stdin === undefined ? "null" : "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
  return {
    run: async (spec) => {
      const child = spawn(spec);
      const stop = () => signalTree(child, "SIGTERM");
      spec.signal?.addEventListener("abort", stop, { once: true });
      const timer = spec.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
          signalTree(child, "SIGTERM");
          setTimeout(() => signalTree(child, "SIGKILL"), 10_000);
        }, spec.timeoutMs);
      try {
        if (spec.stdin !== undefined) {
          const writer = child.stdin.getWriter();
          await writer.write(new TextEncoder().encode(spec.stdin));
          await writer.close();
        }
        const result = await child.output();
        return {
          code: result.code,
          stdout: new TextDecoder().decode(result.stdout),
          stderr: new TextDecoder().decode(result.stderr),
        };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        spec.signal?.removeEventListener("abort", stop);
      }
    },
    start: (spec) => {
      const child = new Deno.Command("setsid", {
        args: [spec.command, ...spec.args],
        cwd: spec.cwd,
        clearEnv: true,
        env: { ...spec.env },
        stdin: "null",
        stdout: "null",
        stderr: "null",
      }).spawn();
      return Promise.resolve({
        stop: async () => {
          signalTree(child, "SIGTERM");
          await Promise.race([
            child.status,
            new Promise((done) => setTimeout(done, 3_000)),
          ]);
          signalTree(child, "SIGKILL");
          await Promise.race([
            child.status,
            new Promise((done) => setTimeout(done, 3_000)),
          ]);
        },
      });
    },
  };
}

async function walkFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(directory)) {
    const path = join(directory, entry.name);
    if (entry.isDirectory) files.push(...await walkFiles(path));
    else if (entry.isFile) files.push(path);
  }
  return files.sort();
}

function createDefaultFileSystem(): M1FileSystem {
  return {
    readText: (path) => Deno.readTextFile(path),
    readBytes: (path) => Deno.readFile(path),
    exists: async (path) => {
      try {
        await Deno.stat(path);
        return true;
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) return false;
        throw error;
      }
    },
    writeText: async (path, text, mode = 0o644) => {
      await Deno.mkdir(dirname(path), { recursive: true });
      await Deno.writeTextFile(path, text, { mode });
      await Deno.chmod(path, mode);
    },
    makeDirectory: async (path, mode = 0o755) => {
      await Deno.mkdir(path, { recursive: true, mode });
    },
    listFiles: walkFiles,
    remove: (path) => Deno.remove(path, { recursive: true }),
  };
}

async function acquireFileLock(
  path: string,
  timeoutMs: number,
): Promise<() => Promise<void>> {
  const file = await Deno.open(path, { create: true, write: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new M1ProofError("M1_LOCK_TIMEOUT", path)),
      timeoutMs,
    );
  });
  const locking = file.lock(true);
  locking.catch(() => {});
  try {
    await Promise.race([locking, timeout]);
  } catch (error) {
    try {
      file.close();
    } catch {
      // Closing a file with a pending lock may throw; the lock is not held.
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  return async () => {
    try {
      await file.unlock();
    } finally {
      file.close();
    }
  };
}

async function waitForHttpOk(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      await response.body?.cancel();
      if (response.ok) return;
    } catch {
      // Not up yet.
    }
    if (Date.now() >= deadline) {
      throw new M1ProofError("M1_HTTP_WAIT_TIMEOUT", url);
    }
    await new Promise((done) => setTimeout(done, 1_000));
  }
}

function defaultServices(): M1Services {
  const environment = Deno.env.toObject();
  const home = environment.HOME ?? "";
  return {
    runner: createDefaultRunner(),
    fileSystem: createDefaultFileSystem(),
    environment,
    root: Deno.cwd(),
    now: () => new Date(),
    randomHex: (bytes) =>
      [...crypto.getRandomValues(new Uint8Array(bytes))].map((byte) =>
        byte.toString(16).padStart(2, "0")
      ).join(""),
    pickPort: () => {
      const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
      const port = (listener.addr as Deno.NetAddr).port;
      listener.close();
      return Promise.resolve(port);
    },
    sleep: (milliseconds) =>
      new Promise((done) => setTimeout(done, milliseconds)),
    acquireLock: acquireFileLock,
    waitForHttp: waitForHttpOk,
    lockPath: M1_VERIFICATION_LOCK,
    maxScanBytes: M1_MAX_SCAN_BYTES,
    stateRoot: join(home, ".local", "state", "bakery-proof"),
  };
}

// ---- orchestrator -----------------------------------------------------------

type StepOptions = {
  readonly accept?: readonly number[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: string;
  readonly timeoutMs?: number;
  /** Teardown commands run even after an abort. */
  readonly ignoreAbort?: boolean;
};

class M1Orchestrator {
  readonly services: M1Services;
  readonly options: M1ProofOptions;
  readonly redactor = new M1Redactor();
  readonly commands: M1CommandRecord[] = [];
  readonly operatorSteps: M1OperatorStep[] = [];
  readonly ids: Record<string, string> = {};
  readonly out: string;
  readonly startedAt: Date;
  sequence = 0;
  currentStep = "preflight";

  // Resolved during the run.
  revision = "";
  sha8 = "";
  project = "";
  unit = "";
  state = "";
  cgroupRoot = "";
  claudeExecutable = "";
  authSourceDir = "";
  uid = "";
  spendCapUsd = M1_SPEND_CAP_LIMIT_USD;
  spendSettledUsd: string | null = null;
  workingTreeDirty = false;
  webPort = 0;
  ownerEmail = "m1-proof-owner@example.test";
  ownerPassword = "";
  canaries: string[] = [];
  stackEnv: Record<string, string> = {};
  adapters: {
    scriptedCoordinator: boolean | null;
    scriptedHarness: boolean | null;
  } = { scriptedCoordinator: null, scriptedHarness: null };
  readonly guards: M1AdapterGuard[] = [];
  learnedToken = "";
  evidenceScan: M1EvidenceScan = emptyEvidenceScan();

  // Teardown bookkeeping.
  releaseLock: (() => Promise<void>) | undefined;
  composeStarted = false;
  dispatcherContainer = "";
  preview: M1BackgroundProcess | undefined;
  workerPossiblyStarted = false;
  cgroupCreated = false;

  constructor(options: M1ProofOptions) {
    const defaults = defaultServices();
    this.options = options;
    this.services = { ...defaults, ...options.services };
    this.out = resolve(this.services.root, options.out);
    this.startedAt = this.services.now();
  }

  get env(): Readonly<Record<string, string>> {
    return this.services.environment;
  }

  get fs(): M1FileSystem {
    return this.services.fileSystem;
  }

  get composeBase(): readonly string[] {
    return ["compose", "--project-name", this.project, "-f", COMPOSE_FILE];
  }

  statePath(name: string): string {
    return join(this.state, name);
  }

  ambient(): Record<string, string> {
    const environment: Record<string, string> = {};
    for (const name of AMBIENT_ENV_NAMES) {
      const value = this.env[name];
      if (value !== undefined) environment[name] = value;
    }
    return environment;
  }

  /** The complete compose environment: ambient plus all of `stack.env`. */
  stackEnvironment(
    extra: Readonly<Record<string, string>> = {},
  ): Record<string, string> {
    return { ...this.ambient(), ...this.stackEnv, ...extra };
  }

  setStep(name: string): void {
    this.currentStep = name;
  }

  /** Runs one command, records it, and fails unless the exit code is accepted. */
  async step(
    name: string,
    command: string,
    args: readonly string[],
    options: StepOptions = {},
  ): Promise<M1CommandResult> {
    this.setStep(name);
    if (this.options.signal?.aborted && !options.ignoreAbort) {
      throw new M1ProofError("M1_ABORTED", "", name);
    }
    this.sequence += 1;
    const accept = options.accept ?? [0];
    let result: M1CommandResult;
    try {
      result = await this.services.runner.run({
        command,
        args,
        cwd: options.cwd ?? this.services.root,
        env: options.env ?? this.ambient(),
        ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
        ...(options.timeoutMs === undefined
          ? {}
          : { timeoutMs: options.timeoutMs }),
        ...(options.ignoreAbort || !this.options.signal
          ? {}
          : { signal: this.options.signal }),
      });
    } catch (error) {
      throw new M1ProofError(
        "M1_COMMAND_UNSPAWNABLE",
        `${command}: ${errorMessage(error)}`,
        name,
      );
    }
    const rendered = this.redactor.apply(renderCommand(command, args));
    const logPath = join(
      this.out,
      "commands",
      `${String(this.sequence).padStart(2, "0")}-${name}.log`,
    );
    const text = [
      `$ ${rendered}`,
      `[exit ${result.code}]`,
      "--- stdout ---",
      boundedTail(this.redactor.apply(result.stdout)),
      "--- stderr ---",
      boundedTail(this.redactor.apply(result.stderr)),
      "",
    ].join("\n");
    await this.fs.writeText(logPath, text);
    this.commands.push({
      command: rendered,
      exitCode: result.code,
      outputPath: relative(this.out, logPath),
    });
    if (!accept.includes(result.code)) {
      throw new M1ProofError(
        "M1_STEP_FAILED",
        `${name} exited ${result.code}`,
        name,
      );
    }
    return result;
  }

  // -- preflight --------------------------------------------------------------

  async preflight(): Promise<void> {
    this.setStep("preflight");
    const dockerHost = this.env.DOCKER_HOST?.trim();
    if (!dockerHost) throw new M1ProofError("M1_DOCKER_HOST_REQUIRED");
    const home = this.env.HOME?.trim();
    if (!home) throw new M1ProofError("M1_HOME_REQUIRED");
    this.spendCapUsd = readSpendCap(this.env.BAKERY_M1_SPEND_CAP_USD);

    const head = await this.step("git-head-before", "git", [
      "rev-parse",
      "HEAD",
    ]);
    this.revision = head.stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(this.revision)) {
      throw new M1ProofError("M1_REVISION_INVALID");
    }
    this.sha8 = this.revision.slice(0, 8);
    this.project = `bakery-m1-${this.sha8}`;
    this.unit = `${this.project}-worker`;
    this.state = join(this.services.stateRoot, `m1-${this.sha8}`);

    const dirty = await this.step("git-status-sources", "git", [
      "status",
      "--porcelain",
      "--",
      ...M1_SOURCE_PATHS,
    ]);
    if (dirty.stdout.trim() !== "") {
      throw new M1ProofError(
        "M1_DIRTY_TREE",
        "commit or stash before the proof",
      );
    }

    this.authSourceDir = this.env.BAKERY_CLAUDE_AUTH_SOURCE_DIR?.trim() ||
      join(home, ".claude");
    if (!await this.fs.exists(join(this.authSourceDir, ".credentials.json"))) {
      throw new M1ProofError("M1_CLAUDE_LOGIN_MISSING");
    }
    const configured = this.env.BAKERY_CLAUDE_HARNESS_EXECUTABLE?.trim();
    if (configured) {
      this.claudeExecutable = configured;
    } else {
      const located = await this.step("claude-path", "sh", [
        "-c",
        "command -v claude",
      ], { accept: [0, 1] });
      this.claudeExecutable = located.stdout.trim();
    }
    if (!this.claudeExecutable.startsWith("/")) {
      throw new M1ProofError(
        "M1_CLAUDE_UNAVAILABLE",
        "no absolute claude path",
      );
    }
    try {
      await this.step("claude-version", this.claudeExecutable, ["--version"]);
    } catch (error) {
      if (
        error instanceof M1ProofError &&
        (error.code === "M1_STEP_FAILED" ||
          error.code === "M1_COMMAND_UNSPAWNABLE")
      ) {
        throw new M1ProofError(
          "M1_CLAUDE_UNAVAILABLE",
          error.message,
          "claude-version",
        );
      }
      throw error;
    }

    const identity = await this.step("uid", "id", ["-u"]);
    this.uid = identity.stdout.trim();
    if (!/^\d+$/.test(this.uid)) throw new M1ProofError("M1_UID_INVALID");

    this.setStep("lock");
    this.releaseLock = await this.services.acquireLock(
      this.services.lockPath,
      M1_LOCK_TIMEOUT_MS,
    );

    this.setStep("memory");
    const meminfo = await this.fs.readText("/proc/meminfo");
    const available = /MemAvailable:\s+(\d+)\s+kB/.exec(meminfo);
    if (!available || Number(available[1]) < M1_MIN_MEM_AVAILABLE_KB) {
      throw new M1ProofError(
        "M1_MEMORY_LOW",
        `MemAvailable ${
          available?.[1] ?? "unknown"
        } kB, need ${M1_MIN_MEM_AVAILABLE_KB}`,
      );
    }

    const existing = await this.step("docker-project-absent", "docker", [
      "ps",
      "-a",
      "-q",
      "--filter",
      `label=com.docker.compose.project=${this.project}`,
    ]);
    if (existing.stdout.trim() !== "") {
      throw new M1ProofError("M1_PROJECT_EXISTS", this.project);
    }
    if (await this.fs.exists(this.state)) {
      const stamp = this.services.now().toISOString().replaceAll(/[-:.]/g, "");
      await this.step("state-dir-backup", "mv", [
        this.state,
        `${this.state}.bak-${stamp}`,
      ]);
    }
  }

  // -- stack ------------------------------------------------------------------

  async bootStack(): Promise<void> {
    const { randomHex } = this.services;
    this.webPort = await this.services.pickPort();
    const authSecret = `m1-${randomHex(24)}`;
    const eventKey = `m1-event-${randomHex(12)}`;
    const signingKey = randomHex(32);
    this.ownerPassword = `M1-Proof-${randomHex(12)}-Aa1`;
    this.canaries = [randomHex(16), `m1"q\\${randomHex(12)}`];
    for (
      const secret of [
        authSecret,
        eventKey,
        signingKey,
        this.ownerPassword,
        DEFAULT_LOCAL_BAKERY_PASSWORD,
        DEFAULT_LOCAL_APP_PASSWORD,
        ...this.canaries,
      ]
    ) this.redactor.add(secret);

    const limit = String(this.spendCapUsd);
    const firstStart: Record<string, string> = {
      BAKERY_ENV: "development",
      BAKERY_BUDGET_INSTALLATION_MONTHLY_LIMIT_USD: limit,
      BAKERY_BUDGET_RESERVATION_TTL_SECONDS: "3600",
      BAKERY_BUDGET_MAX_RUN_DURATION_SECONDS: "86400",
      BETTER_AUTH_SECRET: authSecret,
      BAKERY_INNGEST_EVENT_KEY: eventKey,
      INNGEST_EVENT_KEY: eventKey,
      BAKERY_INNGEST_SIGNING_KEY: signingKey,
      INNGEST_SIGNING_KEY: signingKey,
      BAKERY_PUBLIC_BASE_URL: `http://127.0.0.1:${this.webPort}`,
      BAKERY_WEB_PORT: String(this.webPort),
      DOCKER_HOST: this.env.DOCKER_HOST!.trim(),
    };
    for (const key of M1_FIRST_START_ENV_KEYS) {
      if (!Object.hasOwn(firstStart, key)) {
        throw new M1ProofError("M1_FIRST_START_ENV_INCOMPLETE", key);
      }
    }

    this.setStep("state-dir");
    await this.fs.makeDirectory(this.state, 0o700);

    // Teardown after a failed start needs the same environment compose-down.sh
    // interpolates (BETTER_AUTH_SECRET): keep it on the instance first.
    this.stackEnv = { ...firstStart };
    this.composeStarted = true;
    const up = await this.step("compose-up", "bash", [
      "scripts/dev/compose-up.sh",
      this.project,
      "postgres",
      "redis",
      "inngest",
      "migrate",
      "server",
    ], { env: { ...this.ambient(), ...firstStart } });
    const resolved = parseEnvLines(up.stdout);
    for (const key of M1_RESOLVED_PORT_KEYS) {
      const value = resolved[key];
      if (!value || !/^[0-9]+$/.test(value) || Number(value) < 1) {
        throw new M1ProofError("M1_PORT_UNRESOLVED", key);
      }
    }
    const serverPort = resolved.BAKERY_SERVER_PORT;
    const postgresPort = resolved.BAKERY_POSTGRES_PORT;
    const inngestPort = resolved.BAKERY_INNGEST_PORT;
    this.stackEnv = {
      ...firstStart,
      BAKERY_SERVER_PORT: serverPort,
      BAKERY_POSTGRES_PORT: postgresPort,
      BAKERY_INNGEST_PORT: inngestPort,
      DATABASE_URL:
        `postgres://bakery:${DEFAULT_LOCAL_BAKERY_PASSWORD}@127.0.0.1:${postgresPort}/bakery`,
      BAKERY_SERVER_HOST: "127.0.0.1",
      BAKERY_APP_DATABASE_URL:
        `postgres://bakery_app:${DEFAULT_LOCAL_APP_PASSWORD}@127.0.0.1:${postgresPort}/bakery`,
      INNGEST_URL: `http://127.0.0.1:${inngestPort}`,
    };
    this.setStep("stack-env");
    await this.fs.writeText(
      this.statePath(M1_STATE_FILES.stackEnv),
      formatStackEnv(this.stackEnv),
      0o600,
    );
    Object.assign(this.ids, {
      stateDir: this.state,
      webPort: String(this.webPort),
      serverPort,
      postgresPort,
      inngestPort,
      workerUnit: this.unit,
    });

    const serverContainer = await this.serverContainerId("compose-ps-server");
    this.ids.serverContainerAtStart = serverContainer;
    this.ids.serverDockerPort = await this.dockerPort(
      "docker-port-before",
      serverContainer,
    );

    const dispatcher = await this.step("dispatcher-start", "docker", [
      ...this.composeBase,
      "run",
      "-d",
      "--no-deps",
      "-e",
      "INNGEST_EVENT_KEY",
      "server",
      "sh",
      "-eu",
      "-c",
      'export BAKERY_APP_DATABASE_URL="postgres://bakery_app:$BAKERY_LOCAL_APP_PASSWORD@postgres:5432/bakery"; exec deno run --allow-env --allow-net apps/server/src/dispatch.ts',
    ], { env: this.stackEnvironment() });
    this.dispatcherContainer = dispatcher.stdout.trim().split("\n").at(-1)
      ?.trim() ?? "";
    if (!this.dispatcherContainer) {
      throw new M1ProofError("M1_DISPATCHER_MISSING");
    }
    this.ids.dispatcherContainer = this.dispatcherContainer;
    await this.services.sleep(3_000);
    const running = await this.step("dispatcher-running", "docker", [
      "inspect",
      "-f",
      "{{.State.Running}}",
      this.dispatcherContainer,
    ]);
    if (running.stdout.trim() !== "true") {
      throw new M1ProofError("M1_DISPATCHER_NOT_RUNNING");
    }

    await this.serverAdapterGuard();

    await this.step("pricing-snapshot", "docker", [
      ...this.composeBase,
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "bakery",
      "-d",
      "bakery",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      pricingSnapshotSql(),
    ], { env: this.stackEnvironment() });
    this.operatorSteps.push({
      name: "pricing-snapshot",
      command: pricingSnapshotSql(),
      exitCode: 0,
    });

    this.setStep("server-ready");
    await this.services.waitForHttp(
      `http://127.0.0.1:${serverPort}/health/ready`,
      120_000,
    );

    await this.step("web-build", "pnpm", [
      "--dir",
      "apps/web",
      "exec",
      "vite",
      "build",
      "--outDir",
      this.statePath(M1_STATE_FILES.web),
      "--emptyOutDir",
    ]);
    this.setStep("web-preview");
    this.preview = await this.services.runner.start({
      command: "pnpm",
      args: [
        "--dir",
        "apps/web",
        "exec",
        "vite",
        "preview",
        "--outDir",
        this.statePath(M1_STATE_FILES.web),
        "--host",
        "127.0.0.1",
        "--port",
        String(this.webPort),
        "--strictPort",
      ],
      cwd: this.services.root,
      env: {
        ...this.ambient(),
        BAKERY_SERVER_HOST: "127.0.0.1",
        BAKERY_SERVER_PORT: serverPort,
        BAKERY_WEB_PORT: String(this.webPort),
      },
    });
    this.commands.push({
      command: renderCommand("pnpm", [
        "--dir",
        "apps/web",
        "exec",
        "vite",
        "preview",
        "--outDir",
        this.statePath(M1_STATE_FILES.web),
        "--host",
        "127.0.0.1",
        "--port",
        String(this.webPort),
        "--strictPort",
      ]),
      exitCode: 0,
      outputPath: "(background process, no captured output)",
    });
    await this.services.waitForHttp(
      `http://127.0.0.1:${this.webPort}/`,
      60_000,
    );
  }

  /**
   * The server's current container. The first restart recreates it (compose's
   * config hash differs between the floating and the resolved port), so the id
   * is looked up at every check, never kept.
   */
  async serverContainerId(name: string): Promise<string> {
    const result = await this.step(name, "docker", [
      ...this.composeBase,
      "ps",
      "-q",
      "server",
    ], { env: this.stackEnvironment() });
    const id = result.stdout.trim().split("\n")[0]?.trim() ?? "";
    if (!id) throw new M1ProofError("M1_SERVER_CONTAINER_MISSING", "", name);
    return id;
  }

  async dockerPort(name: string, container: string): Promise<string> {
    const result = await this.step(name, "docker", ["port", container]);
    return result.stdout.trim().split("\n").map((line) => line.trim()).sort()
      .join(";");
  }

  /** The server's running environment must not carry a scripted adapter. */
  async serverAdapterGuard(): Promise<void> {
    const result = await this.step("guard-server-env", "docker", [
      ...this.composeBase,
      "exec",
      "-T",
      "server",
      "sh",
      "-c",
      "tr '\\0' '\\n' < /proc/1/environ | grep -E '^(BAKERY_SCRIPTED_COORDINATOR_DIR|BAKERY_COORDINATOR_EXECUTOR|BAKERY_ENV)=' || true",
    ], { env: this.stackEnvironment() });
    const values = parseEnvLines(result.stdout);
    // Compose always sets the scripted directory to the empty string.
    if ((values.BAKERY_SCRIPTED_COORDINATOR_DIR ?? "") !== "") {
      throw new M1ProofError(
        "M1_SCRIPTED_COORDINATOR_PRESENT",
        "the server runs with BAKERY_SCRIPTED_COORDINATOR_DIR set",
        "guard-server-env",
      );
    }
    if (values.BAKERY_ENV !== "development") {
      throw new M1ProofError(
        "M1_SERVER_ENV_UNEXPECTED",
        `BAKERY_ENV is ${values.BAKERY_ENV ?? "unset"}`,
        "guard-server-env",
      );
    }
    if (
      values.BAKERY_COORDINATOR_EXECUTOR !== undefined &&
      values.BAKERY_COORDINATOR_EXECUTOR !== "" &&
      values.BAKERY_COORDINATOR_EXECUTOR !== "worker"
    ) {
      throw new M1ProofError(
        "M1_COORDINATOR_EXECUTOR_UNEXPECTED",
        values.BAKERY_COORDINATOR_EXECUTOR,
        "guard-server-env",
      );
    }
    this.adapters.scriptedCoordinator = false;
    this.guards.push({
      name: "server-env",
      step: "guard-server-env",
      passed: true,
    });
  }

  /**
   * The worker unit's environment must not carry a scripted harness. The unit
   * must be active at both call sites: the journey ends with it running, and
   * the restarted fake-executable worker has just been started.
   */
  async workerRuntimeGuard(label: string): Promise<void> {
    const active = await this.step(
      `guard-worker-active-${label}`,
      "systemctl",
      ["--user", "is-active", this.unit],
      { accept: [0, 1, 3, 4] },
    );
    if (active.code !== 0) {
      throw new M1ProofError(
        "M1_WORKER_NOT_ACTIVE",
        this.unit,
        `guard-worker-active-${label}`,
      );
    }
    const pid = await this.step(`guard-worker-pid-${label}`, "systemctl", [
      "--user",
      "show",
      "-p",
      "MainPID",
      "--value",
      this.unit,
    ]);
    const mainPid = pid.stdout.trim();
    if (!/^[1-9][0-9]*$/.test(mainPid)) {
      throw new M1ProofError("M1_WORKER_PID_INVALID", mainPid);
    }
    const result = await this.step(`guard-worker-env-${label}`, "sh", [
      "-c",
      `tr '\\0' '\\n' < /proc/${mainPid}/environ | grep -E '^(BAKERY_WORKER_SCRIPTED_HARNESS_DIR|BAKERY_ENV)=' || true`,
    ]);
    const values = parseEnvLines(result.stdout);
    if ((values.BAKERY_WORKER_SCRIPTED_HARNESS_DIR ?? "") !== "") {
      throw new M1ProofError(
        "M1_SCRIPTED_HARNESS_PRESENT",
        "the worker runs with BAKERY_WORKER_SCRIPTED_HARNESS_DIR set",
        `guard-worker-env-${label}`,
      );
    }
    if (values.BAKERY_ENV !== "development") {
      throw new M1ProofError(
        "M1_WORKER_ENV_UNEXPECTED",
        `BAKERY_ENV is ${values.BAKERY_ENV ?? "unset"}`,
        `guard-worker-env-${label}`,
      );
    }
    this.guards.push({
      name: `worker-${label}`,
      step: `guard-worker-env-${label}`,
      passed: true,
    });
  }

  // -- host: harness clone, worker files -------------------------------------

  workerEnvText(executable: string): string {
    const environment = this.env;
    const lines: [string, string][] = [
      ["PATH", environment.PATH ?? "/usr/bin:/bin"],
      ["HOME", environment.HOME!],
      ["BAKERY_ENV", "development"],
      [
        "BAKERY_SERVER_URL",
        `http://127.0.0.1:${this.stackEnv.BAKERY_SERVER_PORT}`,
      ],
      ["BAKERY_WORKER_NAME", "m1-claude-worker"],
      ["BAKERY_WORKER_CAPABILITIES", "git,shell,web,model"],
      ["BAKERY_WORKER_SLOTS", "1"],
      ["BAKERY_WORKER_STATE_DIR", this.statePath("worker-state")],
      [
        "BAKERY_WORKER_ENROLLMENT_TOKEN_FILE",
        this.statePath(M1_STATE_FILES.enrollmentToken),
      ],
      ["BAKERY_WORKER_CGROUP_ROOT", this.cgroupRoot],
      [
        "BAKERY_WORKER_OUTPUT_REDACTION_SECRETS",
        JSON.stringify(this.canaries),
      ],
      ["BAKERY_CLAUDE_HARNESS", "1"],
      [
        "BAKERY_CLAUDE_HARNESS_REPOSITORY",
        this.statePath(M1_STATE_FILES.harnessRepository),
      ],
      ["BAKERY_CLAUDE_HARNESS_EXECUTABLE", executable],
      ["BAKERY_CLAUDE_HARNESS_MODEL", M1_PROOF_MODEL],
      ["BAKERY_CLAUDE_HARNESS_EFFORT", "high"],
      ["BAKERY_CLAUDE_HARNESS_TIME_LIMIT_MS", "900000"],
      ["BAKERY_CLAUDE_COORDINATOR_EFFORT", "medium"],
      ["BAKERY_CLAUDE_COORDINATOR_TIME_LIMIT_MS", "300000"],
      ["BAKERY_CLAUDE_AUTH_SOURCE_DIR", this.authSourceDir],
    ];
    return lines.map(([key, value]) => systemdEnvLine(key, value)).join("\n") +
      "\n";
  }

  launchScript(): string {
    const clone = this.statePath(M1_STATE_FILES.harnessRepository);
    return [
      "#!/usr/bin/env bash",
      "# Generated by scripts/evidence/prove-m1.ts. Resets the harness clone to",
      "# the candidate revision and starts the worker unit from worker.env.",
      "set -euo pipefail",
      'export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"',
      `unit=${shellQuote(this.unit)}`,
      `state=${shellQuote(this.state)}`,
      `repo=${shellQuote(clone)}`,
      `git -C "$repo" reset --hard ${shellQuote(this.revision)}`,
      'git -C "$repo" clean -fdx',
      'cp "$state/canaries.txt" "$repo/.bakery-canary"',
      'systemctl --user stop "$unit" 2>/dev/null || true',
      'systemctl --user reset-failed "$unit" 2>/dev/null || true',
      `exec systemd-run --user --unit "$unit" --collect --quiet --working-directory=${
        shellQuote(join(this.services.root, "apps", "worker"))
      } --property=EnvironmentFile="$state/${M1_STATE_FILES.workerEnv}" bash scripts/run-worker.sh`,
      "",
    ].join("\n");
  }

  killScript(): string {
    return [
      "#!/usr/bin/env bash",
      "# Generated by scripts/evidence/prove-m1.ts. Kills every process of the",
      "# worker unit (the harness child included) and removes the unit.",
      "set -uo pipefail",
      'export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"',
      `unit=${shellQuote(this.unit)}`,
      'systemctl --user kill --kill-whom=all --signal=SIGKILL "$unit" 2>/dev/null || true',
      'systemctl --user stop "$unit" 2>/dev/null || true',
      'systemctl --user reset-failed "$unit" 2>/dev/null || true',
      "exit 0",
      "",
    ].join("\n");
  }

  secretsToScanText(extra: readonly string[] = []): string {
    const lines = new Set<string>();
    for (
      const secret of [
        ...this.canaries,
        this.ownerPassword,
        this.stackEnv.BETTER_AUTH_SECRET,
        this.stackEnv.BAKERY_INNGEST_EVENT_KEY,
        this.stackEnv.BAKERY_INNGEST_SIGNING_KEY,
        ...extra,
      ]
    ) {
      lines.add(secret);
      lines.add(JSON.stringify(secret).slice(1, -1));
    }
    return [...lines].join("\n") + "\n";
  }

  async prepareHost(): Promise<void> {
    const clone = this.statePath(M1_STATE_FILES.harnessRepository);
    await this.step("harness-clone", "git", [
      "clone",
      "--no-hardlinks",
      "--no-checkout",
      this.services.root,
      clone,
    ]);
    await this.step("harness-checkout", "git", [
      "-C",
      clone,
      "checkout",
      "--detach",
      this.revision,
    ]);
    const head = await this.step("harness-head", "git", [
      "-C",
      clone,
      "rev-parse",
      "HEAD",
    ]);
    if (head.stdout.trim() !== this.revision) {
      throw new M1ProofError("M1_HARNESS_CLONE_REVISION_MISMATCH");
    }
    this.ids.harnessRepoHead = this.revision;
    await this.step("harness-exclude", "sh", [
      "-c",
      `printf '%s\\n' .bakery-canary >> ${
        shellQuote(join(clone, ".git", "info", "exclude"))
      }`,
    ]);

    this.setStep("host-files");
    await this.fs.writeText(
      this.statePath(M1_STATE_FILES.canariesJson),
      JSON.stringify(this.canaries) + "\n",
      0o600,
    );
    await this.fs.writeText(
      this.statePath(M1_STATE_FILES.canariesText),
      this.canaries.join("\n") + "\n",
      0o600,
    );
    await this.fs.writeText(
      this.statePath(M1_STATE_FILES.secretsToScan),
      this.secretsToScanText(),
      0o600,
    );
    await this.fs.writeText(
      this.statePath(M1_STATE_FILES.billing),
      JSON.stringify(billingFile(), null, 2) + "\n",
    );
    this.cgroupRoot =
      `/sys/fs/cgroup/user.slice/user-${this.uid}.slice/user@${this.uid}.service/app.slice/${this.project}`;
    this.cgroupCreated = true;
    await this.step("cgroup-root", "mkdir", [this.cgroupRoot]);
    await this.step("cgroup-controllers", "sh", [
      "-c",
      `echo '+cpu +memory +pids' > ${
        shellQuote(join(this.cgroupRoot, "cgroup.subtree_control"))
      }`,
    ]);
    this.ids.cgroupRoot = this.cgroupRoot;
    this.ids.claudeExecutable = this.claudeExecutable;
    await this.fs.writeText(
      this.statePath(M1_STATE_FILES.workerEnv),
      this.workerEnvText(this.claudeExecutable),
      0o600,
    );
    await this.fs.writeText(
      this.statePath(M1_STATE_FILES.workerLaunch),
      this.launchScript(),
      0o700,
    );
    await this.fs.writeText(
      this.statePath(M1_STATE_FILES.workerKill),
      this.killScript(),
      0o700,
    );

    // Static worker guard: the exact file the launcher loads. The running
    // process is checked again once the spec has started the worker.
    this.setStep("guard-worker-file");
    const workerEnvText = await this.fs.readText(
      this.statePath(M1_STATE_FILES.workerEnv),
    );
    if (/^BAKERY_WORKER_SCRIPTED_HARNESS_DIR=/m.test(workerEnvText)) {
      throw new M1ProofError(
        "M1_SCRIPTED_HARNESS_PRESENT",
        "worker.env names BAKERY_WORKER_SCRIPTED_HARNESS_DIR",
        "guard-worker-file",
      );
    }
    this.guards.push({
      name: "worker-file",
      step: "guard-worker-file",
      passed: true,
    });
    await this.writeAdapterGuards();
  }

  async writeAdapterGuards(): Promise<void> {
    const text = JSON.stringify(
      {
        schema: "bakery.m1-adapter-guards/v1",
        scriptedCoordinator: this.adapters.scriptedCoordinator,
        scriptedHarness: this.adapters.scriptedHarness,
        guards: this.guards,
        serverEnvironment: "development",
        note:
          "scriptedHarness stays null until the running worker has been checked",
      },
      null,
      2,
    ) + "\n";
    await this.fs.writeText(this.statePath(M1_STATE_FILES.adapterGuards), text);
  }

  // -- legs -------------------------------------------------------------------

  specEnvironment(
    extra: Readonly<Record<string, string>>,
  ): Record<string, string> {
    return this.stackEnvironment({
      BAKERY_REAL_API: "1",
      BAKERY_REAL_EMAIL: this.ownerEmail,
      BAKERY_REAL_PASSWORD: this.ownerPassword,
      BASE_URL: `http://127.0.0.1:${this.webPort}`,
      ...extra,
    });
  }

  async journeyLeg(): Promise<void> {
    const stopAfter = this.env.BAKERY_M1_STOP_AFTER?.trim();
    this.workerPossiblyStarted = true;
    try {
      await this.step("playwright-journey", "pnpm", [
        "--dir",
        "apps/web",
        "exec",
        "playwright",
        "test",
        "--project=desktop-real-m1",
        "--workers=1",
        "--output",
        join(this.out, "playwright", "journey"),
      ], {
        env: this.specEnvironment({
          BAKERY_REAL_API_M1: "1",
          BAKERY_M1_STATE_DIR: this.state,
          BAKERY_M1_COMPOSE_PROJECT: this.project,
          BAKERY_M1_SPEND_CAP_USD: String(this.spendCapUsd),
          BAKERY_M1_CANARIES_FILE: this.statePath(M1_STATE_FILES.canariesJson),
          BAKERY_M1_HARNESS_REPO: this.statePath(
            M1_STATE_FILES.harnessRepository,
          ),
          BAKERY_M1_SHOTS: join(this.out, "journey"),
          ...(stopAfter ? { BAKERY_M1_STOP_AFTER: stopAfter } : {}),
        }),
        timeoutMs: M1_JOURNEY_TIMEOUT_MS,
      });
    } finally {
      // The spec writes the token even when it later fails; learn it on every
      // path so the failure record and the scrub know it.
      await this.learnEnrollmentToken().catch(() => {});
    }
    if (stopAfter) {
      throw new M1ProofError(
        "M1_PARTIAL_RUN",
        `BAKERY_M1_STOP_AFTER=${stopAfter} proves nothing; no manifest`,
        "playwright-journey",
      );
    }

    this.setStep("journey-collect");
    const hostId = await this.readWorkerHostId();
    this.ids.workerHostId = hostId;
    await this.workerRuntimeGuard("journey");
    await this.writeAdapterGuards();
    await this.checkServerPort("docker-port-journey");
    await this.checkSpend("spend-after-journey");
  }

  /**
   * Registers the enrollment token the spec wrote with the redactor and the
   * scan list as soon as it exists. Safe to call on every path.
   */
  async learnEnrollmentToken(): Promise<void> {
    if (this.state === "") return;
    const path = this.statePath(M1_STATE_FILES.enrollmentToken);
    if (!await this.fs.exists(path)) return;
    const token = (await this.fs.readText(path)).trim();
    if (token === "" || token === this.learnedToken) return;
    this.learnedToken = token;
    this.redactor.add(token);
    const scanList = this.statePath(M1_STATE_FILES.secretsToScan);
    if (await this.fs.exists(scanList)) {
      await this.fs.writeText(scanList, this.secretsToScanText([token]), 0o600);
    }
  }

  async readWorkerHostId(): Promise<string> {
    const path = this.statePath(M1_STATE_FILES.workerHostId);
    if (!await this.fs.exists(path)) {
      throw new M1ProofError("M1_WORKER_HOST_ID_MISSING", path);
    }
    const hostId = (await this.fs.readText(path)).trim();
    if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(hostId)) {
      throw new M1ProofError("M1_WORKER_HOST_ID_INVALID");
    }
    return hostId;
  }

  async regressionLeg(): Promise<void> {
    const hostId = await this.readWorkerHostId();
    await this.step("worker-stop-journey", "bash", [
      this.statePath(M1_STATE_FILES.workerKill),
    ]);

    this.setStep("fake-executable");
    const fakeDirectory = this.statePath(M1_STATE_FILES.fakeDirectory);
    const fakeExecutable = join(fakeDirectory, "fake-claude-slow.sh");
    const counter = join(fakeDirectory, "counter.txt");
    await this.fs.makeDirectory(fakeDirectory, 0o700);
    await this.fs.writeText(
      fakeExecutable,
      await this.fs.readText(join(this.services.root, FS06_FAKE_SOURCE)),
      0o755,
    );
    await this.fs.writeText(
      join(fakeDirectory, "fs06-fake.conf"),
      `FS06_FAKE_COUNTER=${shellQuote(counter)}\n`,
      0o600,
    );
    // Same unit, same state dir and registration; only the executable changes.
    await this.fs.writeText(
      this.statePath(M1_STATE_FILES.workerEnv),
      this.workerEnvText(fakeExecutable),
      0o600,
    );
    await this.step("worker-start-fake", "bash", [
      this.statePath(M1_STATE_FILES.workerLaunch),
    ]);
    await this.services.sleep(M1_WORKER_SETTLE_MS);
    await this.workerRuntimeGuard("regression");
    this.adapters.scriptedHarness = false;
    await this.writeAdapterGuards();

    await this.step("playwright-fs06", "pnpm", [
      "--dir",
      "apps/web",
      "exec",
      "playwright",
      "test",
      "run-observation-real-harness.spec",
      "--project=desktop-real-harness",
      "--workers=1",
      "--output",
      join(this.out, "playwright", "fs06"),
    ], {
      env: this.specEnvironment({
        BAKERY_REAL_API_HARNESS: "1",
        BAKERY_FS06_MODE: "start",
        BAKERY_FS06_HARNESS: "fake",
        BAKERY_FS06_CANARIES_FILE: this.statePath(M1_STATE_FILES.canariesJson),
        BAKERY_FS06_HARNESS_REPO: this.statePath(
          M1_STATE_FILES.harnessRepository,
        ),
        BAKERY_FS06_WORKER_HOST_ID: hostId,
        BAKERY_FS06_SHOTS: join(this.out, "fs06"),
      }),
      timeoutMs: M1_REGRESSION_TIMEOUT_MS,
    });
    await this.checkSpend("spend-after-regression");
  }

  async checkServerPort(name: string): Promise<void> {
    const before = this.ids.serverDockerPort;
    const container = await this.serverContainerId(`${name}-container`);
    const after = await this.dockerPort(name, container);
    if (after !== before) {
      throw new M1ProofError(
        "M1_SERVER_PORT_DRIFT",
        `docker port changed from ${before} to ${after}`,
        name,
      );
    }
  }

  async checkSpend(name: string): Promise<void> {
    const result = await this.step(name, "docker", [
      ...this.composeBase,
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "bakery",
      "-d",
      "bakery",
      "-v",
      "ON_ERROR_STOP=1",
      "-Atqc",
      SETTLED_SPEND_SQL,
    ], { env: this.stackEnvironment() });
    const settled = result.stdout.trim().split("\n").at(-1)?.trim() ?? "";
    this.spendSettledUsd = settled;
    if (microUsd(settled) > BigInt(Math.round(this.spendCapUsd * 1_000_000))) {
      throw new M1ProofError(
        "M1_SPEND_CAP_REACHED",
        `settled ${settled} USD above cap ${this.spendCapUsd}`,
        name,
      );
    }
  }

  // -- finalize and teardown --------------------------------------------------

  async collectEvidence(): Promise<void> {
    this.setStep("collect-evidence");
    const copies: readonly [string, string][] = [
      [M1_STATE_FILES.faultLog, join("journey", "fault-log.txt")],
      [M1_STATE_FILES.adapterGuards, "adapter-guards.json"],
      [
        join(M1_STATE_FILES.fakeDirectory, "counter.txt"),
        join("fs06", "fake-counter.txt"),
      ],
    ];
    for (const [source, target] of copies) {
      const path = this.statePath(source);
      if (await this.fs.exists(path)) {
        await this.fs.writeText(
          join(this.out, target),
          this.redactor.apply(await this.fs.readText(path)),
        );
      }
    }
    const faultLogPath = this.statePath(M1_STATE_FILES.faultLog);
    if (await this.fs.exists(faultLogPath)) {
      for (const line of (await this.fs.readText(faultLogPath)).split("\n")) {
        const step = parseOperatorStepLine(line);
        if (step === undefined) continue;
        this.operatorSteps.push({
          name: step.name,
          command: this.redactor.apply(step.command),
          exitCode: step.exitCode,
        });
      }
    }
    const idsPath = join(this.out, "journey", "ids.json");
    if (await this.fs.exists(idsPath)) {
      const parsed: unknown = JSON.parse(await this.fs.readText(idsPath));
      if (
        parsed === null || typeof parsed !== "object" || Array.isArray(parsed)
      ) {
        throw new M1ProofError("M1_JOURNEY_IDS_INVALID");
      }
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value !== "string") {
          throw new M1ProofError("M1_JOURNEY_IDS_INVALID", key);
        }
        this.ids[`journey.${key}`] = value;
      }
    }
  }

  async finalize(): Promise<string> {
    await this.collectEvidence();
    await this.checkServerPort("docker-port-after");
    await this.checkSpend("spend-final");
    const headAfter = await this.step("git-head-after", "git", [
      "rev-parse",
      "HEAD",
    ]);
    const revisionAfter = headAfter.stdout.trim();
    if (revisionAfter !== this.revision) {
      throw new M1ProofError(
        "M1_REVISION_CHANGED",
        `${this.revision} became ${revisionAfter} during the run`,
      );
    }
    const sources = await this.step("git-status-sources-after", "git", [
      "status",
      "--porcelain",
      "--",
      ...M1_SOURCE_PATHS,
    ]);
    if (sources.stdout.trim() !== "") {
      throw new M1ProofError("M1_DIRTY_TREE_AFTER_RUN");
    }
    const full = await this.step("git-status-after", "git", [
      "status",
      "--porcelain",
    ]);
    this.workingTreeDirty = full.stdout.split("\n").some((line) =>
      line.trim() !== "" && !line.slice(3).startsWith(".agents/")
    );
    return revisionAfter;
  }

  /** Best-effort teardown; returns "passed" only when nothing failed. */
  async teardown(): Promise<"passed" | "failed"> {
    const failures: string[] = [];
    const attempt = async (
      name: string,
      body: () => Promise<void>,
    ): Promise<void> => {
      try {
        await body();
      } catch (error) {
        failures.push(`${name}: ${errorMessage(error)}`);
      }
    };
    const stateExists = this.state !== "" && await this.fs.exists(this.state);
    if (this.workerPossiblyStarted || stateExists) {
      await attempt("worker-stop", async () => {
        if (await this.fs.exists(this.statePath(M1_STATE_FILES.workerKill))) {
          await this.step("teardown-worker-stop", "bash", [
            this.statePath(M1_STATE_FILES.workerKill),
          ], { ignoreAbort: true });
        }
      });
    }
    await attempt("preview-stop", async () => {
      await this.preview?.stop();
      this.preview = undefined;
    });
    if (this.composeStarted) {
      await attempt("dispatcher-remove", async () => {
        if (this.dispatcherContainer) {
          await this.step("teardown-dispatcher-remove", "docker", [
            "rm",
            "-f",
            this.dispatcherContainer,
          ], { accept: [0, 1], ignoreAbort: true });
        }
      });
      await attempt("compose-down", async () => {
        await this.step("teardown-compose-down", "bash", [
          "scripts/dev/compose-down.sh",
          this.project,
        ], { env: this.stackEnvironment(), ignoreAbort: true });
      });
      await attempt("project-empty", async () => {
        const left = await this.step("teardown-project-empty", "docker", [
          "ps",
          "-a",
          "-q",
          "--filter",
          `label=com.docker.compose.project=${this.project}`,
        ], { ignoreAbort: true });
        if (left.stdout.trim() !== "") {
          throw new M1ProofError("M1_PROJECT_NOT_EMPTY", this.project);
        }
      });
    }
    if (this.cgroupCreated) {
      await attempt("cgroup-remove", async () => {
        await this.step("teardown-cgroup-remove", "sh", [
          "-c",
          `if [ -d ${shellQuote(this.cgroupRoot)} ]; then find ${
            shellQuote(this.cgroupRoot)
          } -depth -type d -exec rmdir {} +; fi`,
        ], { ignoreAbort: true });
      });
    }
    await attempt("lock-release", async () => {
      await this.releaseLock?.();
      this.releaseLock = undefined;
    });
    if (failures.length > 0) {
      this.ids.cleanupFailures = failures.join("; ");
      return "failed";
    }
    return "passed";
  }

  /**
   * Rewrites every text file under the out directory with the final redactor
   * (whatever its extension), searches binary files for the registered
   * secrets and records what could not be text-scanned. A secret learned late
   * (the enrollment token) may already sit in an earlier log or capture.
   *
   * It always visits every file: a binary hit or an unreadable file is
   * recorded and the scan goes on, so `evidenceScan` is complete and no file
   * is left unscrubbed. It then throws once, `M1_SECRET_IN_BINARY_EVIDENCE`
   * when a binary file held a secret, else `M1_EVIDENCE_SCRUB_FAILED`.
   */
  async scrubEvidence(): Promise<void> {
    this.setStep("scrub-evidence");
    const scan = emptyEvidenceScan();
    this.evidenceScan = scan;
    let files: readonly string[];
    try {
      await this.learnEnrollmentToken();
      files = await this.fs.listFiles(this.out);
    } catch (error) {
      throw new M1ProofError(
        "M1_EVIDENCE_SCRUB_FAILED",
        errorMessage(error),
        "scrub-evidence",
      );
    }
    for (const path of files) {
      const name = relative(this.out, path);
      if (name === M1_MANIFEST_FILE || name === M1_FAILURE_FILE) continue;
      try {
        const bytes = await this.fs.readBytes(path);
        if (bytes.byteLength > this.services.maxScanBytes) {
          scan.notTextScanned.push({
            path: name,
            kind: fileKind(name),
            reason: "oversize",
          });
          continue;
        }
        const text = decodeUtf8Text(bytes);
        if (text !== undefined) {
          scan.textFilesScanned += 1;
          const scrubbed = this.redactor.apply(text);
          if (scrubbed !== text) await this.fs.writeText(path, scrubbed);
          continue;
        }
        scan.binaryFilesSearched += 1;
        if (this.redactor.matches(new TextDecoder().decode(bytes))) {
          scan.secretHits.push(name);
        }
        scan.notTextScanned.push({
          path: name,
          kind: fileKind(name) === "text" ? "binary" : fileKind(name),
          reason: "binary",
        });
      } catch (error) {
        scan.unreadable.push(`${name} (${errorMessage(error)})`);
      }
    }
    if (scan.secretHits.length > 0) {
      throw new M1ProofError(
        "M1_SECRET_IN_BINARY_EVIDENCE",
        `${scan.secretHits.join(", ")} hold a registered secret and cannot ` +
          "be scrubbed" +
          (scan.unreadable.length > 0
            ? `; unreadable: ${scan.unreadable.join(", ")}`
            : ""),
        "scrub-evidence",
      );
    }
    if (scan.unreadable.length > 0) {
      throw new M1ProofError(
        "M1_EVIDENCE_SCRUB_FAILED",
        `unreadable: ${scan.unreadable.join(", ")}`,
        "scrub-evidence",
      );
    }
  }

  async hashFiles(): Promise<M1ProofManifest["files"]> {
    const files: M1ProofManifest["files"] = [];
    for (const path of await this.fs.listFiles(this.out)) {
      const name = relative(this.out, path);
      if (name === M1_MANIFEST_FILE || name === M1_FAILURE_FILE) continue;
      const bytes = await this.fs.readBytes(path);
      files.push({
        path: name,
        bytes: bytes.byteLength,
        sha256: await sha256Hex(bytes),
      });
    }
    return files;
  }
}

function readSpendCap(raw: string | undefined): number {
  const text = (raw ?? String(M1_SPEND_CAP_LIMIT_USD)).trim();
  if (!/^\d+(\.\d{1,6})?$/.test(text) || Number(text) <= 0) {
    throw new M1ProofError("M1_SPEND_CAP_INVALID", "BAKERY_M1_SPEND_CAP_USD");
  }
  const cap = Number(text);
  if (cap > M1_SPEND_CAP_LIMIT_USD) {
    throw new M1ProofError(
      "M1_SPEND_CAP_ABOVE_LIMIT",
      `${cap} is above ${M1_SPEND_CAP_LIMIT_USD} USD`,
    );
  }
  return cap;
}

const FORCE_EXPIRY_LINE =
  /^\S+ forceApprovalExpiry approvalId=(\S+) rowCount=(\d+) sql=(.+)$/;

/**
 * Reads one `fault-log.txt` line (the two shapes are documented in the header).
 * Lines that are neither shape, the helpers' failure lines and their read-only
 * lines are not operator steps.
 */
export function parseOperatorStepLine(
  line: string,
): M1OperatorStep | undefined {
  const helper = FORCE_EXPIRY_LINE.exec(line.trimEnd());
  if (helper) {
    return {
      name: "force-approval-expiry",
      command: `${helper[3]} /* $1 = ${helper[1]} */`,
      exitCode: Number(helper[2]) === 1 ? 0 : 1,
    };
  }
  const start = line.indexOf('{"m1"');
  if (start < 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.slice(start));
  } catch {
    throw new M1ProofError("M1_OPERATOR_STEP_RECORD_INVALID", "not JSON");
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const record = parsed as Record<string, unknown>;
  if (record.m1 !== "operator-step") return undefined;
  const statement = typeof record.sql === "string"
    ? record.sql
    : typeof record.command === "string"
    ? record.command
    : undefined;
  if (typeof record.name !== "string" || statement === undefined) {
    throw new M1ProofError("M1_OPERATOR_STEP_RECORD_INVALID", "fields");
  }
  const exitCode = typeof record.exitCode === "number"
    ? record.exitCode
    : record.rowCount === 1
    ? 0
    : 1;
  const parameter = typeof record.approvalId === "string"
    ? ` /* $1 = ${record.approvalId} */`
    : "";
  return { name: record.name, command: statement + parameter, exitCode };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs the whole proof. Resolves with the manifest only when both legs, the
 * guards, the spend check and the cleanup passed; otherwise writes
 * `m1-proof-failure.json` and rejects with the first failure.
 */
export async function runM1Proof(
  options: M1ProofOptions,
): Promise<M1ProofManifest> {
  const run = new M1Orchestrator(options);
  const { fileSystem: fs, root } = run.services;
  const sourceRoots = M1_SOURCE_PATHS.map((path) => resolve(root, path));
  if (
    sourceRoots.some((source) =>
      run.out === source || run.out.startsWith(`${source}/`)
    )
  ) {
    throw new M1ProofError("M1_OUT_DIR_INSIDE_SOURCE", run.out);
  }
  if (
    await fs.exists(run.out) && (await fs.listFiles(run.out)).length > 0
  ) {
    throw new M1ProofError("M1_OUT_DIR_NOT_EMPTY", run.out);
  }
  await fs.makeDirectory(join(run.out, "commands"), 0o755);

  let failure: unknown;
  let revision = "";
  try {
    await run.preflight();
    await run.bootStack();
    await run.prepareHost();
    await run.journeyLeg();
    await run.regressionLeg();
    revision = await run.finalize();
  } catch (error) {
    failure = error;
  }

  let cleanup: "passed" | "failed" | "skipped";
  if (failure !== undefined && options.keepStackOnFailure) {
    cleanup = "skipped";
    try {
      await run.releaseLock?.();
    } catch {
      // The lock dies with this process anyway.
    }
  } else {
    cleanup = await run.teardown();
  }

  const finishedAt = run.services.now().toISOString();
  // Every failure is kept, in order: a later secret leak must not be hidden by
  // an earlier failed leg. A scrub or hash exception is a failure with a
  // record, never an escape.
  const failures: unknown[] = failure === undefined ? [] : [failure];
  try {
    await run.scrubEvidence();
  } catch (error) {
    failures.push(error);
  }
  let files: M1ProofManifest["files"] = [];
  try {
    run.setStep("hash-evidence");
    files = await run.hashFiles();
  } catch (error) {
    failures.push(
      new M1ProofError(
        "M1_EVIDENCE_HASH_FAILED",
        errorMessage(error),
        "hash-evidence",
      ),
    );
  }

  if (failures.length === 0 && cleanup === "passed") {
    const manifest: M1ProofManifest = {
      schema: "bakery.m1-proof/v1",
      revision,
      workingTreeDirty: run.workingTreeDirty,
      composeProject: run.project,
      spendCapUsd: run.spendCapUsd,
      spendSettledUsd: run.spendSettledUsd ?? "0",
      // Reaching here means every guard in `run.guards` passed.
      adapters: { scriptedCoordinator: false, scriptedHarness: false },
      operatorSteps: run.operatorSteps,
      commands: run.commands,
      ids: run.ids,
      files,
      evidenceScan: run.evidenceScan,
      cleanup: "passed",
      startedAt: run.startedAt.toISOString(),
      finishedAt,
    };
    await fs.writeText(
      join(run.out, M1_MANIFEST_FILE),
      JSON.stringify(manifest, null, 2) + "\n",
    );
    return manifest;
  }

  if (failures.length === 0) {
    failures.push(
      new M1ProofError("M1_CLEANUP_FAILED", run.ids.cleanupFailures ?? ""),
    );
  }
  const cause = failures[0];
  const describe = (error: unknown) => ({
    code: error instanceof M1ProofError ? error.code : "M1_UNEXPECTED",
    step: error instanceof M1ProofError ? error.step : run.currentStep,
    error: run.redactor.apply(errorMessage(error)),
  });
  const record: M1ProofFailure = {
    schema: "bakery.m1-proof/v1",
    revision: run.revision,
    workingTreeDirty: run.workingTreeDirty,
    composeProject: run.project,
    spendCapUsd: run.spendCapUsd,
    spendSettledUsd: run.spendSettledUsd,
    adapters: run.adapters,
    operatorSteps: run.operatorSteps,
    commands: run.commands,
    ids: run.ids,
    files,
    evidenceScan: run.evidenceScan,
    cleanup,
    startedAt: run.startedAt.toISOString(),
    finishedAt,
    error: run.redactor.apply(errorMessage(cause)),
    failedStep: cause instanceof M1ProofError ? cause.step : run.currentStep,
    errors: failures.map(describe),
  };
  await fs.writeText(
    join(run.out, M1_FAILURE_FILE),
    JSON.stringify(record, null, 2) + "\n",
  );
  // The first failure is the one thrown; later ones are named in its message
  // and listed in full in the failure record.
  if (failures.length > 1 && cause instanceof M1ProofError) {
    const also = failures.slice(1).map((error) => describe(error).code);
    throw new M1ProofError(
      cause.code,
      `${cause.detail} (also: ${also.join(", ")}; see ${M1_FAILURE_FILE})`,
      cause.step,
    );
  }
  throw cause;
}

// ---- command line -----------------------------------------------------------

export function parseArguments(args: readonly string[]): {
  out: string;
  keepStackOnFailure: boolean;
} {
  let out: string | undefined;
  let keepStackOnFailure = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--keep-stack-on-failure") keepStackOnFailure = true;
    else if (argument === "--out") out = args[++index];
    else if (argument.startsWith("--out=")) {
      out = argument.slice("--out=".length);
    } else throw new M1ProofError("M1_ARGUMENT_UNKNOWN", argument);
  }
  if (!out) throw new M1ProofError("M1_OUT_REQUIRED", "--out <dir>");
  return { out, keepStackOnFailure };
}

export async function main(args: readonly string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArguments>;
  try {
    parsed = parseArguments(args);
  } catch (error) {
    console.error(errorMessage(error));
    console.error(
      "usage: deno run --allow-all scripts/evidence/prove-m1.ts --out <dir> [--keep-stack-on-failure]",
    );
    return 2;
  }
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  Deno.addSignalListener("SIGINT", onSignal);
  Deno.addSignalListener("SIGTERM", onSignal);
  try {
    const manifest = await runM1Proof({
      ...parsed,
      signal: controller.signal,
    });
    console.log(
      `M1 proof passed at ${manifest.revision}; manifest ${
        join(resolve(parsed.out), M1_MANIFEST_FILE)
      }`,
    );
    return 0;
  } catch (error) {
    console.error(`M1 proof failed: ${errorMessage(error)}`);
    return 1;
  } finally {
    Deno.removeSignalListener("SIGINT", onSignal);
    Deno.removeSignalListener("SIGTERM", onSignal);
  }
}

if (import.meta.main) {
  Deno.exit(await main(Deno.args));
}

/**
 * Deploys one main SHA to the hosted QA project on Railway and proves it.
 *
 * Run by `.github/workflows/deploy-qa.yml` after a green main CI run:
 *
 *   deno run --allow-run=railway,curl \
 *     --allow-env=RAILWAY_TOKEN,GITHUB_TOKEN,GITHUB_REPOSITORY,QA_URL,RAILWAY_QA_... \
 *     scripts/deploy/railway-deploy.ts --sha <40-hex> [--include-inngest] [--force]
 *
 * All logic lives here so the unit test can drive it with a fake runner:
 *   1. SHA must be on `main` (compare API).
 *   2. Containment guard: skip when the deployed /health/ready version already
 *      contains the SHA (compare status identical or ahead) AND every other
 *      requested service runs it too. /health/ready is answered by the api,
 *      which deploys first, so after a partly failed rollout it proves nothing
 *      about the dispatcher or web: each one's latest SUCCESS deployment must
 *      carry the upload message for the reported version. When the version is
 *      the SHA itself, only the lagging services are deployed (a rerun
 *      finishes the rollout). When it is a descendant of the SHA and a service
 *      lags, the job fails rather than deploy the older SHA. A skip also
 *      re-reads the last two minutes of the current dispatcher deployment's
 *      logs (the step 4 check, without waiting) and fails if they show
 *      restarts or cannot be read; that is not a proof of long-run health.
 *      Fail open to a deploy only when QA is down, reports no SHA, GitHub says
 *      the version is unknown (404), or a deployment list cannot be read. Any
 *      other GitHub error fails the job so a flaky API never regresses QA.
 *   3. Per service in order (inngest only when requested or when the deployed
 *      version and the SHA differ in infra/railway/inngest*, then api,
 *      dispatcher, web): `railway up --detach --json`, take this upload's
 *      deployment id, poll that id until SUCCESS. The poll is bounded by how
 *      long one status lasts, not by the deployment's total duration, so a slow
 *      Railway build queue cannot fail a deployment that is still progressing;
 *      the whole rollout is capped separately. A failed service aborts the
 *      rollout so nothing newer is deployed against a schema the API did not
 *      reach.
 *   4. Dispatcher is still SUCCESS and quiet two minutes after it went live.
 *   5. /health/ready reports the SHA.
 *
 * Never prints environment values. Log tails are redacted and neutralised
 * against workflow-command injection.
 */

export const SERVICE_ORDER = ["inngest", "api", "dispatcher", "web"] as const;
export type ServiceName = (typeof SERVICE_ORDER)[number];

export const DRAIN_MARKER = "APPLICATION_DATABASE_DRAIN_REQUIRED";
export const DRAIN_POINTER =
  "::error::QA migration needs a drain — follow learnings/railway-qa-migration-drain.xml";
export const DISPATCHER_POINTER =
  "Dispatcher recovery: learnings/railway-qa-dispatcher-recovery.xml";

/** Paths whose change means the Inngest image must be redeployed. */
export const INNGEST_ASSET_PREFIX = "infra/railway/inngest";
/** GitHub lists at most this many `files` for a whole comparison. */
const COMPARE_FILES_CAP = 300;

// Statuses seen from `railway deployment list --json` on the live project
// (2026-10-25): INITIALIZING, BUILDING, DEPLOYING, SUCCESS, FAILED, REMOVING,
// REMOVED. A deployment that reaches REMOVING or REMOVED before SUCCESS was
// replaced or taken down, so waiting longer cannot help.
const SUCCESS_STATUS = "SUCCESS";
const FAILED_STATUSES: ReadonlySet<string> = new Set([
  "FAILED",
  "CRASHED",
  "REMOVING",
  "REMOVED",
  "SKIPPED",
]);
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEPLOYMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const FALLBACK_CLOCK_SKEW_MS = 60_000;
const FALLBACK_ATTEMPTS = 6;
const FALLBACK_INTERVAL_MS = 5_000;
const MAX_CONSECUTIVE_LIST_FAILURES = 5;
const LOG_LINES = 400;
const TAIL_LINES = 40;
const TAIL_LINE_CHARACTERS = 400;

export interface CommandOutput {
  code: number;
  stdout: string;
  stderr: string;
}
export type CommandRunner = (
  command: string,
  args: readonly string[],
  timeoutMs: number,
  stdin?: string,
) => Promise<CommandOutput>;
export interface Clock {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
}
export interface Deps {
  run: CommandRunner;
  clock: Clock;
  log: (line: string) => void;
}

export interface DeployConfig {
  sha: string;
  repository: string;
  githubToken: string;
  qaUrl: string;
  projectId: string;
  environmentId: string;
  services: readonly ServiceName[];
  serviceIds: Readonly<Partial<Record<ServiceName, string>>>;
  force: boolean;
  pollIntervalMs: number;
  /**
   * How long one deployment may sit on the same status before it is called
   * stuck. Railway reports progress as INITIALIZING, BUILDING, DEPLOYING, so a
   * slow build queue still moves; only a genuinely wedged deployment stays put.
   */
  stallTimeoutMs: number;
  /** Cap on the whole rollout, so the job cannot outlive its own timeout. */
  rolloutTimeoutMs: number;
  livenessDelayMs: number;
  readyAttempts: number;
  readyIntervalMs: number;
}

export class DeployConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeployConfigError";
  }
}
export class DeployFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeployFailure";
  }
}

// ---------------------------------------------------------------- config ---

const SERVICE_ID_ENV: Readonly<Record<ServiceName, string>> = {
  inngest: "RAILWAY_QA_INNGEST_SERVICE_ID",
  api: "RAILWAY_QA_API_SERVICE_ID",
  dispatcher: "RAILWAY_QA_DISPATCHER_SERVICE_ID",
  web: "RAILWAY_QA_WEB_SERVICE_ID",
};

export function parseDeployConfig(
  args: readonly string[],
  env: (name: string) => string | undefined,
): DeployConfig {
  let sha: string | undefined;
  let repository: string | undefined;
  let includeInngest = false;
  let force = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--sha") sha = args[++index];
    else if (argument === "--repo") repository = args[++index];
    else if (argument === "--include-inngest") includeInngest = true;
    else if (argument === "--force") force = true;
    else throw new DeployConfigError(`unknown argument ${argument}`);
  }
  if (!sha || !SHA_PATTERN.test(sha)) {
    throw new DeployConfigError("--sha must be a full lowercase 40-hex commit");
  }
  repository ??= env("GITHUB_REPOSITORY");
  if (
    !repository || !REPOSITORY_PATTERN.test(repository) ||
    repository.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new DeployConfigError("repository must be owner/name");
  }
  if (!env("RAILWAY_TOKEN")) {
    throw new DeployConfigError("RAILWAY_TOKEN is not set");
  }
  const githubToken = env("GITHUB_TOKEN");
  if (!githubToken || /[\s"\\]/.test(githubToken)) {
    throw new DeployConfigError("GITHUB_TOKEN is not set or malformed");
  }
  const projectId = env("RAILWAY_QA_PROJECT_ID") ?? "";
  const environmentId = env("RAILWAY_QA_ENVIRONMENT_ID") ?? "";
  if (!UUID_PATTERN.test(projectId)) {
    throw new DeployConfigError("RAILWAY_QA_PROJECT_ID must be a UUID");
  }
  if (!UUID_PATTERN.test(environmentId)) {
    throw new DeployConfigError("RAILWAY_QA_ENVIRONMENT_ID must be a UUID");
  }
  const qaUrl = normaliseQaUrl(env("QA_URL"));
  const services = SERVICE_ORDER.filter((service) =>
    service === "inngest" ? includeInngest : true
  );
  const serviceIds: Partial<Record<ServiceName, string>> = {};
  for (const service of services) {
    const value = env(SERVICE_ID_ENV[service]) ?? "";
    if (!UUID_PATTERN.test(value)) {
      throw new DeployConfigError(`${SERVICE_ID_ENV[service]} must be a UUID`);
    }
    serviceIds[service] = value;
  }
  // Inngest is not requested, but a change to its image files redeploys it, so
  // a configured id is kept (and must be well formed). An absent id is only an
  // error at rollout time, when it turns out to be needed.
  const inngestId = env(SERVICE_ID_ENV.inngest);
  if (serviceIds.inngest === undefined && inngestId) {
    if (!UUID_PATTERN.test(inngestId)) {
      throw new DeployConfigError(`${SERVICE_ID_ENV.inngest} must be a UUID`);
    }
    serviceIds.inngest = inngestId;
  }
  return {
    sha,
    repository,
    githubToken,
    qaUrl,
    projectId,
    environmentId,
    services,
    serviceIds,
    force,
    pollIntervalMs: 15_000,
    stallTimeoutMs: 35 * 60_000,
    rolloutTimeoutMs: 120 * 60_000,
    livenessDelayMs: 120_000,
    readyAttempts: 12,
    readyIntervalMs: 15_000,
  };
}

function normaliseQaUrl(value: string | undefined): string {
  if (!value) throw new DeployConfigError("QA_URL is not set");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new DeployConfigError("QA_URL is not a URL");
  }
  if (
    parsed.protocol !== "https:" || parsed.username || parsed.password ||
    parsed.search || parsed.hash || parsed.pathname !== "/"
  ) {
    throw new DeployConfigError("QA_URL must be a bare https origin");
  }
  return parsed.origin;
}

// -------------------------------------------------------------- helpers ---

/** Drops ANSI escape sequences, then maps every other control character to a space. */
function stripControlCharacters(value: string): string {
  let output = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x1b) {
      // CSI sequence: ESC [ params letter.
      if (value[index + 1] === "[") {
        let end = index + 2;
        while (end < value.length && /[0-9;]/.test(value[end])) end += 1;
        if (end < value.length && /[A-Za-z]/.test(value[end])) {
          index = end;
          continue;
        }
      }
      output += " ";
    } else if (code < 0x20 || code === 0x7f) {
      output += " ";
    } else {
      output += value[index];
    }
  }
  return output;
}

/** Strips ANSI and control characters, redacts secrets, defuses `::` commands. */
export function redactLine(raw: string): string {
  let line = stripControlCharacters(raw).trim();
  line = line
    .replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/[^:/\s@]+:)[^@\s]+@/g, "$1***@")
    .replace(/\bBearer\s+\S+/gi, "Bearer ***")
    .replace(
      /\b([A-Za-z0-9_]*(?:password|passwd|secret|token|api[_-]?key|authorization|private[_-]?key)[A-Za-z0-9_]*)\s*([=:])\s*\S+/gi,
      "$1$2***",
    )
    .replace(
      /[A-Za-z0-9+/=_-]{40,}/g,
      (match) => SHA_PATTERN.test(match) ? match : "***",
    );
  if (line.length > TAIL_LINE_CHARACTERS) {
    line = `${line.slice(0, TAIL_LINE_CHARACTERS)}...`;
  }
  // GitHub runs `::command::` lines found in step output; never let a log
  // line from a service become one.
  if (line.startsWith("::")) line = `: ${line.slice(1)}`;
  return line;
}

export function parseLogMessages(stdout: string): string[] {
  const messages: string[] = [];
  for (const line of stdout.split("\n")) {
    const text = line.trim();
    if (!text) continue;
    try {
      const value: unknown = JSON.parse(text);
      if (value && typeof value === "object") {
        const message = (value as Record<string, unknown>).message;
        if (typeof message === "string") {
          messages.push(message);
          continue;
        }
      }
    } catch {
      // Plain text line.
    }
    messages.push(text);
  }
  return messages;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonValues(stdout: string): unknown[] {
  const values: unknown[] = [];
  const whole = stdout.trim();
  if (!whole) return values;
  try {
    values.push(JSON.parse(whole));
    return values;
  } catch {
    // One JSON document per line.
  }
  for (const line of whole.split("\n")) {
    try {
      values.push(JSON.parse(line.trim()));
    } catch {
      // Not JSON; ignore.
    }
  }
  return values;
}

/**
 * Deployment id from `railway up --detach --json`. The real output is
 * `{"deploymentId":"...","logsUrl":"..."}`. Also accepts `deployment_id` or
 * `deployment.id`; never a bare `id`, which could be any entity. Several
 * distinct ids are ambiguous and return undefined.
 */
export function extractDeploymentId(stdout: string): string | undefined {
  const found = new Set<string>();
  for (const value of jsonValues(stdout)) {
    if (!isRecord(value)) continue;
    const candidates = [
      value.deploymentId,
      value.deployment_id,
      isRecord(value.deployment) ? value.deployment.id : undefined,
    ];
    for (const candidate of candidates) {
      if (
        typeof candidate === "string" && DEPLOYMENT_ID_PATTERN.test(candidate)
      ) {
        found.add(candidate);
      }
    }
  }
  return found.size === 1 ? [...found][0] : undefined;
}

export interface DeploymentRecord {
  id: string;
  status: string;
  createdAt?: string;
  message?: string;
}

/**
 * `railway deployment list --json` prints an array of
 * `{ id, status, createdAt, meta }`. The message given to `railway up -m` is
 * `meta.cliMessage`; the other message fields are tolerated alternatives.
 */
export function parseDeploymentList(stdout: string): DeploymentRecord[] {
  const values = jsonValues(stdout);
  const root = values[0];
  const items = Array.isArray(root)
    ? root
    : isRecord(root) && Array.isArray(root.deployments)
    ? root.deployments
    : [];
  const records: DeploymentRecord[] = [];
  for (const item of items) {
    if (!isRecord(item) || typeof item.id !== "string") continue;
    const meta = isRecord(item.meta) ? item.meta : {};
    const message = [
      meta.cliMessage,
      meta.message,
      meta.commitMessage,
      item.message,
    ].find((candidate): candidate is string => typeof candidate === "string");
    records.push({
      id: item.id,
      status: typeof item.status === "string" ? item.status.toUpperCase() : "",
      createdAt: typeof item.createdAt === "string"
        ? item.createdAt
        : undefined,
      message,
    });
  }
  return records;
}

function target(config: DeployConfig, service: ServiceName): string[] {
  return [
    "-p",
    config.projectId,
    "-e",
    config.environmentId,
    "-s",
    config.serviceIds[service] as string,
  ];
}

async function listDeployments(
  deps: Deps,
  config: DeployConfig,
  service: ServiceName,
): Promise<DeploymentRecord[] | undefined> {
  const result = await deps.run("railway", [
    "deployment",
    "list",
    ...target(config, service),
    "--limit",
    "50",
    "--json",
  ], 120_000);
  if (result.code !== 0) return undefined;
  return parseDeploymentList(result.stdout);
}

/**
 * The upload message for a SHA. `startDeployment` sends it with `railway up -m`
 * and the guard matches it against `meta.cliMessage`, so the format lives here.
 */
export function deploymentMessage(sha: string): string {
  return `main ${sha}`;
}

// ------------------------------------------------------ guard and checks ---

export type GuardDecision =
  | {
    action: "skip";
    reason: string;
    /**
     * The dispatcher deployment that makes the skip safe. `runRollout` checks
     * that it is still alive before it reports the skip as green.
     */
    dispatcherDeploymentId?: string;
  }
  | {
    action: "deploy";
    reason: string;
    deployed?: string;
    /** Resume: deploy only these services, which do not run `deployed` yet. */
    only?: readonly ServiceName[];
  };

interface LaggingService {
  service: ServiceName;
  why: string;
}

interface ServiceInspection {
  lagging: LaggingService[];
  /** The dispatcher's current deployment, when it is requested and current. */
  dispatcherDeploymentId?: string;
}

/**
 * Services among the requested ones, other than the api, that do not run
 * `version`. The api is proven by /health/ready itself, which it answers. A
 * service runs `version` only when its latest SUCCESS deployment was uploaded
 * with that version's message. A deployment list that cannot be read or
 * parsed, or a SUCCESS record without a usable date, proves nothing, so that
 * service counts as lagging.
 */
async function inspectServices(
  deps: Deps,
  config: DeployConfig,
  version: string,
): Promise<ServiceInspection> {
  const expected = deploymentMessage(version);
  const inspection: ServiceInspection = { lagging: [] };
  for (const service of config.services) {
    if (service === "api") continue;
    const records = await listDeployments(deps, config, service);
    if (records === undefined || records.length === 0) {
      inspection.lagging.push({
        service,
        why: records === undefined
          ? "deployment list unreadable"
          : "no deployments listed",
      });
      continue;
    }
    const latest = latestSuccess(records);
    if (latest === "undated") {
      inspection.lagging.push({
        service,
        why: "undated SUCCESS deployment",
      });
      continue;
    }
    if (latest?.message === expected) {
      if (service === "dispatcher") {
        inspection.dispatcherDeploymentId = latest.id;
      }
      continue;
    }
    inspection.lagging.push({
      service,
      why: latest === undefined
        ? "no SUCCESS deployment"
        : `latest SUCCESS deployment is ${
          latest.message === undefined
            ? "unlabelled"
            : redactLine(latest.message)
        }`,
    });
  }
  return inspection;
}

/**
 * The newest SUCCESS deployment by `createdAt`, whatever the list order.
 * `"undated"` when any SUCCESS record has no parsable `createdAt`: the order
 * of such records cannot be proven, so none of them may win.
 */
function latestSuccess(
  records: readonly DeploymentRecord[],
): DeploymentRecord | "undated" | undefined {
  let latest: DeploymentRecord | undefined;
  let latestAt = Number.NEGATIVE_INFINITY;
  for (const record of records) {
    if (record.status !== SUCCESS_STATUS) continue;
    const at = Date.parse(record.createdAt ?? "");
    if (Number.isNaN(at)) return "undated";
    if (at > latestAt) {
      latest = record;
      latestAt = at;
    }
  }
  return latest;
}

function describeLagging(lagging: readonly LaggingService[]): string {
  return lagging.map(({ service, why }) => `${service} (${why})`).join(", ");
}

/**
 * GitHub compare through curl with the token on stdin (`-K -`), so it never
 * appears in a process list. Returns the parsed JSON body, or whether GitHub
 * answered 404.
 */
async function compareBody(
  deps: Deps,
  config: DeployConfig,
  base: string,
  head: string,
  query: string,
): Promise<{ body?: Record<string, unknown>; notFound: boolean }> {
  const result = await deps.run(
    "curl",
    [
      "-fsS",
      "--max-time",
      "30",
      "-K",
      "-",
      "-H",
      "Accept: application/vnd.github+json",
      "-H",
      "X-GitHub-Api-Version: 2022-11-28",
      `https://api.github.com/repos/${config.repository}/compare/${base}...${head}?${query}`,
    ],
    60_000,
    `header = "Authorization: Bearer ${config.githubToken}"\n`,
  );
  if (result.code === 0) {
    try {
      const body: unknown = JSON.parse(result.stdout);
      if (isRecord(body)) return { body, notFound: false };
    } catch {
      // Falls through to an unusable answer.
    }
    return { notFound: false };
  }
  return { notFound: /\b404\b|Not Found/i.test(result.stderr) };
}

/** `status` describes `head` relative to `base`. */
async function compareStatus(
  deps: Deps,
  config: DeployConfig,
  base: string,
  head: string,
): Promise<{ status?: string; notFound: boolean }> {
  const { body, notFound } = await compareBody(
    deps,
    config,
    base,
    head,
    "per_page=1",
  );
  return {
    status: typeof body?.status === "string" ? body.status : undefined,
    notFound,
  };
}

/**
 * Whether files under infra/railway/inngest* differ between the deployed version
 * and the SHA. `unknown` when GitHub cannot say (error, no `files` list, or a
 * list at GitHub's cap that may be cut short), which callers treat as changed.
 *
 * On the compare endpoint `per_page` and `page` paginate COMMITS, not files.
 * `files` rides on page 1 only, holds up to 300 entries for the whole
 * comparison and is absent on later pages. So one request is enough: page 1
 * with a single commit keeps the payload small and still carries every file.
 */
export async function inngestAssetsChanged(
  deps: Deps,
  config: DeployConfig,
  deployed: string,
): Promise<"changed" | "unchanged" | "unknown"> {
  const { body } = await compareBody(
    deps,
    config,
    deployed,
    config.sha,
    "per_page=1&page=1",
  );
  if (!body || !Array.isArray(body.files)) return "unknown";
  for (const file of body.files) {
    if (!isRecord(file)) return "unknown";
    for (const name of [file.filename, file.previous_filename]) {
      if (typeof name === "string" && name.startsWith(INNGEST_ASSET_PREFIX)) {
        return "changed";
      }
    }
  }
  return body.files.length >= COMPARE_FILES_CAP ? "unknown" : "unchanged";
}

/** The SHA must be main or an ancestor of main. */
export async function assertOnMain(
  deps: Deps,
  config: DeployConfig,
): Promise<void> {
  const { status } = await compareStatus(deps, config, config.sha, "main");
  if (status !== "identical" && status !== "ahead") {
    throw new DeployFailure(
      `SHA_NOT_ON_MAIN: compare ${config.sha}...main reported ${
        status ?? "an error"
      }`,
    );
  }
}

export async function readVersion(
  deps: Deps,
  qaUrl: string,
): Promise<string | undefined> {
  const result = await deps.run("curl", [
    "-fsS",
    "--max-time",
    "20",
    `${qaUrl}/health/ready`,
  ], 30_000);
  if (result.code !== 0) return undefined;
  try {
    const body: unknown = JSON.parse(result.stdout);
    return isRecord(body) && typeof body.version === "string"
      ? body.version
      : undefined;
  } catch {
    return undefined;
  }
}

export async function containmentGuard(
  deps: Deps,
  config: DeployConfig,
): Promise<GuardDecision> {
  const deployed = await readVersion(deps, config.qaUrl);
  if (deployed === undefined) {
    return { action: "deploy", reason: "QA unreachable or reports no version" };
  }
  if (!SHA_PATTERN.test(deployed)) {
    return { action: "deploy", reason: "deployed version is not a commit SHA" };
  }
  if (deployed === config.sha) {
    // The api already serves the SHA. A rerun after a partly failed rollout
    // must still finish the services that lag.
    const { lagging, dispatcherDeploymentId } = await inspectServices(
      deps,
      config,
      deployed,
    );
    if (lagging.length === 0) {
      return {
        action: "skip",
        reason: "QA already runs this SHA",
        dispatcherDeploymentId,
      };
    }
    return {
      action: "deploy",
      deployed,
      only: lagging.map(({ service }) => service),
      reason: `the api reports this SHA but ${describeLagging(lagging)} lag`,
    };
  }
  const { status, notFound } = await compareStatus(
    deps,
    config,
    config.sha,
    deployed,
  );
  if (status === "identical" || status === "ahead") {
    const { lagging, dispatcherDeploymentId } = await inspectServices(
      deps,
      config,
      deployed,
    );
    if (lagging.length > 0) {
      // Deploying the older SHA onto the newer api would regress QA.
      throw new DeployFailure(
        `DEPLOYED_SERVICES_STALE: QA reports ${deployed}, a descendant of ${config.sha}, but ${
          describeLagging(lagging)
        } do not run it. Deploying ${config.sha} would regress QA: rerun the deploy for the newer SHA, or use --force deliberately`,
      );
    }
    return {
      action: "skip",
      reason: `deployed ${deployed} already contains ${config.sha}`,
      dispatcherDeploymentId,
    };
  }
  if (status === "behind" || status === "diverged") {
    return {
      action: "deploy",
      deployed,
      reason: `deployed ${deployed} is ${status} of ${config.sha}`,
    };
  }
  if (notFound) {
    return {
      action: "deploy",
      reason: `deployed ${deployed} is unknown to ${config.repository}`,
    };
  }
  throw new DeployFailure(
    "COMPARE_UNAVAILABLE: cannot tell whether QA already contains this SHA",
  );
}

// ------------------------------------------------------ deploy a service ---

async function startDeployment(
  deps: Deps,
  config: DeployConfig,
  service: ServiceName,
): Promise<string> {
  const message = deploymentMessage(config.sha);
  const startedAt = deps.clock.now();
  const result = await deps.run("railway", [
    "up",
    "--detach",
    "--json",
    ...target(config, service),
    "-m",
    message,
  ], 15 * 60_000);
  if (result.code !== 0) {
    deps.log(
      `railway up ${service} exited ${result.code}: ${
        redactLine(result.stderr.split("\n").filter(Boolean).pop() ?? "")
      }`,
    );
    throw new DeployFailure(`UPLOAD_FAILED: ${service}`);
  }
  const id = extractDeploymentId(result.stdout);
  if (id) return id;
  deps.log(
    `railway up ${service} printed no single deployment id; matching by message`,
  );
  for (let attempt = 1; attempt <= FALLBACK_ATTEMPTS; attempt += 1) {
    const records = await listDeployments(deps, config, service);
    const matches = (records ?? []).filter((record) =>
      record.message === message && record.createdAt !== undefined &&
      Date.parse(record.createdAt) >= startedAt - FALLBACK_CLOCK_SKEW_MS
    );
    if (matches.length === 1) return matches[0].id;
    if (matches.length > 1) {
      throw new DeployFailure(
        `DEPLOYMENT_ID_AMBIGUOUS: ${service} has ${matches.length} deployments with message "${message}"`,
      );
    }
    if (attempt < FALLBACK_ATTEMPTS) {
      await deps.clock.sleep(FALLBACK_INTERVAL_MS);
    }
  }
  throw new DeployFailure(
    `DEPLOYMENT_ID_NOT_FOUND: ${service} has no deployment with message "${message}"`,
  );
}

async function reportFailure(
  deps: Deps,
  config: DeployConfig,
  service: ServiceName,
  id: string,
  reason: string,
): Promise<void> {
  deps.log(`${service} deployment ${id} did not succeed: ${reason}`);
  const fetchLogs = async (kind: "--deployment" | "--build") => {
    const result = await deps.run("railway", [
      "logs",
      id,
      ...target(config, service),
      kind,
      "--lines",
      String(LOG_LINES),
      "--json",
    ], 120_000);
    return result.code === 0 ? parseLogMessages(result.stdout) : [];
  };
  const deployLogs = await fetchLogs("--deployment");
  const buildLogs = await fetchLogs("--build");
  const all = [...deployLogs, ...buildLogs];
  if (all.some((message) => message.includes(DRAIN_MARKER))) {
    deps.log(DRAIN_POINTER);
  }
  const tail = (deployLogs.length > 0 ? deployLogs : buildLogs).slice(
    -TAIL_LINES,
  );
  if (tail.length === 0) deps.log(`${service}: no logs returned`);
  for (const message of tail) deps.log(`${service} | ${redactLine(message)}`);
}

/**
 * Waits for one deployment to reach SUCCESS.
 *
 * The wait is bounded by how long the deployment sits on a single status, not
 * by its total duration. Railway's build queue can be slow enough that a
 * healthy rollout takes far longer than usual — on 2026-10-28 run 40735281134
 * the api and dispatcher alone took 45 minutes against a normal 7 — and a
 * total-duration bound turns that into a false failure: it reported web
 * `TIMEOUT after 25 min (last status DEPLOYING)` eleven minutes before Railway
 * promoted that very deployment, so QA was left on the previous SHA for six
 * hours even though the deploy had worked. Railway marks a deployment that
 * genuinely fails its healthcheck FAILED or CRASHED, which `FAILED_STATUSES`
 * already catches on the next poll, so the stall bound only has to catch a
 * deployment that stops reporting progress at all.
 */
async function awaitSuccess(
  deps: Deps,
  config: DeployConfig,
  service: ServiceName,
  id: string,
  rolloutDeadline: number,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  let stallDeadline = deps.clock.now() + config.stallTimeoutMs;
  let consecutiveListFailures = 0;
  let lastStatus = "UNKNOWN";
  for (;;) {
    const records = await listDeployments(deps, config, service);
    if (records === undefined) {
      consecutiveListFailures += 1;
      if (consecutiveListFailures >= MAX_CONSECUTIVE_LIST_FAILURES) {
        return { ok: false, reason: "deployment list kept failing" };
      }
    } else {
      consecutiveListFailures = 0;
      const record = records.find((candidate) => candidate.id === id);
      if (record) {
        if (record.status !== lastStatus) {
          deps.log(`${service} ${id} ${record.status}`);
          // Progress: the deployment is moving, so give it a fresh budget.
          lastStatus = record.status;
          stallDeadline = deps.clock.now() + config.stallTimeoutMs;
        }
        if (record.status === SUCCESS_STATUS) return { ok: true };
        if (FAILED_STATUSES.has(record.status)) {
          return { ok: false, reason: record.status };
        }
      }
    }
    const now = deps.clock.now();
    if (now >= rolloutDeadline) {
      return {
        ok: false,
        reason: `ROLLOUT TIMEOUT after ${
          Math.round(config.rolloutTimeoutMs / 60_000)
        } min (last status ${lastStatus})`,
      };
    }
    if (now >= stallDeadline) {
      return {
        ok: false,
        reason: `TIMEOUT after ${
          Math.round(config.stallTimeoutMs / 60_000)
        } min without progress (last status ${lastStatus})`,
      };
    }
    const remaining = Math.min(stallDeadline, rolloutDeadline) - now;
    await deps.clock.sleep(Math.min(config.pollIntervalMs, remaining));
  }
}

export interface ServiceOutcome {
  service: ServiceName;
  deploymentId: string;
  successAt: number;
}

async function deployService(
  deps: Deps,
  config: DeployConfig,
  service: ServiceName,
  rolloutDeadline: number,
): Promise<ServiceOutcome> {
  deps.log(`::group::deploy ${service}`);
  try {
    const id = await startDeployment(deps, config, service);
    deps.log(`${service} deployment id ${id}`);
    const result = await awaitSuccess(
      deps,
      config,
      service,
      id,
      rolloutDeadline,
    );
    if (!result.ok) {
      await reportFailure(deps, config, service, id, result.reason);
      throw new DeployFailure(`${service.toUpperCase()}_DEPLOY_FAILED`);
    }
    deps.log(`${service} ${id} SUCCESS`);
    return { service, deploymentId: id, successAt: deps.clock.now() };
  } finally {
    deps.log("::endgroup::");
  }
}

// ---------------------------------------------------- post-deploy checks ---

const RESTART_MARKER = /restart|exited|exit code|crash|terminated|killed/i;

function logLevel(value: unknown): string {
  if (!isRecord(value)) return "";
  if (typeof value.severity === "string") return value.severity.toLowerCase();
  if (typeof value.level === "string") return value.level.toLowerCase();
  if (Array.isArray(value.attributes)) {
    for (const attribute of value.attributes) {
      if (isRecord(attribute) && attribute.key === "level") {
        return String(attribute.value ?? "").toLowerCase();
      }
    }
  }
  return "";
}

/**
 * The dispatcher is still SUCCESS and its last two minutes of logs show no
 * restarts. `when` only words the failure: after a rollout the deployment is
 * two minutes past SUCCESS, on a skip no time has passed and an unreadable
 * deployment list is its own cause.
 */
export async function checkDispatcherAlive(
  deps: Deps,
  config: DeployConfig,
  outcome: ServiceOutcome,
  when: "after-rollout" | "on-skip" = "after-rollout",
): Promise<void> {
  const wait = config.livenessDelayMs - (deps.clock.now() - outcome.successAt);
  if (wait > 0) {
    deps.log(`waiting ${Math.ceil(wait / 1000)} s before the dispatcher check`);
    await deps.clock.sleep(wait);
  }
  const records = await listDeployments(deps, config, "dispatcher");
  const record = records?.find((candidate) =>
    candidate.id === outcome.deploymentId
  );
  if (!record || record.status !== SUCCESS_STATUS) {
    deps.log(DISPATCHER_POINTER);
    const state = record?.status ?? "not listed";
    throw new DeployFailure(
      when === "after-rollout"
        ? `DISPATCHER_NOT_ALIVE: deployment ${outcome.deploymentId} is ${state} two minutes after SUCCESS`
        : records === undefined
        ? "DISPATCHER_NOT_ALIVE: deployment list unreadable on skip"
        : `DISPATCHER_NOT_ALIVE: deployment ${outcome.deploymentId} is ${state} on skip`,
    );
  }
  const logs = await deps.run("railway", [
    "logs",
    outcome.deploymentId,
    ...target(config, "dispatcher"),
    "--deployment",
    "--since",
    "2m",
    "--json",
  ], 120_000);
  if (logs.code !== 0) {
    deps.log(DISPATCHER_POINTER);
    throw new DeployFailure("DISPATCHER_LOGS_UNAVAILABLE");
  }
  const offending: string[] = [];
  for (const line of logs.stdout.split("\n")) {
    const text = line.trim();
    if (!text) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || typeof parsed.message !== "string") continue;
    if (logLevel(parsed) === "error" && RESTART_MARKER.test(parsed.message)) {
      offending.push(parsed.message);
    }
  }
  if (offending.length > 0) {
    deps.log(DISPATCHER_POINTER);
    for (const message of offending.slice(-10)) {
      deps.log(`dispatcher | ${redactLine(message)}`);
    }
    throw new DeployFailure("DISPATCHER_RESTARTING");
  }
  deps.log("dispatcher still SUCCESS with no restart errors");
}

export async function checkFinalVersion(
  deps: Deps,
  config: DeployConfig,
): Promise<void> {
  let seen: string | undefined;
  for (let attempt = 1; attempt <= config.readyAttempts; attempt += 1) {
    seen = await readVersion(deps, config.qaUrl);
    if (seen === config.sha) {
      deps.log(`/health/ready reports ${config.sha}`);
      return;
    }
    if (attempt < config.readyAttempts) {
      await deps.clock.sleep(config.readyIntervalMs);
    }
  }
  throw new DeployFailure(
    `VERSION_MISMATCH: /health/ready reports ${
      seen === undefined ? "nothing" : redactLine(seen)
    }, expected ${config.sha}`,
  );
}

// ---------------------------------------------------------------- rollout ---

export interface RolloutResult {
  exitCode: 0 | 1;
  skipped: boolean;
  deployed: ServiceName[];
  message: string;
}

/**
 * Services to deploy. Inngest joins automatically when its image files differ
 * between the deployed version and the SHA (or when that cannot be told), so a
 * merged change to infra/railway/inngest* never silently misses QA.
 */
async function servicesToDeploy(
  deps: Deps,
  config: DeployConfig,
  deployedVersion: string | undefined,
): Promise<readonly ServiceName[]> {
  if (config.services.includes("inngest")) return config.services;
  let reason: string | undefined;
  if (deployedVersion === undefined) {
    reason = "deployed version unknown";
  } else {
    const verdict = await inngestAssetsChanged(deps, config, deployedVersion);
    if (verdict === "changed") {
      reason = `${INNGEST_ASSET_PREFIX}* changed since ${deployedVersion}`;
    } else if (verdict === "unknown") {
      reason =
        `cannot tell whether ${INNGEST_ASSET_PREFIX}* changed since ${deployedVersion}`;
    }
  }
  if (reason === undefined) return config.services;
  if (config.serviceIds.inngest === undefined) {
    if (deployedVersion === undefined) {
      deps.log(
        `::notice::inngest not checked (${reason}); RAILWAY_QA_INNGEST_SERVICE_ID is not set`,
      );
      return config.services;
    }
    throw new DeployFailure(
      `INNGEST_SERVICE_ID_MISSING: ${reason}; set RAILWAY_QA_INNGEST_SERVICE_ID or rerun with --include-inngest`,
    );
  }
  deps.log(`including inngest: ${reason}`);
  return SERVICE_ORDER.filter((service) =>
    service === "inngest" || config.services.includes(service)
  );
}

export async function runRollout(
  deps: Deps,
  config: DeployConfig,
): Promise<RolloutResult> {
  const deployed: ServiceName[] = [];
  let services: readonly ServiceName[] = config.services;
  // One budget for every service together: a per-service bound multiplied by
  // the service count could outlive the workflow's own timeout-minutes, which
  // kills the job with no failure report at all.
  const rolloutDeadline = deps.clock.now() + config.rolloutTimeoutMs;
  try {
    await assertOnMain(deps, config);
    let deployedVersion: string | undefined;
    let resume: readonly ServiceName[] | undefined;
    if (config.force) {
      deps.log("containment guard bypassed by --force");
      deployedVersion = await readVersion(deps, config.qaUrl);
    } else {
      const decision = await containmentGuard(deps, config);
      deps.log(`containment guard: ${decision.action} (${decision.reason})`);
      if (decision.action === "skip") {
        // Every service shows the version, but a rerun must not report green
        // while the dispatcher's last two minutes of logs show restarts: re-run
        // the liveness read once (one log read, no wait) before the skip. It
        // checks current behaviour only, not long-run health.
        if (decision.dispatcherDeploymentId !== undefined) {
          await checkDispatcherAlive(deps, config, {
            service: "dispatcher",
            deploymentId: decision.dispatcherDeploymentId,
            successAt: deps.clock.now() - config.livenessDelayMs,
          }, "on-skip");
        }
        deps.log(`::notice::QA deploy skipped: ${decision.reason}`);
        return {
          exitCode: 0,
          skipped: true,
          deployed,
          message: decision.reason,
        };
      }
      deployedVersion = decision.deployed;
      resume = decision.only;
    }
    if (deployedVersion !== undefined && !SHA_PATTERN.test(deployedVersion)) {
      deployedVersion = undefined;
    }
    // A resume deploys the lagging services only: the api already runs the SHA,
    // so the Inngest image files cannot differ from it either.
    services = resume
      ? config.services.filter((service) => resume.includes(service))
      : await servicesToDeploy(deps, config, deployedVersion);
    let dispatcher: ServiceOutcome | undefined;
    for (const service of services) {
      const outcome = await deployService(
        deps,
        config,
        service,
        rolloutDeadline,
      );
      deployed.push(service);
      if (service === "dispatcher") dispatcher = outcome;
    }
    if (dispatcher) await checkDispatcherAlive(deps, config, dispatcher);
    await checkFinalVersion(deps, config);
    return {
      exitCode: 0,
      skipped: false,
      deployed,
      message: `QA runs ${config.sha}`,
    };
  } catch (error) {
    if (!(error instanceof DeployFailure)) throw error;
    const notDeployed = services.filter((service) =>
      !deployed.includes(service)
    );
    deps.log(`::error::QA deploy failed: ${error.message}`);
    if (notDeployed.length > 0 && deployed.length < services.length) {
      deps.log(`not deployed: ${notDeployed.join(", ")}`);
    }
    return { exitCode: 1, skipped: false, deployed, message: error.message };
  }
}

// ------------------------------------------------------------- real deps ---

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

export const realRunner: CommandRunner = async (
  command,
  args,
  timeoutMs,
  stdin,
) => {
  try {
    const child = new Deno.Command(command, {
      args: [...args],
      stdin: stdin === undefined ? "null" : "piped",
      stdout: "piped",
      stderr: "piped",
      signal: AbortSignal.timeout(timeoutMs),
    }).spawn();
    if (stdin !== undefined) {
      const writer = child.stdin.getWriter();
      await writer.write(new TextEncoder().encode(stdin));
      await writer.close();
    }
    const output = await child.output();
    return {
      code: output.code,
      stdout: new TextDecoder().decode(output.stdout),
      stderr: new TextDecoder().decode(output.stderr),
    };
  } catch (error) {
    return {
      code: 124,
      stdout: "",
      stderr: error instanceof Error ? error.name : "spawn failed",
    };
  }
};

export async function main(args: readonly string[]): Promise<number> {
  let config: DeployConfig;
  try {
    config = parseDeployConfig(args, (name) => Deno.env.get(name));
  } catch (error) {
    if (error instanceof DeployConfigError) {
      console.error(`::error::${error.message}`);
      return 2;
    }
    throw error;
  }
  const result = await runRollout({
    run: realRunner,
    clock: realClock,
    log: (line) => console.log(line),
  }, config);
  return result.exitCode;
}

if (import.meta.main) Deno.exit(await main(Deno.args));

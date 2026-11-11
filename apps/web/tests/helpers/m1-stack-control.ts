import { execFile } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  composeEnvironment,
  databaseHelperEnvironment,
  readStackEnv,
  scrubSecrets,
  type StackEnv,
  stackSecretValues,
  stateScriptEnvironment,
} from "./m1-stack-env.ts";

/**
 * Stack and fault controls for the M1 journey proof: restart a
 * compose service, kill and start the worker, wait for readiness, read the
 * settled spend and the stored status of a question, and move one approval's
 * expiry into the past (operator step 3). The spec calls these between steps
 * without knowing how the services run.
 *
 * Inputs, all written by `scripts/evidence/prove-m1.ts`:
 * - `BAKERY_REAL_API_M1=1`: every function refuses to run without it.
 * - `BAKERY_M1_STATE_DIR`: holds `stack.env`, `worker-launch.sh`,
 *   `worker-kill.sh` and the `fault-log.txt` these functions append to.
 * - `BAKERY_M1_COMPOSE_PROJECT`: the compose project of the stack.
 *
 * Every compose call loads all of `stack.env` verbatim (`composeEnvironment`):
 * the resolved host ports and every first-start variable, so a restart can
 * neither drop the budget policy nor let compose pick new ports
 * (`learnings/docker-pause-for-reconnect-drills.xml`). The state-dir scripts
 * get the same allow-listed environment plus the session bus
 * (`stateScriptEnvironment`), never the spec's own. Nothing here starts a
 * stack, a worker outside the state-dir scripts, or a model call.
 *
 * `fault-log.txt` lines are `<ISO timestamp> <function> <detail>`. The
 * `forceApprovalExpiry` line carries the SQL text and row count the
 * orchestrator copies into the manifest's `operatorSteps`
 * (`approvalId=<id> rowCount=<n> sql=<text>`); `createFirstAdmin` logs a
 * JSON `{"m1":"operator-step",...}` record. Every failure message written to
 * the log or thrown from here has the stack's secret values replaced with
 * `[redacted]` first.
 */

const execFileAsync = promisify(execFile);

/** The repository root of the worktree this helper file lives in. */
const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const composeFile = `${repositoryRoot}infra/compose.yaml`;
const databaseScript = `${repositoryRoot}tests/helpers/m1-stack-db.ts`;
const adminScript = `${repositoryRoot}tests/helpers/web-auth-seed.ts`;

/** What a spawned child may be given and what it returns. */
export type ProcessRunner = (
  file: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: Record<string, string | undefined>;
    timeout: number;
    maxBuffer: number;
  },
) => Promise<{ stdout: string; stderr: string }>;

/**
 * The process, network and clock seam. Production uses the defaults; the unit
 * test `tests/unit/m1-stack-control_test.ts` swaps them to record the child
 * environment and to simulate a failing child, with no docker and no network.
 */
export const runtime: {
  env: () => Readonly<Record<string, string | undefined>>;
  run: ProcessRunner;
  fetch: typeof fetch;
  sleep: (milliseconds: number) => Promise<void>;
} = {
  env: () => process.env,
  run: (file, args, options) => execFileAsync(file, [...args], options),
  fetch: (input, init) => fetch(input, init),
  sleep: (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

/** Restartable services: the container port `infra/compose.yaml` publishes. */
const SERVICES = {
  server: { containerPort: 8000, portKey: "BAKERY_SERVER_PORT" },
  inngest: { containerPort: 8288, portKey: "BAKERY_INNGEST_PORT" },
} as const;
type RestartableService = keyof typeof SERVICES;

type Control = {
  operation: string;
  stateDirectory: string;
  project: string;
  stackEnvFile: string;
};

function required(name: string): string {
  const value = runtime.env()[name];
  if (!value) throw new Error(`M1_STACK_CONTROL_ENV_REQUIRED:${name}`);
  return value;
}

/** Refuses to run outside an M1 proof, then resolves the state locations. */
function control(operation: string): Control {
  if (runtime.env().BAKERY_REAL_API_M1 !== "1") {
    throw new Error(`M1_STACK_CONTROL_DISABLED:${operation}`);
  }
  const stateDirectory = required("BAKERY_M1_STATE_DIR");
  return {
    operation,
    stateDirectory,
    project: required("BAKERY_M1_COMPOSE_PROJECT"),
    stackEnvFile: `${stateDirectory}/stack.env`,
  };
}

function record(context: Control, detail: string) {
  appendFileSync(
    `${context.stateDirectory}/fault-log.txt`,
    `${new Date().toISOString()} ${context.operation} ${detail}\n`,
  );
}

/** Longest error text written to the fault log or thrown. */
const MAX_FAILURE_LENGTH = 2_000;

/**
 * Every secret this stack holds: the `stack.env` values that are secrets
 * (including the database password), the owner password, the auth secret in
 * the spec's own environment, and the one-time enrollment token once written.
 */
function secretsOf(context: Control): string[] {
  let stackEnv: StackEnv = {};
  try {
    stackEnv = readStackEnv(context.stackEnvFile);
  } catch {
    // An unreadable stack.env still leaves the ambient secrets to scrub.
  }
  const ambient = runtime.env();
  const extra: (string | undefined)[] = [
    ambient.BAKERY_REAL_PASSWORD,
    ambient.BETTER_AUTH_SECRET,
    ambient.DATABASE_URL,
  ];
  const tokenFile = `${context.stateDirectory}/enrollment-token`;
  try {
    if (existsSync(tokenFile)) {
      extra.push(readFileSync(tokenFile, "utf8").trim());
    }
  } catch {
    // The token file is optional evidence of a scrub, not a requirement.
  }
  return stackSecretValues(stackEnv, extra);
}

/** The text of `error` with every secret value removed, and bounded. */
function failure(context: Control, error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return scrubSecrets(text, secretsOf(context)).slice(0, MAX_FAILURE_LENGTH);
}

/**
 * Logs a failed call and returns the error to throw: a new error whose
 * message is scrubbed, so a child's stderr (which `execFile` copies into its
 * message) cannot carry a secret into the fault log, the Playwright report or
 * the evidence.
 */
function logged(context: Control, label: string, error: unknown): Error {
  const message = failure(context, error);
  record(context, `FAILED ${label}${label === "" ? "" : " "}${message}`);
  return new Error(message);
}

/** Runs `docker compose` for the proof project with the stack.env environment. */
async function compose(
  context: Control,
  environment: Record<string, string>,
  args: readonly string[],
  timeout: number,
): Promise<string> {
  const { stdout } = await runtime.run("docker", [
    "compose",
    "--project-name",
    context.project,
    "-f",
    composeFile,
    ...args,
  ], {
    cwd: repositoryRoot,
    env: environment,
    timeout,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

/** `docker compose port`: the published `<host>:<port>` of a container port. */
async function publishedAddress(
  context: Control,
  environment: Record<string, string>,
  service: RestartableService,
): Promise<string> {
  const output = await compose(context, environment, [
    "port",
    service,
    String(SERVICES[service].containerPort),
  ], 60_000);
  const address = output.trim().split("\n")[0]?.trim() ?? "";
  if (!/:\d+$/.test(address)) {
    throw new Error(`M1_PUBLISHED_PORT_MISSING:${service}`);
  }
  return address;
}

async function pollOk(
  context: Control,
  target: string,
  timeoutMilliseconds: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  let last = "no response";
  for (;;) {
    try {
      const response = await runtime.fetch(target, {
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) {
        record(context, `ok ${target} status=${response.status}`);
        return;
      }
      last = `status ${response.status}`;
    } catch (error) {
      last = failure(context, error);
    }
    if (Date.now() >= deadline) {
      const message = scrubSecrets(
        `M1_WAIT_READY_TIMEOUT:${target}:${last}`,
        secretsOf(context),
      );
      record(context, `FAILED timeoutMs=${timeoutMilliseconds} ${message}`);
      throw new Error(message);
    }
    await runtime.sleep(1_000);
  }
}

/** Polls `<url>/health/ready` until it answers 2xx or the timeout passes. */
export async function waitReady(
  url: string,
  timeoutMs: number,
): Promise<void> {
  const context = control("waitReady");
  await pollOk(context, `${url.replace(/\/+$/, "")}/health/ready`, timeoutMs);
}

/**
 * Stops a service, starts it again with all of `stack.env`, and fails if the
 * published port differs from the one before or from the pinned value.
 */
async function restartService(
  operation: string,
  service: RestartableService,
): Promise<void> {
  const context = control(operation);
  const { portKey } = SERVICES[service];
  try {
    // Fails closed (and is logged) on a stack.env that lost a variable.
    const stackEnv = readStackEnv(context.stackEnvFile);
    const environment = composeEnvironment(runtime.env(), stackEnv);
    const before = await publishedAddress(context, environment, service);
    if (!before.endsWith(`:${stackEnv[portKey]}`)) {
      throw new Error(`M1_PORT_NOT_PINNED:${service}`);
    }
    record(context, `stop service=${service} port=${before}`);
    await compose(context, environment, ["stop", service], 120_000);
    record(context, `up service=${service} (--no-deps --wait)`);
    await compose(
      context,
      environment,
      ["up", "-d", "--no-deps", "--wait", service],
      300_000,
    );
    const after = await publishedAddress(context, environment, service);
    if (after !== before) {
      throw new Error(`M1_PORT_CHANGED:${service}:${before}->${after}`);
    }
    record(context, `up service=${service} port=${after} (unchanged)`);
    const base = `http://127.0.0.1:${stackEnv[portKey]}`;
    if (service === "server") {
      await pollOk(context, `${base}/health/ready`, 180_000);
    } else {
      await pollOk(context, `${base}/health`, 120_000);
    }
  } catch (error) {
    throw logged(context, `service=${service}`, error);
  }
}

/** Stops and starts the API server with the first-start environment. */
export function restartServer(): Promise<void> {
  return restartService("restartServer", "server");
}

/** Stops and starts the Inngest engine with the first-start environment. */
export function restartInngest(): Promise<void> {
  return restartService("restartInngest", "inngest");
}

/**
 * Runs one of the state-dir scripts the orchestrator wrote, with the
 * allow-listed environment of `stateScriptEnvironment`, never `process.env`.
 */
async function runStateScript(
  operation: string,
  script: "worker-kill.sh" | "worker-launch.sh",
): Promise<void> {
  const context = control(operation);
  const path = `${context.stateDirectory}/${script}`;
  if (!existsSync(path)) {
    record(context, `FAILED ${script} missing`);
    throw new Error(`M1_STATE_SCRIPT_MISSING:${script}`);
  }
  record(context, `run ${script}`);
  try {
    const environment = stateScriptEnvironment(
      runtime.env(),
      readStackEnv(context.stackEnvFile),
    );
    await runtime.run("bash", [path], {
      cwd: context.stateDirectory,
      env: environment,
      timeout: 180_000,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    const stderr = (error as { stderr?: unknown }).stderr;
    record(
      context,
      `FAILED ${script} exit=${String(code)} ${
        scrubSecrets(
          typeof stderr === "string" ? stderr.slice(-400) : "",
          secretsOf(context),
        )
      }`,
    );
    throw new Error(`M1_STATE_SCRIPT_FAILED:${script}:${String(code)}`);
  }
  record(context, `done ${script} exit=0`);
}

/** Kills the worker unit mid-run (`<state>/worker-kill.sh`). */
export function killWorker(): Promise<void> {
  return runStateScript("killWorker", "worker-kill.sh");
}

/**
 * Starts the worker unit again (`<state>/worker-launch.sh`, which resets the
 * harness clone first).
 */
export function startWorker(): Promise<void> {
  return runStateScript("startWorker", "worker-launch.sh");
}

type DatabaseResult = { sql: string; rowCount: number | null };

/** One call of the owner-database helper `tests/helpers/m1-stack-db.ts`. */
async function database<T extends DatabaseResult>(
  context: Control,
  args: readonly string[],
): Promise<T> {
  const stackEnv = readStackEnv(context.stackEnvFile);
  const url = stackEnv.DATABASE_URL;
  if (!url) throw new Error("M1_STACK_ENV_MISSING:DATABASE_URL");
  const { stdout } = await runtime.run("deno", [
    "run",
    "--allow-env",
    "--allow-read",
    "--allow-net",
    databaseScript,
    ...args,
  ], {
    cwd: repositoryRoot,
    env: databaseHelperEnvironment(runtime.env(), url),
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(stdout.trim().split("\n").at(-1) ?? "null") as T;
}

/**
 * Settled installation spend in USD, read only, as the exact numeric text the
 * database holds (never a float).
 */
export async function spendSettledUsd(): Promise<string> {
  const context = control("spendSettledUsd");
  try {
    const result = await database<
      DatabaseResult & { totalUsd: string | null }
    >(context, ["spend"]);
    if (result.totalUsd === null) throw new Error("M1_SPEND_UNREADABLE");
    record(context, `totalUsd=${result.totalUsd} (read only)`);
    return result.totalUsd;
  } catch (error) {
    throw logged(context, "", error);
  }
}

/**
 * The status the sweep stored for a question or approval, read only. An API
 * read returns the effective (read-through) status, which proves nothing about
 * the sweep.
 */
export async function storedStatus(questionId: string): Promise<string> {
  const context = control("storedStatus");
  try {
    const result = await database<DatabaseResult & { status: string }>(
      context,
      ["status", questionId],
    );
    record(
      context,
      `questionId=${questionId} status=${result.status} (read only)`,
    );
    return result.status;
  } catch (error) {
    throw logged(context, `questionId=${questionId}`, error);
  }
}

export type CoordinatorTurnModel = {
  turnId: string;
  attemptStatus: string;
  model: string | null;
  claudeCodeVersion: string | null;
};

/**
 * The model each coordinator turn of a conversation ran on, read only. A
 * coordinator turn has no output stream and no usage record, so the worker's
 * result stored on the job attempt is the only place the model is recorded.
 */
export async function coordinatorModels(
  conversationId: string,
): Promise<CoordinatorTurnModel[]> {
  const context = control("coordinatorModels");
  try {
    const result = await database<
      DatabaseResult & { rows: CoordinatorTurnModel[] }
    >(context, ["coordinator-models", conversationId]);
    record(
      context,
      `conversationId=${conversationId} turns=${result.rows.length} models=${
        result.rows.map((row) => row.model ?? "none").join(",")
      } (read only)`,
    );
    return result.rows;
  } catch (error) {
    throw logged(context, `conversationId=${conversationId}`, error);
  }
}

/**
 * Appends an operator step to `fault-log.txt` as a JSON object and prints it
 * for the Playwright log (used by `createFirstAdmin`).
 */
function recordOperatorStep(
  context: Control,
  step: Record<string, string | number>,
) {
  const line = JSON.stringify({ m1: "operator-step", ...step });
  record(context, line);
  console.log(line);
}

/**
 * Operator step 2, the recorded fallback for the first administrator:
 * `/setup` shows the local setup instructions and offers no way to create the
 * admin over HTTP, so this runs `tests/helpers/web-auth-seed.ts` (the
 * `createSuperuser` application code with argv instead of a terminal prompt).
 * The password travels in the child's environment, never argv, and is
 * scrubbed from every message. The logged command is the helper invocation
 * with the e-mail only.
 */
export async function createFirstAdmin(
  email: string,
  password: string,
): Promise<{ organizationId: string; status: string }> {
  const context = control("createFirstAdmin");
  const command =
    `deno run --allow-env --allow-read --allow-net tests/helpers/web-auth-seed.ts ${email}`;
  try {
    const stackEnv = readStackEnv(context.stackEnvFile);
    const { stdout } = await runtime.run("deno", [
      "run",
      "--allow-env",
      "--allow-read",
      "--allow-net",
      adminScript,
      email,
    ], {
      cwd: repositoryRoot,
      env: {
        ...stateScriptEnvironment(runtime.env(), stackEnv),
        WEB_AUTH_SEED_PASSWORD: password,
      },
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    });
    const result = JSON.parse(
      stdout.trim().split("\n").filter(Boolean).at(-1) ?? "{}",
    ) as { organizationId?: string; status?: string };
    if (!result.organizationId) {
      throw new Error(`M1_FIRST_ADMIN_NO_ORGANIZATION:${result.status ?? ""}`);
    }
    recordOperatorStep(context, {
      name: "first-admin-createsuperuser",
      command,
      exitCode: 0,
    });
    return {
      organizationId: result.organizationId,
      status: result.status ?? "",
    };
  } catch (error) {
    const message = failure(context, error);
    record(context, `FAILED ${message}`);
    recordOperatorStep(context, {
      name: "first-admin-createsuperuser",
      command,
      exitCode: 1,
    });
    throw new Error(message);
  }
}

/**
 * Operator step 3, the only owner-SQL write in the spec: moves one approval's
 * `expires_at` into the past. It runs exactly `FORCE_APPROVAL_EXPIRY_SQL`
 * (`m1-stack-env.ts`), logs the SQL text and the row count, and fails unless
 * one row changed. The `fault-log.txt` line keeps one shape the orchestrator
 * parses: `<iso> forceApprovalExpiry approvalId=<id> rowCount=<n> sql=<text>`.
 */
export async function forceApprovalExpiry(approvalId: string): Promise<void> {
  const context = control("forceApprovalExpiry");
  try {
    const result = await database<
      DatabaseResult & { approvalId: string }
    >(context, ["expire", approvalId]);
    if (result.rowCount !== 1) {
      throw new Error(`M1_APPROVAL_EXPIRY_ROW_COUNT:${result.rowCount}`);
    }
    record(
      context,
      `approvalId=${approvalId} rowCount=${result.rowCount} sql=${result.sql}`,
    );
    console.log(JSON.stringify({
      m1: "operator-step",
      name: "force-approval-expiry",
      approvalId,
      rowCount: result.rowCount,
      sql: result.sql,
    }));
  } catch (error) {
    throw logged(context, `approvalId=${approvalId}`, error);
  }
}

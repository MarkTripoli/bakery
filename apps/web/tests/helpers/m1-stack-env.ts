import { readFileSync } from "node:fs";

/**
 * Pure definitions for the M1 (#132) proof stack: the `stack.env` reader, the
 * restart environment, and the owner SQL the stack controls run. No Playwright
 * import and no side effect on load, so Deno (the unit test
 * `tests/unit/m1-stack-env_test.ts`, the orchestrator) and Node (Playwright)
 * both import it.
 *
 * `<state>/stack.env` is the complete first-start compose environment plus the
 * resolved host ports, written by `scripts/evidence/prove-m1.ts` as one
 * `KEY=value` per line (no quoting, no `export`, `#` comments allowed). Every
 * later compose call loads all of it, so a restart cannot drop a variable the
 * first start had (a dropped budget variable would leave the server without a
 * budget policy; a dropped port would let compose pick a new one).
 */

/**
 * Every key a restart needs. The orchestrator in `scripts/evidence` defines the
 * same list; the names must stay identical.
 */
export const REQUIRED_STACK_ENV_KEYS = [
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

export type RequiredStackEnvKey = (typeof REQUIRED_STACK_ENV_KEYS)[number];

/** Key pairs that name one value under two spellings (compose and SDK). */
export const EQUAL_STACK_ENV_PAIRS = [
  ["INNGEST_EVENT_KEY", "BAKERY_INNGEST_EVENT_KEY"],
  ["INNGEST_SIGNING_KEY", "BAKERY_INNGEST_SIGNING_KEY"],
] as const;

/** Host ports compose must publish again on a restart, never as port 0. */
export const PINNED_PORT_KEYS = [
  "BAKERY_WEB_PORT",
  "BAKERY_SERVER_PORT",
  "BAKERY_POSTGRES_PORT",
  "BAKERY_INNGEST_PORT",
] as const;

/** A parsed `stack.env`: every key and value exactly as written. */
export type StackEnv = Readonly<Record<string, string>>;

/**
 * Ambient variables a compose or docker child may inherit beyond `stack.env`:
 * what the docker CLI needs to find itself and its socket directory. Nothing
 * that compose interpolates (`BAKERY_*`, `INNGEST_*`, `BETTER_AUTH_SECRET`,
 * `DOCKER_HOST`) comes from the spec's own environment.
 */
export const AMBIENT_ENV_NAMES = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "XDG_RUNTIME_DIR",
  "DOCKER_CONFIG",
] as const;

/**
 * Parses `KEY=value` lines. The value is everything after the first `=`,
 * verbatim. Errors name a line number or a key, never a value.
 */
export function parseStackEnv(text: string): StackEnv {
  const parsed: Record<string, string> = {};
  text.split("\n").forEach((rawLine, index) => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.trim() === "" || line.trimStart().startsWith("#")) return;
    const separator = line.indexOf("=");
    const key = separator > 0 ? line.slice(0, separator) : "";
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`M1_STACK_ENV_LINE_INVALID:${index + 1}`);
    }
    if (Object.hasOwn(parsed, key)) {
      throw new Error(`M1_STACK_ENV_DUPLICATE_KEY:${key}`);
    }
    parsed[key] = line.slice(separator + 1);
  });
  return parsed;
}

/** Reads and parses the `stack.env` at `file`. */
export function readStackEnv(file: string): StackEnv {
  return parseStackEnv(readFileSync(file, "utf8"));
}

/**
 * The environment for every compose call after the first start: every
 * `stack.env` key and value, unchanged. It fails closed on a `stack.env` that
 * lacks a required key (or holds it empty), that holds an unresolved or
 * invalid pinned port, or whose paired keys disagree. Error messages name keys
 * only: the values are secrets.
 */
export function restartEnvironment(stackEnv: StackEnv): Record<string, string> {
  for (const key of REQUIRED_STACK_ENV_KEYS) {
    if (!Object.hasOwn(stackEnv, key)) {
      throw new Error(`M1_STACK_ENV_MISSING:${key}`);
    }
    if (stackEnv[key].trim() === "") {
      throw new Error(`M1_STACK_ENV_EMPTY:${key}`);
    }
  }
  for (const [first, second] of EQUAL_STACK_ENV_PAIRS) {
    if (stackEnv[first] !== stackEnv[second]) {
      throw new Error(`M1_STACK_ENV_PAIR_MISMATCH:${first}:${second}`);
    }
  }
  for (const key of PINNED_PORT_KEYS) {
    const port = Number(stackEnv[key]);
    if (!/^[0-9]+$/.test(stackEnv[key]) || port < 1 || port > 65_535) {
      throw new Error(`M1_STACK_ENV_PORT_INVALID:${key}`);
    }
  }
  return { ...stackEnv };
}

/**
 * The full child environment for a docker or compose call: the allow-listed
 * ambient variables first, then `restartEnvironment(stackEnv)` on top, so the
 * stack file is the only source of anything compose interpolates.
 */
export function composeEnvironment(
  ambient: Readonly<Record<string, string | undefined>>,
  stackEnv: StackEnv,
): Record<string, string> {
  const base: Record<string, string> = {};
  for (const name of AMBIENT_ENV_NAMES) {
    const value = ambient[name];
    if (value !== undefined) base[name] = value;
  }
  return { ...base, ...restartEnvironment(stackEnv) };
}

/**
 * Ambient variables the state-dir scripts (`worker-launch.sh`,
 * `worker-kill.sh`) need beyond the compose allow-list: `systemd-run --user`
 * and `systemctl --user` reach the user manager through the session bus.
 */
export const STATE_SCRIPT_EXTRA_ENV_NAMES = [
  "DBUS_SESSION_BUS_ADDRESS",
] as const;

/**
 * The child environment for a state-dir script: the same allow-listed
 * environment as a compose call (`composeEnvironment`: ambient `PATH`, `HOME`,
 * `XDG_RUNTIME_DIR` and the rest of `AMBIENT_ENV_NAMES`, then every
 * `stack.env` key) plus the session bus address when the spec has one. An
 * ambient `BAKERY_SCRIPTED_COORDINATOR_DIR`, `BAKERY_ENV=test` or other proof
 * variable therefore never reaches the worker launcher.
 */
export function stateScriptEnvironment(
  ambient: Readonly<Record<string, string | undefined>>,
  stackEnv: StackEnv,
): Record<string, string> {
  const environment = composeEnvironment(ambient, stackEnv);
  for (const name of STATE_SCRIPT_EXTRA_ENV_NAMES) {
    const value = ambient[name];
    if (value !== undefined && !Object.hasOwn(environment, name)) {
      environment[name] = value;
    }
  }
  return environment;
}

/**
 * The child environment for the owner-database helper
 * (`tests/helpers/m1-stack-db.ts`): the allow-listed ambient variables, any
 * `DENO_*` variable the Deno CLI needs (`DENO_DIR`), and the owner
 * `DATABASE_URL`. `readDatabaseConfig(env, "owner")` reads that one key, so
 * nothing else of the spec's environment (the owner password, the auth
 * secret, a stray proof variable) reaches the helper.
 */
export function databaseHelperEnvironment(
  ambient: Readonly<Record<string, string | undefined>>,
  databaseUrl: string,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(ambient)) {
    if (value === undefined) continue;
    if (
      (AMBIENT_ENV_NAMES as readonly string[]).includes(name) ||
      name.startsWith("DENO_")
    ) environment[name] = value;
  }
  environment.DATABASE_URL = databaseUrl;
  return environment;
}

/** Variable names whose values are secrets, wherever they appear. */
const SECRET_KEY_PATTERN =
  /(SECRET|TOKEN|PASSWORD|SIGNING_KEY|EVENT_KEY|CREDENTIAL|DATABASE_URL)/i;
/** Values shorter than this are never scrubbed: `1` or `true` are not secrets. */
const MIN_SECRET_LENGTH = 6;
/** A URL value that carries `user:password@`. */
const URL_WITH_CREDENTIALS = /^[a-z][a-z0-9+.-]*:\/\/[^/\s]*:[^/\s]*@/i;

function urlPassword(value: string): string | undefined {
  try {
    const password = new URL(value).password;
    return password === "" ? undefined : password;
  } catch {
    return undefined;
  }
}

/**
 * Every secret value to scrub from a log line or error message: each
 * `stack.env` value whose name says secret, token, password or key, each
 * value that is a URL carrying credentials (the whole URL and its password,
 * raw and percent-decoded), and the caller's `extra` values (the owner
 * password, the enrollment token). Longest first, so a URL is replaced whole
 * before its password is.
 */
export function stackSecretValues(
  stackEnv: StackEnv,
  extra: readonly (string | undefined)[] = [],
): string[] {
  const secrets = new Set<string>();
  const add = (value: string | undefined) => {
    if (value === undefined || value.length < MIN_SECRET_LENGTH) return;
    secrets.add(value);
    const escaped = JSON.stringify(value).slice(1, -1);
    if (escaped !== value) secrets.add(escaped);
  };
  for (const [key, value] of Object.entries(stackEnv)) {
    const credentialUrl = URL_WITH_CREDENTIALS.test(value);
    if (!SECRET_KEY_PATTERN.test(key) && !credentialUrl) continue;
    add(value);
    const password = urlPassword(value);
    if (password !== undefined) {
      add(password);
      try {
        add(decodeURIComponent(password));
      } catch {
        // An undecodable password is scrubbed in its raw form only.
      }
    }
  }
  for (const value of extra) add(value);
  return [...secrets].sort((left, right) => right.length - left.length);
}

/** Replaces every occurrence of every secret with `[redacted]`. */
export function scrubSecrets(
  text: string,
  secrets: readonly string[],
): string {
  let scrubbed = text;
  for (const secret of secrets) {
    if (secret !== "") scrubbed = scrubbed.split(secret).join("[redacted]");
  }
  return scrubbed;
}

/**
 * Operator step 3 of the M1 proof, the only owner-SQL write in the journey: it
 * moves one approval's expiry into the past so the real expiry path can act.
 * It is the statement `tests/integration/persist-scoped-workflow-approvals_test.ts`
 * uses, restricted to approvals. `$1` is the approval id.
 */
export const FORCE_APPROVAL_EXPIRY_SQL =
  "update bakery.questions set expires_at = now() - interval '1 minute' where id = $1 and kind = 'approval'";

/**
 * Read-only: the status the sweep stores. An API read returns the effective
 * (read-through) status, which proves nothing about the sweep. `$1` is the
 * question id.
 */
export const STORED_QUESTION_STATUS_SQL =
  "select status from bakery.questions where id = $1";

/** Read-only: settled spend across the installation budget accounts, as exact text. */
export const SETTLED_SPEND_SQL =
  "select coalesce(sum(settled_usd), 0)::text as total from bakery.budget_accounts where scope = 'installation'";

/**
 * Read-only: the model each coordinator turn of a conversation actually ran
 * on. A coordinator turn is a `coordinator.turn` worker job with no run step,
 * so it has no output stream and no `usage_records` row (those hang off run
 * steps); the worker's result is stored on the job attempt as
 * `{ "result": { "effects", "model", "claudeCodeVersion", "sessionId" } }`
 * (`CoordinatorTurnJobOutputSchema`). A failed attempt has no model. `$1` is
 * the conversation id.
 */
export const COORDINATOR_TURN_MODELS_SQL =
  'select turn.id::text as "turnId", attempt.status as "attemptStatus", attempt.result #>> \'{result,model}\' as model, attempt.result #>> \'{result,claudeCodeVersion}\' as "claudeCodeVersion" from bakery.conversation_turns turn join bakery.jobs job on job.organization_id = turn.organization_id and job.conversation_turn_id = turn.id join bakery.job_attempts attempt on attempt.organization_id = job.organization_id and attempt.job_id = job.id where turn.conversation_id = $1 order by turn.created_at, attempt.attempt_no';

import { isAbsolute, join, resolve, sep } from "node:path";
import {
  harnessAvailable,
  harnessExecutablePath,
  harnessProcessesAlive,
} from "./harness.ts";
export {
  CapturingOutputSink,
  gitText,
  harnessAvailable,
  harnessExecutablePath,
  harnessProcessesAlive,
  prepareScratchRepository,
  type ScratchRepository,
} from "./harness.ts";

/** Existing Codex test names remain available while the corpus goes generic. */
export function codexExecutablePath(): string {
  return harnessExecutablePath("codex");
}

export function codexProcessesAlive(): Promise<string[]> {
  return harnessProcessesAlive(codexExecutablePath(), "exec");
}

/**
 * The environment variable that opts the real-Codex cases in. It names a
 * dedicated test credential directory: absolute, existing, holding `auth.json`,
 * and never the operator's own login. Without it the cases are skipped.
 */
export const CODEX_TEST_AUTH_DIR_ENV = "BAKERY_TEST_CODEX_AUTH_DIR";

/** The file the worker copies out of a credential source directory. */
const AUTH_FILE = "auth.json";

type EnvReader = (name: string) => string | undefined;
type CodexProbe = (
  executable: string,
  env: Record<string, string>,
) => Promise<string | true>;

const processEnv: EnvReader = (name) => Deno.env.get(name);

function realPathOrResolved(path: string): string {
  try {
    return Deno.realPathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Every place the operator's own Codex login can be named. */
function operatorLoginDirectories(env: EnvReader): string[] {
  const home = env("HOME")?.trim();
  return [
    home ? join(home, ".codex") : undefined,
    env("CODEX_HOME")?.trim(),
    env("BAKERY_CODEX_AUTH_SOURCE_DIR")?.trim(),
  ].filter((path): path is string => Boolean(path))
    .map(realPathOrResolved);
}

/**
 * Whether a path is the operator's own Codex login or inside it. For
 * assertions that a child process never sees it; the only way a test may name
 * the login.
 */
export function isOperatorCodexLogin(
  path: string,
  env: EnvReader = processEnv,
): boolean {
  const real = realPathOrResolved(path);
  return operatorLoginDirectories(env).some((login) =>
    real === login || real.startsWith(login + sep)
  );
}

/**
 * The dedicated test credential directory, or the reason the real-Codex cases
 * must be skipped. It looks at nothing but the opt-in until the opt-in is
 * present, and no reason ever names a path.
 */
function dedicatedDirectory(
  env: EnvReader,
): { readonly dir: string } | { readonly reason: string } {
  const raw = env(CODEX_TEST_AUTH_DIR_ENV)?.trim();
  if (!raw) {
    return {
      reason:
        `${CODEX_TEST_AUTH_DIR_ENV} is not set: the real-Codex cases run only ` +
        "against a dedicated test credential directory, never the operator's own login",
    };
  }
  if (!isAbsolute(raw)) {
    return { reason: `${CODEX_TEST_AUTH_DIR_ENV} must be an absolute path` };
  }
  let real: string;
  try {
    if (!Deno.statSync(raw).isDirectory) throw new Error("not a directory");
    real = Deno.realPathSync(raw);
  } catch {
    return {
      reason: `${CODEX_TEST_AUTH_DIR_ENV} is not an existing directory`,
    };
  }
  if (isOperatorCodexLogin(real, env)) {
    return {
      reason: `${CODEX_TEST_AUTH_DIR_ENV} is the operator's own Codex login ` +
        "or inside it; use a separate dedicated directory",
    };
  }
  try {
    if (!Deno.statSync(join(real, AUTH_FILE)).isFile) {
      throw new Error("no file");
    }
  } catch {
    return { reason: `${CODEX_TEST_AUTH_DIR_ENV} holds no ${AUTH_FILE}` };
  }
  return { dir: raw };
}

/**
 * Whether the real-Codex cases may run, as `true` or the reason to skip them.
 * Without a valid opt-in it says so before probing anything. With one, the
 * probe runs with HOME and CODEX_HOME pointed at the dedicated directory, so
 * not even `codex --version` sees the operator's login.
 */
export async function codexTestCredentialGate(
  env: EnvReader,
  probe: CodexProbe,
  executable: string,
): Promise<string | true> {
  const resolved = dedicatedDirectory(env);
  if ("reason" in resolved) return resolved.reason;
  return await probe(executable, {
    HOME: resolved.dir,
    CODEX_HOME: resolved.dir,
  });
}

export function codexHarnessAvailable(): Promise<string | true> {
  return codexTestCredentialGate(
    processEnv,
    (executable, env) => harnessAvailable("codex", executable, env),
    codexExecutablePath(),
  );
}

/**
 * The credential directory the real-Codex cases use: the opt-in directory and
 * nothing else. It never falls back to `CODEX_HOME`,
 * `BAKERY_CODEX_AUTH_SOURCE_DIR` or `$HOME/.codex`, which are the operator's
 * own login. A case reaching it without a valid opt-in is a bug in the case,
 * which must be skipped on `codexHarnessAvailable()`.
 */
export function dedicatedCodexTestAuthSource(
  env: EnvReader = processEnv,
): string {
  const resolved = dedicatedDirectory(env);
  if ("reason" in resolved) {
    throw new Error(`CODEX_TEST_CREDENTIALS_REQUIRED: ${resolved.reason}`);
  }
  return resolved.dir;
}

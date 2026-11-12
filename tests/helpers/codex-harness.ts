import { userInfo } from "node:os";
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

/** The account's own home directory, which HOME may not name (unset, or elsewhere). */
type AccountHome = () => string | undefined;

const accountHomeDirectory: AccountHome = () => {
  try {
    return userInfo().homedir || undefined;
  } catch {
    return undefined;
  }
};

/** Every place the operator's own Codex login can be named. */
function operatorLoginDirectories(
  env: EnvReader,
  accountHome: AccountHome,
): string[] {
  const homes = [env("HOME")?.trim(), accountHome()?.trim()];
  return [
    ...homes.map((home) => home ? join(home, ".codex") : undefined),
    env("CODEX_HOME")?.trim(),
    env("BAKERY_CODEX_AUTH_SOURCE_DIR")?.trim(),
  ].filter((path): path is string => Boolean(path))
    .map(realPathOrResolved)
    .filter((path, index, all) => all.indexOf(path) === index);
}

/**
 * Whether a path is the operator's own Codex login or inside it. For
 * assertions that a child process never sees it; the only way a test may name
 * the login.
 */
export function isOperatorCodexLogin(
  path: string,
  env: EnvReader = processEnv,
  accountHome: AccountHome = accountHomeDirectory,
): boolean {
  const real = realPathOrResolved(path);
  return operatorLoginDirectories(env, accountHome).some((login) =>
    real === login || real.startsWith(login + sep)
  );
}

/**
 * Whether a file is the operator's login file itself, by identity and not by
 * path: a link to it is the same file under another name. Only metadata of the
 * operator's files is looked at, and only once an opt-in is present.
 */
function isOperatorAuthFile(
  info: Deno.FileInfo,
  env: EnvReader,
  accountHome: AccountHome,
): boolean {
  if (info.ino === null) return false;
  for (const login of operatorLoginDirectories(env, accountHome)) {
    try {
      const operator = Deno.statSync(join(login, AUTH_FILE));
      if (operator.dev === info.dev && operator.ino === info.ino) return true;
    } catch {
      // No login file there; nothing to be the same as.
    }
  }
  return false;
}

/**
 * The dedicated test credential directory, or the reason the real-Codex cases
 * must be skipped. It looks at nothing but the opt-in until the opt-in is
 * present, and no reason ever names a path.
 */
function dedicatedDirectory(
  env: EnvReader,
  accountHome: AccountHome,
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
  if (isOperatorCodexLogin(real, env, accountHome)) {
    return {
      reason: `${CODEX_TEST_AUTH_DIR_ENV} is the operator's own Codex login ` +
        "or inside it; use a separate dedicated directory",
    };
  }
  let info: Deno.FileInfo;
  try {
    // lstat: a link is looked at, not followed. The login file reached through
    // a symlink or a second hard link is still the operator's login.
    info = Deno.lstatSync(join(real, AUTH_FILE));
  } catch {
    return { reason: `${CODEX_TEST_AUTH_DIR_ENV} holds no ${AUTH_FILE}` };
  }
  if (info.isSymlink) {
    return {
      reason: `${CODEX_TEST_AUTH_DIR_ENV}'s ${AUTH_FILE} is a symbolic link; ` +
        "it must be a regular file of its own",
    };
  }
  if (!info.isFile) {
    return { reason: `${CODEX_TEST_AUTH_DIR_ENV} holds no ${AUTH_FILE}` };
  }
  if ((info.nlink ?? 1) > 1) {
    return {
      reason: `${CODEX_TEST_AUTH_DIR_ENV}'s ${AUTH_FILE} has more than one ` +
        "hard link; it must be a file of its own",
    };
  }
  if (isOperatorAuthFile(info, env, accountHome)) {
    return {
      reason: `${CODEX_TEST_AUTH_DIR_ENV}'s ${AUTH_FILE} is the operator's ` +
        "own login file",
    };
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
  accountHome: AccountHome = accountHomeDirectory,
): Promise<string | true> {
  const resolved = dedicatedDirectory(env, accountHome);
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
  accountHome: AccountHome = accountHomeDirectory,
): string {
  const resolved = dedicatedDirectory(env, accountHome);
  if ("reason" in resolved) {
    throw new Error(`CODEX_TEST_CREDENTIALS_REQUIRED: ${resolved.reason}`);
  }
  return resolved.dir;
}

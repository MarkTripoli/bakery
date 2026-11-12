import { SERVER_DISPATCH_LAUNCHER } from "../src/platform/server-exec.ts";
import { SENTRY_SERVER_ENVIRONMENT_NAMES } from "@bakery/config/sentry";

const allowedNames = [
  ...SENTRY_SERVER_ENVIRONMENT_NAMES,
  "BAKERY_PUBLIC_BASE_URL",
  "BAKERY_APP_DATABASE_URL",
  "BAKERY_ENV",
  "BAKERY_INNGEST_LOCAL_COMPOSE",
  "BAKERY_INNGEST_PRIVATE_HOST_SUFFIX",
  "DENO_DIR",
  "INNGEST_EVENT_KEY",
  "INNGEST_URL",
  "NODE_PG_FORCE_NATIVE",
  "PGBACKOFF",
  "PGAPPNAME",
  "PGBINARY",
  "PGCLIENT_ENCODING",
  "PGCONNECT_TIMEOUT",
  "PGDATABASE",
  "PGDEBUG",
  "PGFETCH_TYPES",
  "PGHOST",
  "PGKEEP_ALIVE",
  "PGMAX_LIFETIME",
  "PGMAX_PIPELINE",
  "PGOPTIONS",
  "PGPASSWORD",
  "PGPREPARE",
  "PGPUBLICATIONS",
  "PGREPLICATION",
  "PGSSL",
  "PGSSLMODE",
  "PGSSLNEGOTIATION",
  "PGTARGET_SESSION_ATTRS",
  "PGTARGETSESSIONATTRS",
  "PGUSER",
  "USER",
] as const;

function inheritedDispatchEnvironment(): Record<string, string | undefined> {
  const inherited: Record<string, string | undefined> = {
    PATH: Deno.env.get("PATH"),
  };
  for (const name of allowedNames) inherited[name] = Deno.env.get(name);
  return inherited;
}

export function dispatchEnvironment(
  inherited: Record<string, string | undefined> =
    inheritedDispatchEnvironment(),
): Record<string, string> {
  const environment: Record<string, string> = {
    PATH: inherited.PATH ?? "",
    FORCE_COLOR: "0",
  };
  for (const name of allowedNames) {
    const value = inherited[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

/**
 * The dispatcher child. The supervisor's only run grant is the fixed
 * launcher infra/server-exec/dispatch.sh, which execs this same Deno on
 * src/dispatch.ts with --allow-env --allow-net; granting Deno itself would let
 * the supervisor run anything through `deno eval`.
 */
export function createDispatchLaunch(
  inherited: Record<string, string | undefined> =
    inheritedDispatchEnvironment(),
): {
  command: string;
  args: readonly string[];
  clearEnv: true;
  env: Record<string, string>;
} {
  return {
    command: SERVER_DISPATCH_LAUNCHER,
    args: [],
    clearEnv: true,
    env: dispatchEnvironment(inherited),
  };
}

if (import.meta.main) {
  const launch = createDispatchLaunch();
  const child = new Deno.Command(launch.command, {
    args: [...launch.args],
    clearEnv: launch.clearEnv,
    env: launch.env,
    stdout: "inherit",
    stderr: "inherit",
  });
  const status = await child.output();
  Deno.exit(status.code);
}

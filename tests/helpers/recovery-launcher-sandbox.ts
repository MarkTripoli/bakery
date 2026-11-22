import { assert } from "@std/assert";
import { join } from "node:path";
import { installDenoWrapper } from "./backup-sandbox-release.ts";

/**
 * #50 AC3: a sandbox for scripts/deploy/recovery-launcher.sh. As in the
 * restore.sh tests, the host's own commands are stand-ins: `docker compose ps`
 * prints canned service states, `docker compose exec postgres psql` runs the
 * host's real psql against the test database, and runtime.sh only records its
 * calls. bash, node, curl and psql are real, so the launcher's own control flow
 * and its SQL against the real schema are what is under test.
 */

export const REPO = new URL("../../", import.meta.url).pathname;
export const LAUNCHER = join(REPO, "scripts/deploy/recovery-launcher.sh");

export type LauncherRun = { code: number; stdout: string; stderr: string };

export type LauncherSandbox = {
  dir: string;
  target: string;
  state: string;
  etc: string;
  opt: string;
  bin: string;
  calls: () => Promise<string[]>;
  run: (
    args: string[],
    env?: Record<string, string>,
  ) => Promise<LauncherRun>;
};

/** The URL psql uses inside the docker stand-in: the database owner's. */
export function adminDatabaseUrl(): string {
  const url = Deno.env.get("BAKERY_ADMIN_DATABASE_URL") ??
    Deno.env.get("DATABASE_URL");
  assert(url, "these tests need BAKERY_ADMIN_DATABASE_URL or DATABASE_URL");
  return url;
}

function hostBinary(name: string): string {
  const found = (Deno.env.get("PATH") ?? "").split(":")
    .map((directory) => join(directory, name))
    .find((candidate) => {
      try {
        return Deno.statSync(candidate).isFile;
      } catch {
        return false;
      }
    });
  assert(found !== undefined, `these tests need ${name} on the PATH`);
  return found;
}

export async function withLauncherSandbox(
  options: {
    healthUrl: string;
    /** Extra env-file lines, for the secret redaction tests. */
    infraEnv?: string;
    /** Extra text the compose stand-in prints in its service listing. */
    composeExtra?: string;
    /** A restore.sh stand-in body; the default records its call only. */
    restoreScript?: string;
    /** Exit code of the runtime.sh stand-in; it succeeds by default. */
    runtimeExit?: number;
    activeSha?: string;
  },
  body: (sandbox: LauncherSandbox) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "bakery-recovery-launcher-" });
  try {
    const bin = join(dir, "bin");
    const opt = join(dir, "opt/bakery");
    const state = join(dir, "var/lib/bakery");
    const etc = join(dir, "etc/bakery");
    const target = join(state, "release-target");
    const log = join(dir, "calls");
    for (
      const path of [
        bin,
        join(opt, "deploy"),
        join(state, "deploy"),
        etc,
        target,
      ]
    ) await Deno.mkdir(path, { recursive: true });
    await installDenoWrapper(bin);
    for (const name of ["node", "psql", "curl"]) {
      await Deno.writeTextFile(
        join(bin, name),
        `#!/bin/sh\nexec ${JSON.stringify(hostBinary(name))} "$@"\n`,
        { mode: 0o755 },
      );
    }
    await Deno.writeTextFile(
      join(etc, "infra.env"),
      `POSTGRES_PASSWORD=infra-postgres-password-not-for-reports\n${
        options.infraEnv ?? ""
      }`,
    );
    await Deno.writeTextFile(
      join(state, "deploy/state.json"),
      JSON.stringify({
        format: 1,
        active: { slot: "blue", sha: options.activeSha ?? "a".repeat(40) },
      }),
    );
    const stub = async (path: string, text: string) =>
      await Deno.writeTextFile(path, `#!/usr/bin/env bash\n${text}\n`, {
        mode: 0o755,
      });
    const services = [
      { Service: "postgres", State: "running", Health: "healthy" },
      { Service: "redis", State: "running", Health: "healthy" },
      { Service: "inngest", State: "running", Health: "" },
    ].map((line) => JSON.stringify(line)).join("\n");
    // psql gets everything after "-d bakery", against the test database.
    await stub(
      join(bin, "docker"),
      [
        `echo "docker $*" >> ${JSON.stringify(log)}`,
        `case "$*" in`,
        `  *" ps "*) cat <<'PS'\n${services}${
          options.composeExtra ? `\n${options.composeExtra}` : ""
        }\nPS\n  ;;`,
        `  *" exec "*psql*)`,
        `    while [[ $# -gt 0 && "$1" != -d ]]; do shift; done; shift 2`,
        `    exec psql ${JSON.stringify(adminDatabaseUrl())} "$@" ;;`,
        `esac`,
      ].join("\n"),
    );
    await stub(
      join(opt, "deploy/runtime.sh"),
      `echo "runtime $*" >> ${JSON.stringify(log)}${
        options.runtimeExit ? `\nexit ${options.runtimeExit}` : ""
      }`,
    );
    await stub(
      join(opt, "deploy/restore.sh"),
      `echo "restore $*" >> ${JSON.stringify(log)}\n${
        options.restoreScript ?? ""
      }`,
    );
    const run = async (args: string[], env: Record<string, string> = {}) => {
      const output = await new Deno.Command("bash", {
        args: [LAUNCHER, ...args],
        clearEnv: true,
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          HOME: dir,
          TMPDIR: dir,
          BAKERY_BACKUP_SANDBOX: dir,
          BAKERY_ENV: "test",
          BAKERY_RECOVERY_HEALTH_URL: options.healthUrl,
          BAKERY_RECOVERY_HEALTH_TRIES: "5",
          ...env,
        },
        stdout: "piped",
        stderr: "piped",
      }).output();
      return {
        code: output.code,
        stdout: new TextDecoder().decode(output.stdout),
        stderr: new TextDecoder().decode(output.stderr),
      };
    };
    await body({
      dir,
      target,
      state,
      etc,
      opt,
      bin,
      calls: async () => {
        try {
          return (await Deno.readTextFile(log)).trim().split("\n");
        } catch {
          return [];
        }
      },
      run,
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/**
 * A stand-in for the API's /health/ready: it answers as the release the
 * target's pointer names would, and a release in `broken` does not answer.
 */
export function startPointerHealth(target: string, broken: Set<string>) {
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    async (request) => {
      if (new URL(request.url).pathname !== "/health/ready") {
        return new Response("not found", { status: 404 });
      }
      try {
        const pointer = JSON.parse(
          await Deno.readTextFile(join(target, "current.json")),
        );
        if (broken.has(pointer.commitSha)) {
          return new Response("bad gateway", { status: 502 });
        }
        return Response.json({ version: pointer.commitSha, state: "ok" });
      } catch {
        return new Response("no release", { status: 503 });
      }
    },
  );
  return {
    url: `http://127.0.0.1:${server.addr.port}/health/ready`,
    stop: () => server.shutdown(),
  };
}

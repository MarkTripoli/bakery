import { basename, join } from "node:path";

/** A real Git worktree shared by every bounded coding-harness conformance lane. */
export type ScratchRepository = {
  dir: string;
  baseSha: string;
  notesPath: string;
};

export async function gitText(cwd: string, args: string[]): Promise<string> {
  const command = new Deno.Command("git", {
    args,
    cwd,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  if (output.code !== 0) {
    throw new Error(
      `SCRATCH_GIT_FAILED:${new TextDecoder().decode(output.stderr)}`,
    );
  }
  return new TextDecoder().decode(output.stdout).trim();
}

export async function prepareScratchRepository(
  prefix: string,
): Promise<ScratchRepository> {
  const dir = await Deno.makeTempDir({ prefix });
  for (
    const args of [
      ["init", "-b", "main", "."],
      ["config", "user.email", "bakery-test@bakery.local"],
      ["config", "user.name", "Bakery Test"],
    ]
  ) {
    await gitText(dir, args);
  }
  // Fixtures (fake executables, state dirs, markers) live beside the repo and
  // must not read as leftover edits to the clean-worktree guard. Ignored files
  // are allowed; any other new file stays visible to the guard and to the published patch.
  await Deno.writeTextFile(
    join(dir, ".git", "info", "exclude"),
    [
      "/fake-*",
      "/operator-*",
      "/state/",
      "/worker-state/",
      "/production-*",
      "/home/",
      "/agent/",
      "/auth-source",
      "/configured-auth",
      "/observed-*",
      "/args.txt",
      "/commands.txt",
      "/env.txt",
      "/prompt.txt",
      "/exec-ran.txt",
      "/pi-*.txt",
      "/session.jsonl",
      "/started",
      "/child*",
      "",
    ].join("\n"),
  );
  const notesPath = join(dir, "notes.txt");
  await Deno.writeTextFile(notesPath, "scratch repository baseline\n");
  await gitText(dir, ["add", "-A"]);
  await gitText(dir, ["commit", "-m", "baseline"]);
  return { dir, baseSha: await gitText(dir, ["rev-parse", "HEAD"]), notesPath };
}

/** Returns matching live processes for one harness executable and invocation. */
export async function harnessProcessesAlive(
  executable: string,
  invocation = "",
): Promise<string[]> {
  const name = basename(executable);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedInvocation = invocation.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );
  const pattern = escapedInvocation.length > 0
    ? `(^|/)${escaped} ${escapedInvocation}( |$)`
    : `(^|/)${escaped}( |$)`;
  const command = new Deno.Command("pgrep", {
    args: ["-a", "-f", pattern],
    stdin: "null",
    stdout: "piped",
    stderr: "null",
  });
  const output = await command.output();
  if (output.code !== 0) return [];
  const text = new TextDecoder().decode(output.stdout).trim();
  return text.length === 0 ? [] : text.split("\n");
}

function harnessEnvironmentPrefix(name: string): string {
  return name.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase();
}

export function harnessExecutablePath(
  name: string,
  fallback = name,
): string {
  const prefix = harnessEnvironmentPrefix(name);
  return Deno.env.get(`BAKERY_${prefix}_HARNESS_EXECUTABLE`)?.trim() ||
    fallback;
}

/** Probes only the configured executable; it never sends a coding prompt. */
export async function harnessAvailable(
  name: string,
  executable = harnessExecutablePath(name),
  /** Variables set over the inherited environment for the version probe. */
  env?: Readonly<Record<string, string>>,
): Promise<string | true> {
  if (executable !== "/" && !executable.includes("/")) {
    const probe = new Deno.Command(executable, {
      args: ["--version"],
      stdout: "piped",
      stderr: "piped",
      ...(env === undefined ? {} : { env: { ...env } }),
    });
    try {
      const result = await probe.output();
      if (!result.success) {
        return `the pinned ${name} CLI (${executable}) is not runnable on this host`;
      }
      return true;
    } catch {
      return `the pinned ${name} CLI (${executable}) is not installed on this host`;
    }
  }
  try {
    await Deno.stat(executable);
    return true;
  } catch {
    return `the pinned ${name} executable is missing: ${executable}`;
  }
}

/**
 * Resolves a harness executable without running it. The
 * `BAKERY_<NAME>_HARNESS_EXECUTABLE` override wins; a bare name is looked up
 * through `PATH`. Returns `undefined` when no regular file is found.
 */
export async function resolveHarnessExecutable(
  name: string,
): Promise<string | undefined> {
  const configured = harnessExecutablePath(name);
  const isFile = async (path: string): Promise<boolean> => {
    try {
      return (await Deno.stat(path)).isFile;
    } catch {
      return false;
    }
  };
  if (configured.includes("/")) {
    return await isFile(configured) ? configured : undefined;
  }
  for (const directory of (Deno.env.get("PATH") ?? "").split(":")) {
    if (directory.length === 0) continue;
    const candidate = join(directory, configured);
    if (await isFile(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Opt-in gate for real-CLI conformance. Returns `true` only when
 * `BAKERY_PROVIDER_REAL_CLI` lists the harness (`all` or a comma list), the
 * executable resolves, and `setsid <exe> --version` exits zero. Otherwise it
 * returns the reason the case is skipped.
 */
export async function realHarnessGate(name: string): Promise<string | true> {
  const listed = (Deno.env.get("BAKERY_PROVIDER_REAL_CLI") ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  if (!listed.includes("all") && !listed.includes(name)) {
    return `BAKERY_PROVIDER_REAL_CLI does not include ${name}`;
  }
  const executable = await resolveHarnessExecutable(name);
  if (executable === undefined) {
    return `the ${name} CLI is not installed on this host`;
  }
  try {
    const probe = await new Deno.Command("/usr/bin/setsid", {
      args: [executable, "--version"],
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).output();
    if (!probe.success) {
      return `the ${name} CLI (${executable}) is not runnable on this host`;
    }
  } catch {
    return `the ${name} CLI (${executable}) is not runnable on this host`;
  }
  return true;
}

/** Every captured output record flattened to one searchable string. */
export class CapturingOutputSink {
  readonly records: Array<{ channel: string; text: string }> = [];

  sink(): {
    write: (channel: "stdout" | "stderr", chunk: Uint8Array) => Promise<void>;
    sourceLost: (
      channel: "stdout" | "stderr",
      reason?: string,
    ) => Promise<void>;
  } {
    return {
      write: (channel, chunk) => {
        this.records.push({ channel, text: new TextDecoder().decode(chunk) });
        return Promise.resolve();
      },
      sourceLost: (channel, reason) => {
        this.records.push({ channel, text: `source-lost:${reason ?? ""}` });
        return Promise.resolve();
      },
    };
  }

  text(): string {
    return this.records.map((record) => record.text).join("");
  }
}

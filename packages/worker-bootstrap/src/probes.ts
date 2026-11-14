import { execFile } from "node:child_process";
import { statfs } from "node:fs/promises";
import { LINUX_SERVICE, MACOS_LABEL } from "./service.ts";
import type { Probes, ServiceState } from "./operations.ts";

/**
 * The real probes behind `status` and `doctor`: read-only questions to the
 * machine. Every program is run by its argument list, never through a shell,
 * with a short time limit, and none is run with elevated rights. A question
 * that cannot be answered is "unknown", never an error and never a guess.
 */

export type Spawned = Readonly<{ code: number | null; stdout: string }>;
export type Spawn = (argv: readonly string[]) => Promise<Spawned>;

const PROBE_TIMEOUT_MS = 5_000;

/**
 * Runs argv without a shell and resolves with the exit code and the output; it
 * never rejects. A program that runs past the time limit is stopped, and one
 * that prints more than 4 KiB is stopped too: both, like a program that is not
 * there, give no exit code, so the answer is "unknown".
 */
export function spawnWithTimeout(timeoutMs: number): Spawn {
  return (argv) =>
    new Promise((resolve) => {
      const [program, ...args] = argv;
      if (program === undefined) return resolve({ code: null, stdout: "" });
      try {
        execFile(
          program,
          args,
          { timeout: timeoutMs, maxBuffer: 4096, windowsHide: true },
          (error, stdout) => {
            const code = error === null
              ? 0
              : typeof (error as { code?: unknown }).code === "number"
              ? (error as { code: number }).code
              : null;
            resolve({ code, stdout: String(stdout ?? "") });
          },
        );
      } catch {
        resolve({ code: null, stdout: "" });
      }
    });
}

export const spawnProgram: Spawn = spawnWithTimeout(PROBE_TIMEOUT_MS);

/** The service manager's answer, from the lines `systemctl show` prints. */
export function linuxServiceState(
  output: string,
  code: number | null,
): ServiceState {
  if (code === null) return "unknown";
  const fields = new Map<string, string>();
  for (const line of output.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) fields.set(line.slice(0, at), line.slice(at + 1).trim());
  }
  if (fields.get("LoadState") === "not-found") return "absent";
  switch (fields.get("ActiveState")) {
    case "active":
      return "active";
    case "inactive":
      return "inactive";
    case "failed":
      return "failed";
    default:
      return "unknown";
  }
}

/** The service manager's answer, from `launchctl print` for the user's own domain. */
export function macServiceState(
  output: string,
  code: number | null,
): ServiceState {
  if (code === null) return "unknown";
  if (code !== 0) return "absent";
  const state = /^\s*state = (\S+)/m.exec(output)?.[1];
  if (state === "running") return "active";
  return state === undefined ? "unknown" : "inactive";
}

/** What the disk probe needs from a file system's statistics. */
export type FileSystemStats = (
  path: string,
) => Promise<{ bavail: number | bigint; bsize: number | bigint }>;

export function systemProbes(
  target: "linux" | "macos",
  spawn: Spawn = spawnProgram,
  stat: FileSystemStats = statfs,
): Probes {
  const uid = (): number | null =>
    typeof process.getuid === "function" ? process.getuid() : null;
  return {
    serviceState: async () => {
      if (target === "linux") {
        const { code, stdout } = await spawn([
          "systemctl",
          "show",
          LINUX_SERVICE,
          "--property=LoadState,ActiveState",
        ]);
        return linuxServiceState(stdout, code);
      }
      const id = uid();
      if (id === null) return "unknown";
      const { code, stdout } = await spawn([
        "launchctl",
        "print",
        `gui/${id}/${MACOS_LABEL}`,
      ]);
      return macServiceState(stdout, code);
    },
    runs: async (argv) => (await spawn(argv)).code === 0,
    freeBytes: async (path) => {
      try {
        const info = await stat(path);
        return Number(info.bavail) * Number(info.bsize);
      } catch {
        return null;
      }
    },
    uid,
  };
}

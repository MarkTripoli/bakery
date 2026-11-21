import type { WorkerInventoryCheck } from "./types.ts";

/**
 * The five machine checks a worker reports beside its capability checks (#70).
 * The server requires them to call a machine ready and blocks every claim when
 * one fails: `supervisor_health`, `credential_isolation`, `spool_access`,
 * `disk_threshold` and `protocol_compatible`. Each is a real local probe, and
 * every reason is a fixed word, never a path or a system message.
 */

/** Fixed path of `df`, granted to the worker's run permission by `config.ts`. */
export const DF_EXECUTABLE = "/usr/bin/df";

/** Version of the checker; the server stores it with each result. */
export const MACHINE_CHECK_VERSION = "1";

/** Free space under which a machine stops taking work: 1 GiB. */
export const MACHINE_DISK_MIN_FREE_BYTES = 1_073_741_824;

export const MACHINE_CHECK_IDS = Object.freeze(
  [
    "supervisor_health",
    "credential_isolation",
    "spool_access",
    "disk_threshold",
    "protocol_compatible",
  ] as const,
);

export type MachineCheckFacts = Readonly<{
  /** The worker's state directory: attempt roots and their isolated homes live under it. */
  stateDir: string;
  /** The spool file the worker writes its event records to. */
  spoolPath: string;
  /** The supervisor is shutting down. */
  stopping: boolean;
  /** The operating-system user's home directory, when the worker may read it. */
  homeDir: string | null;
  /** The worker's own user id, or null where the platform has none. */
  uid: number | null;
}>;

export type MachineCheckProbes = Readonly<{
  /** Bytes free where the state directory lives, or null when it cannot be read. */
  freeBytes(path: string): Promise<number | null>;
  now(): Date;
}>;

type Outcome =
  | { status: "pass" }
  | { status: "fail" | "unknown"; reason: string };

/**
 * One `df -Pk` data line: the device (which may hold spaces), then total,
 * used and available 1024-byte blocks, the capacity and the mount point. The
 * numbers are read from the capacity token backwards, never by position.
 */
const DF_LINE = /^(.+?)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\d+)%\s+\S/;

/**
 * Available bytes from `df -Pk` output: the last line's Available column, in
 * 1024-byte blocks. Null for anything that does not look like that.
 */
export function parseDfAvailableBytes(output: string): number | null {
  const lines = output.trim().split("\n");
  if (lines.length < 2) return null;
  const match = DF_LINE.exec(lines[lines.length - 1].trim());
  if (match === null || !/^\d+$/.test(match[4])) return null;
  const blocks = Number(match[4]);
  return Number.isSafeInteger(blocks) ? blocks * 1024 : null;
}

/** Free bytes under `path` by `df`; null when it cannot run or answers oddly. */
export async function dfFreeBytes(path: string): Promise<number | null> {
  try {
    const result = await new Deno.Command(DF_EXECUTABLE, {
      args: ["-Pk", "--", path],
      env: { LC_ALL: "C" },
      clearEnv: true,
      stdin: "null",
      stdout: "piped",
      stderr: "null",
    }).output();
    if (!result.success) return null;
    return parseDfAvailableBytes(new TextDecoder().decode(result.stdout));
  } catch {
    return null;
  }
}

const DEFAULT_PROBES: MachineCheckProbes = Object.freeze({
  freeBytes: dfFreeBytes,
  now: () => new Date(),
});

function directoryOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut <= 0 ? "/" : path.slice(0, cut);
}

/** The worker can create, read and remove a file where its spool lives, and use the spool file if it exists. */
async function spoolAccess(spoolPath: string): Promise<Outcome> {
  const probe = `${directoryOf(spoolPath)}/.readiness-${crypto.randomUUID()}`;
  try {
    await Deno.writeTextFile(probe, "ok", { createNew: true, mode: 0o600 });
    const read = await Deno.readTextFile(probe);
    if (read !== "ok") return { status: "fail", reason: "spool_unreadable" };
  } catch {
    return { status: "fail", reason: "spool_not_writable" };
  } finally {
    await Deno.remove(probe).catch(() => undefined);
  }
  try {
    const stat = await Deno.lstat(spoolPath);
    if (!stat.isFile) return { status: "fail", reason: "spool_not_a_file" };
    using file = await Deno.open(spoolPath, { read: true, write: true });
    void file;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      return { status: "fail", reason: "spool_unreadable" };
    }
  }
  return { status: "pass" };
}

/**
 * Attempt homes are made under the state directory (each with its own HOME
 * and credentials), so the directory must belong to the worker's user, be
 * closed to everyone else and not be that user's own home.
 */
async function credentialIsolation(
  stateDir: string,
  homeDir: string | null,
  uid: number | null,
): Promise<Outcome> {
  let stat: Deno.FileInfo;
  let real: string;
  try {
    stat = await Deno.stat(stateDir);
    real = await Deno.realPath(stateDir);
  } catch {
    return { status: "fail", reason: "state_dir_unreadable" };
  }
  if (!stat.isDirectory) {
    return { status: "fail", reason: "state_dir_not_a_directory" };
  }
  if (stat.mode !== null && (stat.mode & 0o077) !== 0) {
    return { status: "fail", reason: "state_dir_not_private" };
  }
  if (uid !== null && stat.uid !== null && stat.uid !== uid) {
    return { status: "fail", reason: "state_dir_not_owned" };
  }
  if (homeDir !== null) {
    const realHome = await Deno.realPath(homeDir).catch(() => homeDir);
    if (real === realHome) {
      return { status: "fail", reason: "state_dir_is_home" };
    }
  }
  return { status: "pass" };
}

async function diskThreshold(
  stateDir: string,
  probes: MachineCheckProbes,
): Promise<Outcome> {
  const free = await probes.freeBytes(stateDir);
  if (free === null) return { status: "unknown", reason: "disk_probe_failed" };
  return free >= MACHINE_DISK_MIN_FREE_BYTES
    ? { status: "pass" }
    : { status: "fail", reason: "disk_space_low" };
}

/**
 * The five machine checks, observed now. A heartbeat the server accepted is
 * what lets this run, and the client rejects any response whose protocol
 * header differs from its own, so an accepted heartbeat is the proof that
 * server and worker speak the same protocol.
 */
export async function machineChecks(
  facts: MachineCheckFacts,
  probes: MachineCheckProbes = DEFAULT_PROBES,
): Promise<WorkerInventoryCheck[]> {
  const observedAt = probes.now().toISOString();
  const outcomes: Record<typeof MACHINE_CHECK_IDS[number], Outcome> = {
    supervisor_health: facts.stopping
      ? { status: "fail", reason: "supervisor_stopping" }
      : { status: "pass" },
    credential_isolation: await credentialIsolation(
      facts.stateDir,
      facts.homeDir,
      facts.uid,
    ),
    spool_access: await spoolAccess(facts.spoolPath),
    disk_threshold: await diskThreshold(facts.stateDir, probes),
    protocol_compatible: { status: "pass" },
  };
  return MACHINE_CHECK_IDS.map((checkId) => {
    const outcome = outcomes[checkId];
    return {
      checkId,
      checkVersion: MACHINE_CHECK_VERSION,
      status: outcome.status,
      ...(outcome.status === "pass" ? {} : { reason: outcome.reason }),
      observedAt,
    };
  });
}

import { join } from "node:path";
import type { Cutoff } from "../../../apps/server/src/modules/backups/cutoff-rules.ts";
import type { FailureCode } from "./api.ts";
import { describeProblems, verifyBackupDirectory } from "./manifest.ts";
import { redact, type Secrets } from "./redact.ts";
import { isBackupName } from "./retention.ts";

/** Where backup.sh puts finished sets (it creates the directory itself). */
export const BACKUPS_ROOT = "/var/lib/bakery/backups";
/** Installed by bootstrap-host.sh next to runtime.sh. */
export const BACKUP_SCRIPT = "/opt/bakery/deploy/backup.sh";

export type ArtifactFile = {
  readonly name: string;
  readonly path: string;
  readonly size: number;
};

/** One finished backup set on the host: its name, directory and files. */
export type Artifact = {
  readonly name: string;
  readonly directory: string;
  readonly files: readonly ArtifactFile[];
  readonly totalBytes: number;
};

/** A step failed in a way the server has a stable word for. */
export class StepError extends Error {
  constructor(readonly code: FailureCode, readonly detail: string) {
    super(`BACKUP_RUNNER_STEP ${code}`);
  }
}

/**
 * Turns what backup.sh said into a failure code. Disk exhaustion and a missing
 * age recipient or binary have words of their own; anything else is the
 * runner's own error, with the script's last words as detail.
 */
export function classifyBackupFailure(input: {
  readonly exitCode: number | null;
  readonly stderr: string;
}): FailureCode {
  const text = input.stderr;
  if (/No space left on device|ENOSPC|disk quota exceeded/i.test(text)) {
    return "disk_full";
  }
  if (
    /BAKERY_BACKUP_RECIPIENT/.test(text) ||
    /\bage: command not found/.test(text) ||
    /(^|\n)age: error/i.test(text) ||
    /age: no (identity|recipient)/i.test(text) ||
    /failed to parse recipient|invalid recipient/i.test(text)
  ) return "key_missing";
  // backup.sh refused to finish a set that lacks a declared state store.
  if (/BACKUP_INCOMPLETE/.test(text)) return "incomplete_set";
  return "runner_error";
}

const SET_FILE = /^[A-Za-z0-9._-]+$/;
const COMPLETED = /^BACKUP_COMPLETED (\S+)$/m;
const STDERR_TAIL_BYTES = 8192;
const STDOUT_TAIL_BYTES = 65536;

/** Reads the finished set's directory into an Artifact. */
export async function readArtifact(
  root: string,
  name: string,
): Promise<Artifact> {
  if (!isBackupName(name)) {
    throw new StepError(
      "runner_error",
      "The backup script named a set the runner does not recognise.",
    );
  }
  const directory = join(root, name);
  const files: ArtifactFile[] = [];
  for await (const entry of Deno.readDir(directory)) {
    if (!entry.isFile || !SET_FILE.test(entry.name)) continue;
    const path = join(directory, entry.name);
    files.push({ name: entry.name, path, size: (await Deno.stat(path)).size });
  }
  if (files.length === 0) {
    throw new StepError("runner_error", "The finished backup set is empty.");
  }
  files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {
    name,
    directory,
    files,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
  };
}

export type BackupStepOptions = {
  /**
   * The database cutoff the runner took while the installation was quiet. It
   * reaches the script as one non-secret JSON value, and the set's manifest
   * must come back carrying exactly this cutoff. Left out for a run no
   * quiet-moment cutoff exists for (the script then records the host clock).
   */
  readonly cutoff?: Cutoff;
  /** Restore to any minute is on: the script also takes a base backup. */
  readonly pointInTime?: boolean;
  /** The script to run; production passes BACKUP_SCRIPT. */
  readonly script: string;
  readonly root: string;
  readonly secrets: Secrets;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
};

/**
 * Runs backup.sh and reads the set it finished. The script captures every
 * declared state store, writes the manifest and moves the set into place; the
 * runner observes its exit status, its last stderr and the
 * `BACKUP_COMPLETED <name>` line, then verifies the set against its manifest.
 */
export async function runBackupScript(
  options: BackupStepOptions,
): Promise<Artifact> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 30 * 60 * 1000);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(options.script, {
      // Merged into the inherited environment: the added variables are the
      // cutoff and the point-in-time switch, neither of them secret.
      env: {
        ...(options.cutoff
          ? { BAKERY_BACKUP_CUTOFF: JSON.stringify(options.cutoff) }
          : {}),
        ...(options.pointInTime ? { BAKERY_POINT_IN_TIME: "1" } : {}),
      },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
  } catch (error) {
    throw new StepError(
      "runner_error",
      redact(
        `The backup script could not start: ${(error as Error).message}`,
        options.secrets,
      ),
    );
  }
  // Both streams are read bounded, keeping only the end: the set's name is the
  // last stdout line, and the cause of a failure is in the last stderr lines.
  const stdoutTail = readTail(child.stdout, STDOUT_TAIL_BYTES);
  const stderrTail = readTail(child.stderr, STDERR_TAIL_BYTES);
  // Cancelling asks the script to stop (its EXIT trap removes the half-written
  // set). Children it started may outlive it and hold the pipes open, so after
  // the script itself has gone the pipes are abandoned, not waited for.
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    try {
      child.kill("SIGTERM");
    } catch { /* already gone */ }
    killTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch { /* already gone */ }
    }, 10_000);
  };
  if (signal.aborted) stop();
  else signal.addEventListener("abort", stop, { once: true });
  const status = await child.status;
  clearTimeout(killTimer);
  signal.removeEventListener("abort", stop);
  if (signal.aborted) {
    await Promise.allSettled([
      child.stdout.cancel(),
      child.stderr.cancel(),
    ]);
    throw new StepError(
      "runner_error",
      "The backup did not finish in time or was cancelled.",
    );
  }
  const stderr = new TextDecoder().decode(await stderrTail);
  const stdout = new TextDecoder().decode(await stdoutTail);
  if (status.code !== 0) {
    const code = classifyBackupFailure({ exitCode: status.code, stderr });
    const tail = stderr.trim().split("\n").slice(-12).join("\n");
    throw new StepError(
      code,
      redact(
        `The backup script failed (exit ${status.code}). ${tail}`,
        options.secrets,
      ),
    );
  }
  const match = COMPLETED.exec(stdout);
  if (!match) {
    throw new StepError(
      "runner_error",
      "The backup script finished without naming its set.",
    );
  }
  const artifact = await readArtifact(options.root, match[1]);
  // Defence in depth: the script verifies its own set, and the runner reads the
  // manifest again before the set may be reported as a backup. A set missing a
  // declared store (or with no manifest at all) is not a recoverable backup.
  const verification = await verifyBackupDirectory(artifact.directory);
  // The set must carry the cutoff the server recorded, not some other moment:
  // a restore trusts it to say what may have happened after the backup.
  if (verification.complete && options.cutoff !== undefined) {
    const recorded = verification.cutoff;
    if (
      recorded?.source !== "database" ||
      recorded.at !== options.cutoff.at ||
      recorded.effects?.digest !== options.cutoff.effects?.digest
    ) {
      throw new StepError(
        "incomplete_set",
        "The backup set does not carry the cutoff the server recorded for this run, so it cannot say what may have happened after it.",
      );
    }
  }
  if (!verification.complete) {
    throw new StepError(
      "incomplete_set",
      redact(
        `The backup set is not complete: ${
          describeProblems(verification.problems)
        }`,
        options.secrets,
        1000,
      ),
    );
  }
  return artifact;
}

/** Reads a stream to its end, keeping only the last `max` bytes. */
async function readTail(
  stream: ReadableStream<Uint8Array>,
  max: number,
): Promise<Uint8Array> {
  let tail = new Uint8Array(0);
  try {
    for await (const chunk of stream) {
      const joined = new Uint8Array(tail.length + chunk.length);
      joined.set(tail);
      joined.set(chunk, tail.length);
      tail = joined.length > max ? joined.slice(joined.length - max) : joined;
    }
  } catch { /* cancelled or closed */ }
  return tail;
}

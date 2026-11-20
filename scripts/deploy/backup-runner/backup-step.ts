import { join } from "node:path";
import type { FailureCode } from "./api.ts";
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
  /** The script to run; production passes BACKUP_SCRIPT. */
  readonly script: string;
  readonly root: string;
  readonly secrets: Secrets;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
};

/**
 * Runs the existing backup.sh unchanged and reads the set it finished. The
 * script keeps its own behaviour (dump both databases, encrypt to the public
 * recipient, tar the files, checksum, atomic rename); the runner only observes
 * its exit status, its last stderr and the `BACKUP_COMPLETED <name>` line.
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
  return await readArtifact(options.root, match[1]);
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

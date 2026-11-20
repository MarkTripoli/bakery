/**
 * Putting a blob where the sandbox can read it, and taking it away again.
 *
 * The probe describes bytes it can open as a file. A file-store deployment has
 * such a path already; the S3 store and the bytea store do not, so for those the
 * server writes one bounded copy into a spool directory the unit may read
 * (`ReadOnlyPaths=` in the launcher) and nothing else.
 *
 * Four rules, and each one is a test:
 *
 * - **Never write an oversize blob.** The size is compared with the probe's own
 *   limit before a byte is written, so a refusal costs no disk. The alternative
 *   — write, measure, delete — makes the server a temporary host for exactly the
 *   file it decided not to read.
 * - **Never name a blob.** The file is named with a random UUID, so a path in a
 *   process listing, an error message or a journal line names nothing about
 *   which organisation or which bytes are being probed.
 * - **Never outlive the probe.** `release()` runs in a `finally` that covers a
 *   refusal, a crash, a timeout and a cancelled request alike: the spool is
 *   removed on every path, not only the happy one.
 * - **Fail closed.** A missing or unwritable spool is `SandboxUnavailable`, so
 *   the version shows "no preview right now" rather than a description produced
 *   some other way.
 */

/** The spool could not be used; the caller reports `sandbox-unavailable`. */
export class SpoolUnavailableError extends Error {
  constructor(readonly reason: "missing" | "unwritable" | "no-space") {
    super(`PROBE_SPOOL_${reason.toUpperCase()}`);
    this.name = "SpoolUnavailableError";
  }
}

export type SpooledBlob = {
  /** The path the sandbox reads. Never contains the digest or the blob id. */
  readonly path: string;
  /** Removes the copy. Safe to call twice. */
  release(): Promise<void>;
};

/**
 * Writes one bounded copy into `dir` and returns it with its remover.
 *
 * `sizeBytes` is the size the server already knows; it is checked against
 * `maxBytes` here as well, because a caller that assembled the bytes itself
 * should not be trusted to have measured them.
 */
export async function spoolBlob(options: {
  dir: string;
  bytes: Uint8Array;
  sizeBytes?: number;
  maxBytes: number;
}): Promise<SpooledBlob> {
  const size = options.sizeBytes ?? options.bytes.byteLength;
  if (options.bytes.byteLength > options.maxBytes || size > options.maxBytes) {
    throw new SpoolUnavailableError("no-space");
  }
  const before = await lstatOrNull(options.dir);
  if (before === null || !before.isDirectory) {
    throw new SpoolUnavailableError("missing");
  }
  const path = `${
    options.dir.replace(/\/+$/, "")
  }/probe-${crypto.randomUUID()}.blob`;
  let file: Deno.FsFile;
  try {
    // Exclusive creation: a spool directory shared with anything else must not
    // let a pre-made path turn this write into an append to someone else's file.
    file = await Deno.open(path, {
      createNew: true,
      write: true,
      mode: 0o600,
    });
  } catch (error) {
    if (error instanceof Deno.errors.PermissionDenied) {
      throw new SpoolUnavailableError("unwritable");
    }
    throw error;
  }
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    try {
      await Deno.remove(path);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  };
  try {
    await file.write(options.bytes);
    return { path, release };
  } catch (error) {
    await release();
    throw error;
  } finally {
    file.close();
  }
}

async function lstatOrNull(path: string): Promise<Deno.FileInfo | null> {
  try {
    return await Deno.lstat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

/** Creates the spool directory so a deployment can start clean. */
export async function ensureSpoolDir(dir: string): Promise<void> {
  await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
}

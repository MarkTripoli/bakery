import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import { lstat, open as openFile } from "node:fs/promises";

/**
 * Reading a small record out of the install root. The root is a directory
 * anyone with write access to it could have changed, so a name there may be a
 * FIFO that never answers, a link to `/dev/zero` that never ends, a device, or
 * a file of any size: reading it whole would hang the command or fill memory.
 * A record is read only if it is a regular file (not a link, not a FIFO or
 * device) of at most `maxBytes`, checked before it is opened and again on the
 * open handle, and the whole read has a short deadline for the instant between
 * the two.
 */

/** More than any record this package writes (they are well under 4 KiB). */
export const MAX_RECORD_BYTES = 64 * 1024;
const DEADLINE_MS = 3_000;

export class UnreadableRecord extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "UnreadableRecord";
  }
}

export async function readRecord(
  path: string,
  maxBytes: number = MAX_RECORD_BYTES,
  deadlineMs: number = DEADLINE_MS,
  /** Opens the file; replaced only to prove what a stalled open does. */
  open: typeof openFile = openFile,
): Promise<string> {
  const work = (async () => {
    const before = await lstat(path);
    if (!before.isFile() || before.size > maxBytes) {
      throw new UnreadableRecord("not a plain small file");
    }
    // Never through a link, and never waiting on a FIFO: a name swapped for one
    // between the look above and this open fails here, and the handle's own
    // stat below is the second look.
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > maxBytes) {
        throw new UnreadableRecord("not a plain small file");
      }
      // The file read must be the very one the first look approved. Flags alone
      // do not promise that on every runtime (one that resolves a link before it
      // opens follows a swapped-in link), so the identity is compared too.
      if (info.dev !== before.dev || info.ino !== before.ino) {
        throw new UnreadableRecord("the file changed under the read");
      }
      const buffer = Buffer.alloc(maxBytes + 1);
      const { bytesRead } = await handle.read(buffer, 0, maxBytes + 1, 0);
      if (bytesRead > maxBytes) {
        throw new UnreadableRecord("not a plain small file");
      }
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new UnreadableRecord("no answer")),
      deadlineMs,
    );
  });
  try {
    return await Promise.race([work, stalled]);
  } finally {
    clearTimeout(timer);
  }
}

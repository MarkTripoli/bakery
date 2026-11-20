/**
 * The spool that lets the sandbox read bytes a store cannot hand over as a path.
 *
 * PM's decision (issue #437, 03:32Z) named four claims to prove rather than
 * assert: cleanup on success, on failure and on timeout; no write for an
 * oversize blob; and a spool that is missing or unwritable fails closed as
 * `sandbox-unavailable`. They are the four tests below.
 */
import { assertEquals, assertRejects } from "@std/assert";
import { join } from "node:path";
import {
  ensureSpoolDir,
  spoolBlob,
  SpoolUnavailableError,
} from "../../apps/server/src/modules/knowledge/spool.ts";

async function withSpoolDir(
  run: (dir: string) => Promise<void>,
  options: { mode?: number } = {},
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "bakery-spool-" });
  const dir = join(root, "spool");
  await ensureSpoolDir(dir);
  if (options.mode !== undefined) await Deno.chmod(dir, options.mode);
  try {
    await run(dir);
  } finally {
    await Deno.chmod(dir, 0o700).catch(() => {});
    await Deno.remove(root, { recursive: true });
  }
}

async function entries(dir: string): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(dir)) names.push(entry.name);
  return names.sort();
}

Deno.test("a successful probe leaves no copy behind", async () => {
  await withSpoolDir(async (dir) => {
    const spooled = await spoolBlob({
      dir,
      bytes: new Uint8Array([1, 2, 3, 4]),
      maxBytes: 1024,
    });
    // Readable while it is alive: the sandbox's whole reason for it.
    assertEquals(
      await Deno.readFile(spooled.path),
      new Uint8Array([1, 2, 3, 4]),
    );
    assertEquals((await Deno.stat(spooled.path)).mode! & 0o777, 0o600);
    await spooled.release();
    assertEquals(await entries(dir), []);
    // A second release is a no-op, not an error: cleanup runs in a `finally`.
    await spooled.release();
  });
});

Deno.test("a probe that fails still leaves no copy behind", async () => {
  await withSpoolDir(async (dir) => {
    const spooled = await spoolBlob({
      dir,
      bytes: new Uint8Array([9]),
      maxBytes: 1024,
    });
    // This is the `try/finally` a caller writes around the probe: the refusal
    // throws, and the spool is removed anyway.
    let threw = false;
    try {
      try {
        throw new Error("PROBE_REFUSED");
      } finally {
        await spooled.release();
      }
    } catch {
      threw = true;
    }
    assertEquals(threw, true);
    assertEquals(await entries(dir), []);
  });
});

Deno.test("a probe that times out leaves no copy behind", async () => {
  await withSpoolDir(async (dir) => {
    const spooled = await spoolBlob({
      dir,
      bytes: new Uint8Array([7]),
      maxBytes: 1024,
    });
    // A timeout arrives as a rejection from the bounded exchange, not as a
    // different kind of event, so the same `finally` has to cover it.
    await assertRejects(async () => {
      try {
        await new Promise((_, reject) =>
          setTimeout(() => reject(new Error("PROBE_TIMEOUT")), 1)
        );
      } finally {
        await spooled.release();
      }
    });
    assertEquals(await entries(dir), []);
  });
});

Deno.test("an oversize blob is never written at all", async () => {
  await withSpoolDir(async (dir) => {
    await assertRejects(
      () =>
        spoolBlob({
          dir,
          bytes: new Uint8Array(2048),
          maxBytes: 1024,
        }),
      SpoolUnavailableError,
    );
    // The point of checking first: the directory is untouched, so a file the
    // server refused to read never exists anywhere.
    assertEquals(await entries(dir), []);
  });
});

Deno.test("a declared size above the limit refuses before writing", async () => {
  await withSpoolDir(async (dir) => {
    await assertRejects(
      () =>
        spoolBlob({
          dir,
          bytes: new Uint8Array(4),
          sizeBytes: 4096,
          maxBytes: 1024,
        }),
      SpoolUnavailableError,
    );
    assertEquals(await entries(dir), []);
  });
});

Deno.test("a missing spool fails closed", async () => {
  const root = await Deno.makeTempDir({ prefix: "bakery-spool-" });
  try {
    await assertRejects(
      () =>
        spoolBlob({
          dir: join(root, "absent"),
          bytes: new Uint8Array([1]),
          maxBytes: 1024,
        }),
      SpoolUnavailableError,
      "PROBE_SPOOL_MISSING",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("an unwritable spool fails closed", async () => {
  await withSpoolDir(async (dir) => {
    await assertRejects(
      () =>
        spoolBlob({
          dir,
          bytes: new Uint8Array([1]),
          maxBytes: 1024,
        }),
      SpoolUnavailableError,
      "PROBE_SPOOL_UNWRITABLE",
    );
  }, { mode: 0o500 });
});

Deno.test("the spool path never names the blob", async () => {
  await withSpoolDir(async (dir) => {
    const spooled = await spoolBlob({
      dir,
      bytes: new Uint8Array([1]),
      maxBytes: 1024,
    });
    try {
      // A digest or a blob id in the name would leak which bytes are being
      // probed into any process listing or journal line that mentions the path.
      const name = spooled.path.slice(dir.length + 1);
      assertEquals(/^probe-[0-9a-f-]{36}\.blob$/.test(name), true, name);
    } finally {
      await spooled.release();
    }
  });
});

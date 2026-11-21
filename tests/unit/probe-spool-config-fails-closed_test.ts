/**
 * `BAKERY_PROBE_SPOOL_DIR` and the path from config to a probe answer.
 *
 * PM's decision (issue #437, 03:32Z) is that the spool is read through
 * `RuntimeConfig` and that a missing or unwritable directory is
 * `sandbox-unavailable`. Both halves are tested here: the reading, and the
 * refusal it produces.
 */
import { assertEquals, assertRejects } from "@std/assert";
import { join } from "node:path";
import {
  readProbeSpoolDirConfig,
  readRuntimeConfig,
} from "../../packages/config/src/env.ts";
import { probeBlob } from "../../apps/server/src/modules/knowledge/probe.ts";
import {
  forgetSandboxPreflight,
} from "../../apps/server/src/modules/knowledge/probe.ts";

/**
 * A database with no stored probe, that records what a write would have said.
 *
 * `stored` stays `undefined` when nothing was written, which is what a refusal
 * about the HOST must do -- unlike a refusal about the file, which is a fact
 * worth keeping.
 */
function memoryProbeDatabase() {
  const state: { writes: string[][] } = { writes: [] };
  return {
    state,
    database: {
      query: (text: string, args?: readonly unknown[]) => {
        if (/insert|update/i.test(text)) {
          // The status is the parameter that decides whether a row is worth
          // keeping, so recording it is enough to see which kind was written.
          state.writes.push(
            (args ?? []).filter((value) =>
              typeof value === "string"
            ) as string[],
          );
          return Promise.resolve({ rows: [] }) as never;
        }
        return Promise.resolve({ rows: [] }) as never;
      },
    },
  };
}

Deno.test("an unset spool is absent, not an empty directory", () => {
  assertEquals(readProbeSpoolDirConfig(undefined), undefined);
  assertEquals(readProbeSpoolDirConfig(""), undefined);
  assertEquals(readProbeSpoolDirConfig("   "), undefined);
});

Deno.test("a relative or control-character spool path is refused", () => {
  assertRejects(
    () => Promise.resolve().then(() => readProbeSpoolDirConfig("var/spool")),
    Error,
    "PROBE_SPOOL_DIR_INVALID",
  );
  assertRejects(
    () =>
      Promise.resolve().then(() =>
        readProbeSpoolDirConfig("/var/spool\u0000x")
      ),
    Error,
    "PROBE_SPOOL_DIR_INVALID",
  );
  assertEquals(readProbeSpoolDirConfig("/var/lib/bakery/probe"), {
    root: "/var/lib/bakery/probe",
  });
});

Deno.test("the server config carries the spool, and workers do not", () => {
  const env = {
    BAKERY_ENVIRONMENT: "test",
    BAKERY_PROBE_SPOOL_DIR: "/var/lib/bakery/probe",
  };
  assertEquals(
    readRuntimeConfig(env, "server").probeSpoolDir?.root,
    "/var/lib/bakery/probe",
  );
  // A worker process must not acquire the server's storage configuration.
  assertEquals(readRuntimeConfig(env, "worker").probeSpoolDir, undefined);
});

Deno.test("an invalid spool path is a start-up failure, not a silent default", () => {
  const config = readRuntimeConfig(
    { BAKERY_ENVIRONMENT: "test", BAKERY_PROBE_SPOOL_DIR: "relative/path" },
    "server",
  );
  assertEquals(config.invalidConfig.includes("BAKERY_PROBE_SPOOL_DIR"), true);
});

Deno.test("a store with no path and no spool is unavailable, not described", async () => {
  forgetSandboxPreflight();
  // No launcher could run here even if the call tried: the stub exits 64, and
  // the refusal must come from the missing spool before any launcher is asked.
  const db = memoryProbeDatabase();
  const result = await probeBlob(
    db.database as never as Parameters<typeof probeBlob>[0],
    {
      organizationId: "00000000-0000-4000-8000-000000000000",
      blobId: "00000000-0000-4000-8000-000000000001",
      sizeBytes: 4,
      readBytes: () => Promise.resolve(new Uint8Array([1, 2, 3, 4])),
    },
    { launcherPath: "/nonexistent/launcher.sh", spoolDir: undefined },
  );
  assertEquals(result.status, "refused");
  assertEquals(
    result.status === "refused" && result.code,
    "sandbox-unavailable",
  );
  assertEquals(db.state.writes, []);
});

Deno.test("bytes above the probe limit are refused without being read", async () => {
  let read = false;
  const db = memoryProbeDatabase();
  const result = await probeBlob(
    db.database as never as Parameters<typeof probeBlob>[0],
    {
      organizationId: "00000000-0000-4000-8000-000000000000",
      blobId: "00000000-0000-4000-8000-000000000001",
      sizeBytes: 64 * 1024 * 1024 + 1,
      readBytes: () => {
        read = true;
        return Promise.resolve(new Uint8Array(1));
      },
    },
    { launcherPath: "/nonexistent/launcher.sh", spoolDir: "/tmp" },
  );
  assertEquals(read, false, "an oversize blob is never loaded");
  assertEquals(result.status === "refused" && result.code, "too-large");
  // A refusal about the FILE is worth keeping even when nothing was read: the
  // next reader should be told the same thing without loading it either.
  assertEquals(db.state.writes.length, 1, "the refusal was recorded once");
  assertEquals(db.state.writes[0].includes("refused"), true);
});

Deno.test("a spool directory that cannot be used is unavailable, not a crash", async () => {
  const root = await Deno.makeTempDir({ prefix: "bakery-spool-config-" });
  try {
    const db = memoryProbeDatabase();
    const result = await probeBlob(
      db.database as never as Parameters<typeof probeBlob>[0],
      {
        organizationId: "00000000-0000-4000-8000-000000000000",
        blobId: "00000000-0000-4000-8000-000000000001",
        sizeBytes: 4,
        readBytes: () => Promise.resolve(new Uint8Array([1, 2, 3, 4])),
      },
      { launcherPath: join(root, "absent.sh"), spoolDir: join(root, "absent") },
    );
    assertEquals(
      result.status === "refused" && result.code,
      "sandbox-unavailable",
    );
    // A refusal about the HOST stores nothing, so a host that comes back is
    // asked again without anything having to clear a cache.
    assertEquals(db.state.writes, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

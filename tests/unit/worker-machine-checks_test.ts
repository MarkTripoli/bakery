import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  dfFreeBytes,
  MACHINE_CHECK_IDS,
  MACHINE_CHECK_VERSION,
  MACHINE_DISK_MIN_FREE_BYTES,
  type MachineCheckFacts,
  type MachineCheckProbes,
  machineChecks,
  parseDfAvailableBytes,
} from "../../apps/worker/src/machine-checks.ts";
import type { WorkerInventoryCheck } from "../../apps/worker/src/types.ts";

/**
 * Issue 70: the worker reports the five machine checks the server requires,
 * each from a real local probe, each with a path-free reason.
 */

const NOW = new Date("2026-11-21T14:00:00.000Z");

function probes(free: number | null): MachineCheckProbes {
  return { freeBytes: () => Promise.resolve(free), now: () => NOW };
}

async function withState<T>(
  work: (facts: MachineCheckFacts, directory: string) => Promise<T>,
  mode = 0o700,
): Promise<T> {
  const directory = await Deno.makeTempDir({ prefix: "bakery-machine-check-" });
  try {
    await Deno.chmod(directory, mode);
    return await work({
      stateDir: directory,
      spoolPath: `${directory}/spool.json`,
      stopping: false,
      homeDir: null,
      uid: Deno.uid(),
    }, directory);
  } finally {
    await Deno.chmod(directory, 0o700).catch(() => undefined);
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
}

const byId = (checks: readonly WorkerInventoryCheck[]) =>
  Object.fromEntries(checks.map((check) => [check.checkId, check]));

Deno.test("a healthy machine reports all five checks as passing, in the server's order", () =>
  withState(async (facts) => {
    const checks = await machineChecks(facts, probes(10 * 1024 ** 3));
    assertEquals(checks.map((c) => c.checkId), [...MACHINE_CHECK_IDS]);
    for (const check of checks) {
      assertEquals(check.status, "pass", check.checkId);
      assertEquals(check.checkVersion, MACHINE_CHECK_VERSION);
      assertEquals(check.observedAt, NOW.toISOString());
      assertEquals("reason" in check, false, "a pass carries no reason");
    }
  }));

Deno.test("free disk at the minimum passes, one byte below fails, and an unreadable disk is unknown", () =>
  withState(async (facts) => {
    const at = byId(
      await machineChecks(facts, probes(MACHINE_DISK_MIN_FREE_BYTES)),
    );
    assertEquals(at.disk_threshold.status, "pass");
    const below = byId(
      await machineChecks(facts, probes(MACHINE_DISK_MIN_FREE_BYTES - 1)),
    );
    assertEquals(below.disk_threshold.status, "fail");
    assertEquals(below.disk_threshold.reason, "disk_space_low");
    const unknown = byId(await machineChecks(facts, probes(null)));
    assertEquals(unknown.disk_threshold.status, "unknown");
    assertEquals(unknown.disk_threshold.reason, "disk_probe_failed");
    // The other four are unaffected by the disk.
    for (const id of MACHINE_CHECK_IDS) {
      if (id !== "disk_threshold") assertEquals(unknown[id].status, "pass", id);
    }
  }));

Deno.test("a state directory open to other users fails credential isolation", () =>
  withState(async (facts) => {
    const checks = byId(await machineChecks(facts, probes(2 ** 40)));
    assertEquals(checks.credential_isolation.status, "pass");
  }).then(() =>
    withState(async (facts) => {
      const checks = byId(await machineChecks(facts, probes(2 ** 40)));
      assertEquals(checks.credential_isolation.status, "fail");
      assertEquals(
        checks.credential_isolation.reason,
        "state_dir_not_private",
      );
      assertFalse(
        (checks.credential_isolation.reason ?? "").includes(facts.stateDir),
      );
    }, 0o750)
  ));

Deno.test("a state directory that is the user's home fails credential isolation", () =>
  withState(async (facts, directory) => {
    const checks = byId(
      await machineChecks({ ...facts, homeDir: directory }, probes(2 ** 40)),
    );
    assertEquals(checks.credential_isolation.status, "fail");
    assertEquals(checks.credential_isolation.reason, "state_dir_is_home");
  }));

Deno.test("a state directory owned by another user fails credential isolation", () =>
  withState(async (facts) => {
    const owner = facts.uid;
    if (owner === null) return;
    const checks = byId(
      await machineChecks({ ...facts, uid: owner + 1 }, probes(2 ** 40)),
    );
    assertEquals(checks.credential_isolation.status, "fail");
    assertEquals(checks.credential_isolation.reason, "state_dir_not_owned");
    // A platform with no user id cannot say who owns it: ownership is skipped.
    const unknownUser = byId(
      await machineChecks({ ...facts, uid: null }, probes(2 ** 40)),
    );
    assertEquals(unknownUser.credential_isolation.status, "pass");
  }));

Deno.test("a missing state directory fails credential isolation with a fixed reason", () =>
  withState(async (facts) => {
    const checks = byId(
      await machineChecks(
        { ...facts, stateDir: `${facts.stateDir}/absent` },
        probes(2 ** 40),
      ),
    );
    assertEquals(checks.credential_isolation.status, "fail");
    assertEquals(checks.credential_isolation.reason, "state_dir_unreadable");
  }));

Deno.test("spool access probes a real write, leaves nothing behind and uses an existing spool file", () =>
  withState(async (facts, directory) => {
    await Deno.writeTextFile(facts.spoolPath, "[]");
    const checks = byId(await machineChecks(facts, probes(2 ** 40)));
    assertEquals(checks.spool_access.status, "pass");
    const left = [];
    for await (const entry of Deno.readDir(directory)) left.push(entry.name);
    assertEquals(left, ["spool.json"], "the probe file is removed");
  }));

Deno.test("spool access fails when the spool directory cannot be written, or the spool is not a file", async () => {
  if (Deno.uid() !== 0) {
    await withState(async (facts, directory) => {
      await Deno.chmod(directory, 0o500);
      const checks = byId(await machineChecks(facts, probes(2 ** 40)));
      assertEquals(checks.spool_access.status, "fail");
      assertEquals(checks.spool_access.reason, "spool_not_writable");
      assertFalse((checks.spool_access.reason ?? "").includes(directory));
    });
  }
  await withState(async (facts) => {
    await Deno.mkdir(facts.spoolPath);
    const checks = byId(await machineChecks(facts, probes(2 ** 40)));
    assertEquals(checks.spool_access.status, "fail");
    assertEquals(checks.spool_access.reason, "spool_not_a_file");
  });
});

Deno.test("a stopping supervisor reports itself unhealthy", () =>
  withState(async (facts) => {
    const checks = byId(
      await machineChecks({ ...facts, stopping: true }, probes(2 ** 40)),
    );
    assertEquals(checks.supervisor_health.status, "fail");
    assertEquals(checks.supervisor_health.reason, "supervisor_stopping");
  }));

Deno.test("df output is read as available kibibytes, and anything else is refused", () => {
  const output =
    "Filesystem     1024-blocks      Used Available Capacity Mounted on\n" +
    "/dev/sda1        102400000  50000000  52400000      49% /\n";
  assertEquals(parseDfAvailableBytes(output), 52_400_000 * 1024);
  assertEquals(parseDfAvailableBytes(""), null);
  assertEquals(parseDfAvailableBytes("only one line"), null);
  assertEquals(
    parseDfAvailableBytes("h\n/dev/x 1 2 notanumber 49% /"),
    null,
  );
  assertEquals(parseDfAvailableBytes("h\n/dev/x 1 2 -5 49% /"), null);
  // A device name with a space still yields the Available column, not Used.
  assertEquals(
    parseDfAvailableBytes("h\n//srv/my share 1000 600 400 60% /mnt"),
    400 * 1024,
  );
  // So does a mount point with a space.
  assertEquals(
    parseDfAvailableBytes("h\n/dev/x 1000 600 400 60% /mnt/my disk"),
    400 * 1024,
  );
});

Deno.test("df is read when it may run, and an unavailable df makes the check unknown rather than throwing", async () => {
  const mayRun = Deno.permissions.querySync({
    name: "run",
    command: "/usr/bin/df",
  }).state === "granted";
  const free = await dfFreeBytes(Deno.cwd());
  if (mayRun) {
    // Lanes that may spawn it read the host's real free space.
    assert(free !== null && free > 0, "the host has some free space");
    assertEquals(await dfFreeBytes("/nonexistent/bakery-df-probe"), null);
  } else {
    // The unit lane names what it may spawn and does not list df: the probe
    // answers null, which the disk check reports as unknown.
    assertEquals(free, null);
  }
});

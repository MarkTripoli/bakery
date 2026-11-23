// Remote maintenance on the worker (issue #25, slice B2). The worker journals
// each operation durably before it changes anything, never runs a duplicate
// twice, and after a crash lets the release actually installed on disk decide
// the result. These tests use real directories, real renames and symlinks.
import { assert, assertEquals, assertFalse } from "@std/assert";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contractSchemas } from "../../packages/contracts/src/contracts.ts";
import {
  type ComponentRelease,
  type MaintenanceComponentAdapter,
  MaintenanceExecutor,
  MaintenanceJournalStore,
} from "../../apps/worker/src/maintenance.ts";
import {
  createReleaseDirectoryAdapter,
  type ReleaseArtifact,
  WORKER_COMPONENT_KEY,
  workerMaintenanceAdapters,
} from "../../apps/worker/src/maintenance-release.ts";
import { readMaintenanceRelease } from "../../apps/worker/src/config.ts";
import type {
  WorkerMaintenanceAssignment,
  WorkerMaintenanceReport,
} from "../../apps/worker/src/types.ts";

const COMPONENT = "harness.bakery";
const OLD = artifact("release 1.0", "1.0", 1);
const NEW = artifact("release 1.1", "1.1", 1);
const MIGRATING = artifact("release 2.0", "2.0", 2);

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function artifact(text: string, version: string, stateFormat: number) {
  const bytes = new TextEncoder().encode(text);
  return { bytes, version, stateFormat, digest: sha256(bytes) };
}

type Sent = { operationId: string; body: WorkerMaintenanceReport; key: string };

type Harness = {
  root: string;
  stateDir: string;
  sent: Sent[];
  fetches: number;
  healthy: boolean;
  /** Written to the component's state-format file by the health check. */
  migrateStateTo: number | null;
  switchHook: ((release: ComponentRelease) => Promise<void>) | null;
  reportFailure: ((sent: Sent) => unknown) | null;
  adapter: MaintenanceComponentAdapter;
  executor(adapters?: MaintenanceComponentAdapter[]): Promise<
    MaintenanceExecutor
  >;
};

async function withHarness(
  work: (harness: Harness) => Promise<void>,
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), "bakery-maintenance-"));
  const root = join(base, "component");
  const catalog = new Map(
    [OLD, NEW, MIGRATING].map((item) => [item.digest, item]),
  );
  const harness: Harness = {
    root,
    stateDir: join(base, "state"),
    sent: [],
    fetches: 0,
    healthy: true,
    migrateStateTo: null,
    switchHook: null,
    reportFailure: null,
    adapter: undefined as unknown as MaintenanceComponentAdapter,
    async executor(adapters) {
      return new MaintenanceExecutor({
        journal: await MaintenanceJournalStore.open(harness.stateDir),
        adapters: adapters ?? [harness.adapter],
        sleep: () => Promise.resolve(),
        log: () => undefined,
        report: (operationId, body, key) => {
          contractSchemas.WorkerMaintenanceReport.parse(body);
          const sent = { operationId, body, key };
          harness.sent.push(sent);
          const failure = harness.reportFailure?.(sent);
          return failure === undefined
            ? Promise.resolve()
            : Promise.reject(failure);
        },
      });
    },
  };
  const real = createReleaseDirectoryAdapter({
    componentKey: COMPONENT,
    root,
    fetchArtifact: (target): Promise<ReleaseArtifact> => {
      harness.fetches += 1;
      const found = catalog.get(target.digest);
      // An unknown digest is served the old bytes: the digest check fails.
      return Promise.resolve(found ?? OLD);
    },
    health: async () => {
      if (harness.migrateStateTo !== null) {
        await writeFile(
          join(root, "state-format"),
          String(harness.migrateStateTo),
        );
      }
      return harness.healthy;
    },
  });
  harness.adapter = {
    ...real,
    switchTo: async (release) => {
      if (harness.switchHook) return await harness.switchHook(release);
      await real.switchTo(release);
    },
  };
  try {
    // The host starts on the known-good 1.0 release.
    await real.switchTo(await real.stage(OLD));
    harness.fetches = 0;
    await work(harness);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

let fenceCounter = 10;
function assignment(
  overrides: Partial<WorkerMaintenanceAssignment> = {},
): WorkerMaintenanceAssignment {
  fenceCounter += 1;
  return {
    operationId: crypto.randomUUID(),
    workerHostId: crypto.randomUUID(),
    credentialGeneration: 1,
    verb: "update_component",
    componentKey: COMPONENT,
    targetVersion: NEW.version,
    targetDigest: NEW.digest,
    expectedInventoryRevision: 1,
    fence: String(fenceCounter),
    deadlineAt: new Date(Date.now() + 600_000).toISOString(),
    ...overrides,
  } as WorkerMaintenanceAssignment;
}

async function installedDigest(root: string): Promise<string> {
  const link = await readlink(join(root, "current"));
  return sha256(await readFile(join(root, link, "artifact")));
}

function phases(sent: Sent[]): string[] {
  return sent.map((item) =>
    `${item.body.sequence}:${item.body.phase}:${item.body.reason ?? ""}`
  );
}

/** Never settles: the process "crashes" while this step is in flight. */
function hang(): Promise<never> {
  return new Promise<never>(() => undefined);
}

Deno.test("an update stages, verifies, switches atomically and keeps the old release", () =>
  withHarness(async (harness) => {
    const executor = await harness.executor();
    const work = assignment();
    await executor.accept([work]);
    assertEquals(phases(harness.sent), ["1:applying:", "2:succeeded:"]);
    assertEquals(harness.sent[1]?.body.installedDigest, NEW.digest);
    assertEquals(harness.sent[1]?.body.installedVersion, "1.1");
    assertEquals(harness.sent[1]?.body.fence, work.fence);
    assertEquals(await installedDigest(harness.root), NEW.digest);
    // The previous release stays on disk for rollback.
    assertEquals(
      (await harness.adapter.release(OLD.digest))?.digest,
      OLD.digest,
    );
    assertFalse(executor.claimsClosed());
  }));

Deno.test("a duplicate assignment never re-executes; it resends the last report", () =>
  withHarness(async (harness) => {
    const executor = await harness.executor();
    const work = assignment();
    await executor.accept([work]);
    await executor.accept([work]);
    assertEquals(harness.fetches, 1);
    assertEquals(phases(harness.sent), [
      "1:applying:",
      "2:succeeded:",
      "2:succeeded:",
    ]);
    // The identical journaled report and idempotency key travel again.
    assertEquals(harness.sent[2], harness.sent[1]);
    // A restarted worker also replays rather than re-running.
    const restarted = await harness.executor();
    await restarted.accept([work]);
    assertEquals(harness.fetches, 1);
    assertEquals(harness.sent.at(-1), harness.sent[1]);
  }));

Deno.test("a crash before the switch recovers to failed switch_not_completed", () =>
  withHarness(async (harness) => {
    // The executor stages the release before it switches. The test lifts the
    // hook only once the executor is inside it, so a slow stage on a busy host
    // cannot let the switch run for real once the hook is gone.
    let switching = false;
    harness.switchHook = () => {
      switching = true;
      return hang();
    };
    const crashed = await harness.executor();
    const work = assignment();
    void crashed.accept([work]);
    while (harness.sent.length < 1 || !switching) {
      await new Promise((r) => setTimeout(r, 5));
    }
    // Claims stay closed while the journal entry is unfinished.
    assert(crashed.claimsClosed());
    harness.switchHook = null;
    const restarted = await harness.executor();
    assert(restarted.claimsClosed());
    await restarted.accept([]);
    assertEquals(phases(harness.sent), [
      "1:applying:",
      "2:failed:switch_not_completed",
    ]);
    assertEquals(harness.sent[1]?.body.installedDigest, OLD.digest);
    assertEquals(await installedDigest(harness.root), OLD.digest);
    assertFalse(restarted.claimsClosed());
  }));

Deno.test("a crash after the switch recovers to succeeded from the installed digest", () =>
  withHarness(async (harness) => {
    const real = createReleaseDirectoryAdapter({
      componentKey: COMPONENT,
      root: harness.root,
      fetchArtifact: () => Promise.resolve(NEW),
      health: () => Promise.resolve(true),
    });
    harness.switchHook = async (release) => {
      await real.switchTo(release);
      return await hang();
    };
    const crashed = await harness.executor();
    void crashed.accept([assignment()]);
    while ((await installedDigest(harness.root)) !== NEW.digest) {
      await new Promise((r) => setTimeout(r, 5));
    }
    harness.switchHook = null;
    const restarted = await harness.executor();
    await restarted.accept([]);
    // The sequence continues from the journal.
    assertEquals(phases(harness.sent), [
      "1:applying:",
      "2:succeeded:recovered",
    ]);
    assertEquals(harness.sent[1]?.body.installedDigest, NEW.digest);
    assertFalse(restarted.claimsClosed());
  }));

Deno.test("a failed health check never rolls back across an incompatible state migration", () =>
  withHarness(async (harness) => {
    harness.healthy = false;
    harness.migrateStateTo = 2;
    const executor = await harness.executor();
    await executor.accept([
      assignment({ targetDigest: MIGRATING.digest, targetVersion: "2.0" }),
    ]);
    assertEquals(phases(harness.sent), [
      "1:applying:",
      "2:failed:rollback_incompatible_state",
    ]);
    // The new release stays; the old one could not read the migrated state.
    assertEquals(await installedDigest(harness.root), MIGRATING.digest);
    assert(executor.claimsClosed());
  }));

Deno.test("a failed health check restores the compatible known-good release", () =>
  withHarness(async (harness) => {
    let checks = 0;
    harness.adapter = {
      ...harness.adapter,
      health: () => Promise.resolve(++checks > 1),
    };
    const executor = await harness.executor();
    await executor.accept([assignment()]);
    assertEquals(phases(harness.sent), [
      "1:applying:",
      "2:rolled_back:health_check_failed",
    ]);
    assertEquals(harness.sent[1]?.body.installedDigest, OLD.digest);
    assertEquals(await installedDigest(harness.root), OLD.digest);
    assertFalse(executor.claimsClosed());
  }));

Deno.test("a staged artifact with another digest is refused before any switch", () =>
  withHarness(async (harness) => {
    const executor = await harness.executor();
    await executor.accept([assignment({ targetDigest: "d".repeat(64) })]);
    assertEquals(phases(harness.sent), [
      "1:applying:",
      "2:failed:digest_mismatch",
    ]);
    assertEquals(await installedDigest(harness.root), OLD.digest);
  }));

Deno.test("an externally managed component is refused and never touched", () =>
  withHarness(async (harness) => {
    const touched: string[] = [];
    const external: MaintenanceComponentAdapter = {
      componentKey: "harness.external",
      installOwner: "external",
      supports: () => true,
      installed: () => {
        touched.push("installed");
        return Promise.resolve(null);
      },
      verify: () => Promise.resolve({ ok: true }),
      stage: () => {
        touched.push("stage");
        return Promise.reject(new Error("touched"));
      },
      release: () => Promise.resolve(null),
      switchTo: () => {
        touched.push("switch");
        return Promise.reject(new Error("touched"));
      },
      health: () => Promise.resolve(true),
      stateFormat: () => Promise.resolve(1),
      remove: () => {
        touched.push("remove");
        return Promise.reject(new Error("touched"));
      },
    };
    const executor = await harness.executor([harness.adapter, external]);
    await executor.accept([
      assignment({ componentKey: "harness.external" }),
      assignment({ componentKey: "harness.unknown" }),
    ]);
    assertEquals(phases(harness.sent), [
      "1:failed:externally_managed",
      "1:failed:unsupported",
    ]);
    assertEquals(touched, []);
  }));

Deno.test("an assignment under a fence older than the host's latest is ignored", () =>
  withHarness(async (harness) => {
    const executor = await harness.executor();
    await executor.accept([assignment({ verb: "verify", fence: "50" })]);
    const stale = assignment({ fence: "40" });
    await executor.accept([stale]);
    assertEquals(phases(harness.sent), ["1:succeeded:verified"]);
    assertEquals(await installedDigest(harness.root), OLD.digest);
    const journal = await MaintenanceJournalStore.open(harness.stateDir);
    assertEquals(journal.entry(stale.operationId), undefined);
    assertEquals(journal.hostFence, 50n);
  }));

Deno.test("a 403 report stops the operation locally as superseded", () =>
  withHarness(async (harness) => {
    harness.reportFailure = () => ({ status: 403, retryable: false });
    const executor = await harness.executor();
    const work = assignment();
    await executor.accept([work]);
    assertEquals(phases(harness.sent), ["1:applying:"]);
    assertEquals(await installedDigest(harness.root), OLD.digest);
    const journal = await MaintenanceJournalStore.open(harness.stateDir);
    assertEquals(journal.entry(work.operationId)?.outcome, "superseded");
    assertFalse(executor.claimsClosed());
  }));

Deno.test("transient report failures retry with the same journaled key", () =>
  withHarness(async (harness) => {
    let failures = 2;
    harness.reportFailure = () =>
      failures-- > 0 ? { status: 503, retryable: true } : undefined;
    const executor = await harness.executor();
    await executor.accept([assignment({ verb: "refresh_inventory" })]);
    assertEquals(harness.sent.length, 3);
    assertEquals(new Set(harness.sent.map((item) => item.key)).size, 1);
    const inventory = JSON.parse(harness.sent[2]?.body.diagnostic ?? "{}");
    assertEquals(inventory.components[0].installedDigest, OLD.digest);
  }));

Deno.test("an applying report the server never acknowledges changes nothing on disk", () =>
  withHarness(async (harness) => {
    harness.reportFailure = () => ({ status: 503, retryable: true });
    const executor = await harness.executor();
    const work = assignment();
    await executor.accept([work]);
    await executor.accept([work]);
    // Only the journaled "applying" report travels, always under one key.
    assert(harness.sent.length > 1);
    assert(harness.sent.every((item) => item.body.phase === "applying"));
    assertEquals(new Set(harness.sent.map((item) => item.key)).size, 1);
    assertEquals(harness.fetches, 0);
    assertEquals(await installedDigest(harness.root), OLD.digest);
    const journal = await MaintenanceJournalStore.open(harness.stateDir);
    assertEquals(journal.entry(work.operationId)?.localPhase, "accepted");
    assert(executor.claimsClosed());
  }));

Deno.test("an applying report acknowledged on a later heartbeat switches exactly once", () =>
  withHarness(async (harness) => {
    harness.reportFailure = () => ({ status: 503, retryable: true });
    const executor = await harness.executor();
    const work = assignment();
    await executor.accept([work]);
    assertEquals(await installedDigest(harness.root), OLD.digest);
    harness.reportFailure = null;
    // The server need not deliver it again: the next accepted heartbeat
    // resends the pending report and then continues.
    await executor.accept([]);
    await executor.accept([work]);
    assertEquals(harness.fetches, 1);
    assertEquals(await installedDigest(harness.root), NEW.digest);
    const finals = harness.sent.filter((item) =>
      item.body.phase !== "applying"
    );
    assertEquals(finals.map((item) => item.body.phase), [
      "succeeded",
      "succeeded",
    ]);
    assertEquals(finals[0], finals[1]);
    assertEquals(finals[0]?.body.sequence, 2);
    assertFalse(executor.claimsClosed());
  }));

Deno.test("an operation canceled while its applying report was pending is never applied", () =>
  withHarness(async (harness) => {
    harness.reportFailure = () => ({ status: 503, retryable: true });
    const executor = await harness.executor();
    const work = assignment();
    await executor.accept([work]);
    // The Admin canceled meanwhile: the server refuses the report.
    harness.reportFailure = () => ({ status: 409, retryable: false });
    await executor.accept([]);
    assertEquals(harness.fetches, 0);
    assertEquals(await installedDigest(harness.root), OLD.digest);
    assertFalse(executor.claimsClosed());
  }));

Deno.test("an unset release root configures no managed components", () => {
  assertEquals(readMaintenanceRelease({}), undefined);
  assertEquals(workerMaintenanceAdapters({}), []);
  let refused = "";
  try {
    readMaintenanceRelease({ BAKERY_WORKER_RELEASE_ROOT: "/opt/bakery" });
  } catch (error) {
    refused = (error as Error).message;
  }
  assertEquals(refused, "BAKERY_WORKER_RELEASE_SOURCE_DIR_REQUIRED");
});

Deno.test("a configured release root manages the worker's own release from the local source", async () => {
  const base = await mkdtemp(join(tmpdir(), "bakery-maintenance-config-"));
  try {
    const sourceDir = join(base, "source");
    for (const item of [OLD, NEW]) {
      await mkdir(join(sourceDir, item.digest), { recursive: true });
      await writeFile(join(sourceDir, item.digest, "artifact"), item.bytes);
      await writeFile(
        join(sourceDir, item.digest, "release.json"),
        JSON.stringify({ version: item.version, stateFormat: 1 }),
      );
    }
    // A source folder whose bytes do not match its name is refused.
    const forged = "e".repeat(64);
    await mkdir(join(sourceDir, forged), { recursive: true });
    await writeFile(join(sourceDir, forged, "artifact"), OLD.bytes);
    await writeFile(
      join(sourceDir, forged, "release.json"),
      JSON.stringify({ version: "9.9", stateFormat: 1 }),
    );
    const config = {
      maintenanceRelease: readMaintenanceRelease({
        BAKERY_WORKER_RELEASE_ROOT: join(base, "worker"),
        BAKERY_WORKER_RELEASE_SOURCE_DIR: sourceDir,
      }),
    };
    const adapters = workerMaintenanceAdapters(config);
    assertEquals(adapters.map((item) => item.componentKey), [
      WORKER_COMPONENT_KEY,
    ]);
    const [adapter] = adapters;
    await adapter!.switchTo(
      await adapter!.stage({ digest: OLD.digest, version: null }),
    );
    const sent: WorkerMaintenanceReport[] = [];
    const executor = new MaintenanceExecutor({
      journal: await MaintenanceJournalStore.open(join(base, "state")),
      adapters,
      log: () => undefined,
      report: (_id, body) => {
        sent.push(body);
        return Promise.resolve();
      },
    });
    await executor.accept([
      assignment({ verb: "refresh_inventory", componentKey: null }),
      assignment({ componentKey: WORKER_COMPONENT_KEY }),
      assignment({ componentKey: WORKER_COMPONENT_KEY, targetDigest: forged }),
    ]);
    assertEquals(JSON.parse(sent[0]?.diagnostic ?? "{}").components, [{
      componentKey: WORKER_COMPONENT_KEY,
      installOwner: "bakery",
      installedDigest: OLD.digest,
      installedVersion: "1.0",
    }]);
    assertEquals(sent[2]?.phase, "succeeded");
    assertEquals(sent[2]?.installedDigest, NEW.digest);
    assertEquals(sent[4]?.reason, "digest_mismatch");
    assertEquals(await installedDigest(join(base, "worker")), NEW.digest);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

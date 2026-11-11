import { assertEquals, assertRejects } from "@std/assert";
import { join } from "node:path";
import { SkillCache } from "../../apps/worker/src/skill-cache.ts";
import type { SkillCacheIdentity } from "../../apps/worker/src/types.ts";

const childPath = new URL(
  "../helpers/worker-skill-cache-child.ts",
  import.meta.url,
).pathname;
const configPath = new URL("../../deno.json", import.meta.url).pathname;
const identity: SkillCacheIdentity = Object.freeze({
  organizationId: "10000000-0000-4000-8000-000000000001",
  versionId: "50000000-0000-8000-8000-000000000005",
  digest: "a".repeat(64),
});

function spawnChild(
  mode: string,
  stateDir: string,
  markerPath: string,
  auxiliaryPath?: string,
): Deno.ChildProcess {
  return new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--config",
      configPath,
      "--allow-all",
      childPath,
      mode,
      stateDir,
      markerPath,
      ...(auxiliaryPath ? [auxiliaryPath] : []),
    ],
    stdout: "null",
    stderr: "inherit",
  }).spawn();
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await Deno.lstat(path);
      return;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`WAIT_FOR_FILE_TIMEOUT:${path}`);
}

async function bounded<T>(promise: Promise<T>, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(code)), 10_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function stop(child: Deno.ChildProcess): Promise<void> {
  try {
    child.kill("SIGKILL");
  } catch {
    // Child already settled.
  }
  await child.status.catch(() => undefined);
}

Deno.test("per-key OS lock aborts waiters and releases after holder process death", async () => {
  const stateDir = await Deno.makeTempDir({ prefix: "bakery-skill-lock-" });
  const marker = join(stateDir, "holder.locked");
  const holder = spawnChild("hold-lock", stateDir, marker);
  try {
    await waitForFile(marker);
    const cache = new SkillCache(stateDir);
    const waiting = new AbortController();
    let entered = false;
    const aborted = cache.withKeyLockForTest(identity, waiting.signal, () => {
      entered = true;
      return Promise.resolve();
    });
    setTimeout(() => waiting.abort(), 30);
    await assertRejects(() => aborted, DOMException, "Operation aborted");
    assertEquals(entered, false);

    let acquiredAfterCrash = false;
    const acquisition = cache.withKeyLockForTest(
      identity,
      new AbortController().signal,
      () => {
        acquiredAfterCrash = true;
        return Promise.resolve();
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    assertEquals(acquiredAfterCrash, false);
    holder.kill("SIGKILL");
    await holder.status;
    await bounded(acquisition, "LOCK_NOT_RELEASED_AFTER_CRASH");
    assertEquals(acquiredAfterCrash, true);

    const afterLockAbort = new AbortController();
    let mutated = false;
    const cancelAfterAcquisition = new SkillCache(
      await Deno.makeTempDir({ prefix: "bakery-skill-lock-abort-" }),
      { hooks: { afterLock: () => afterLockAbort.abort() } },
    );
    await assertRejects(
      () =>
        cancelAfterAcquisition.withKeyLockForTest(
          identity,
          afterLockAbort.signal,
          () => {
            mutated = true;
            return Promise.resolve();
          },
        ),
      DOMException,
      "Operation aborted",
    );
    assertEquals(mutated, false);
    await Deno.remove(
      join(cancelAfterAcquisition.rootPath, ".."),
      { recursive: true },
    );
  } finally {
    await stop(holder);
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("concurrent materializer processes serialize one cold fill and one zero-file warm reuse", async () => {
  const stateDir = await Deno.makeTempDir({ prefix: "bakery-skill-race-" });
  const gate = join(stateDir, "start");
  const firstDone = join(stateDir, "first.done");
  const secondDone = join(stateDir, "second.done");
  const first = spawnChild("materialize", stateDir, firstDone, gate);
  const second = spawnChild("materialize", stateDir, secondDone, gate);
  try {
    await Deno.writeTextFile(gate, "go\n", { createNew: true });
    const [firstStatus, secondStatus] = await bounded(
      Promise.all([first.status, second.status]),
      "CONCURRENT_MATERIALIZATION_TIMEOUT",
    );
    assertEquals(firstStatus.success, true);
    assertEquals(secondStatus.success, true);
    await waitForFile(firstDone);
    await waitForFile(secondDone);
    const events = (await Deno.readTextFile(`${gate}.log`)).trim().split("\n");
    assertEquals(events.filter((event) => event === "manifest").length, 5);
    assertEquals(events.filter((event) => event.startsWith("file:")).sort(), [
      "file:SKILL.md",
      "file:bin/run.sh",
    ]);
    const root = join(stateDir, "skill-materialization-v1");
    assertEquals([...Deno.readDirSync(join(root, "commits"))].length, 1);
    const key = [...Deno.readDirSync(join(root, "objects"))][0];
    assertEquals(
      [...Deno.readDirSync(join(root, "objects", key.name))].length,
      1,
    );
  } finally {
    await stop(first);
    await stop(second);
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("crash after exclusive commit link leaves a fully verifiable warm winner", async () => {
  const stateDir = await Deno.makeTempDir({
    prefix: "bakery-skill-commit-crash-",
  });
  const linked = join(stateDir, "linked");
  const crashing = spawnChild("crash-after-link", stateDir, linked);
  try {
    await waitForFile(linked);
    crashing.kill("SIGKILL");
    await crashing.status;
    const root = join(stateDir, "skill-materialization-v1");
    const commit = [...Deno.readDirSync(join(root, "commits"))][0];
    assertEquals(
      (await Deno.lstat(join(root, "commits", commit.name))).nlink,
      2,
    );

    const gate = join(stateDir, "warm-start");
    const done = join(stateDir, "warm.done");
    const warm = spawnChild("materialize", stateDir, done, gate);
    try {
      await Deno.writeTextFile(gate, "go\n", { createNew: true });
      const status = await bounded(warm.status, "WARM_RECOVERY_TIMEOUT");
      assertEquals(status.success, true);
      const events = (await Deno.readTextFile(`${gate}.log`)).trim().split(
        "\n",
      );
      assertEquals(events, ["manifest", "manifest"]);
    } finally {
      await stop(warm);
    }
  } finally {
    await stop(crashing);
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("startup recovery preserves unknown crash stages and deletes only server-proven stale owners", async () => {
  const stateDir = await Deno.makeTempDir({
    prefix: "bakery-skill-stage-crash-",
  });
  const marker = join(stateDir, "stage");
  const crashing = spawnChild("crash-after-stage", stateDir, marker);
  try {
    await waitForFile(marker);
    crashing.kill("SIGKILL");
    await crashing.status;
    const cache = new SkillCache(stateDir);
    await cache.initialize();
    const keyDirectory = [
      ...Deno.readDirSync(join(cache.rootPath, "objects")),
    ][0];
    const objectRoot = join(cache.rootPath, "objects", keyDirectory.name);
    assertEquals([...Deno.readDirSync(objectRoot)].length, 1);
    await cache.recover(
      () => Promise.resolve("unknown"),
      new AbortController().signal,
    );
    assertEquals([...Deno.readDirSync(objectRoot)].length, 1);
    await cache.recover(
      () => Promise.resolve("stale"),
      new AbortController().signal,
    );
    assertEquals([...Deno.readDirSync(objectRoot)].length, 0);
  } finally {
    await stop(crashing);
    await Deno.remove(stateDir, { recursive: true });
  }
});

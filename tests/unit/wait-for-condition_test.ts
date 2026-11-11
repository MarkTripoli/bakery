import { assertEquals, assertRejects } from "@std/assert";
import { RegistrationStore } from "../../apps/worker/src/registration-store.ts";
import { acquireStateLock } from "../../apps/worker/src/storage.ts";
import { waitForCondition } from "../helpers/worker-execution/recovery-support.ts";

function locked(): Error {
  return new Error("WORKER_STATE_LOCKED");
}

Deno.test("waitForCondition polls again after the worker state lock timed out a read", async () => {
  let reads = 0;
  await waitForCondition(() => {
    reads += 1;
    if (reads <= 2) throw locked();
    return true;
  }, "STATE_READ");
  assertEquals(reads, 3);
});

Deno.test("waitForCondition lets any other error from the check end the wait", async () => {
  let reads = 0;
  await assertRejects(
    () =>
      waitForCondition(() => {
        reads += 1;
        throw new Error("REGISTRATION_STATE_INVALID");
      }, "STATE_READ"),
    Error,
    "REGISTRATION_STATE_INVALID",
  );
  assertEquals(reads, 1);
});

Deno.test("waitForCondition still times out when the state stays locked and names the lock", async () => {
  const error = await assertRejects(
    () =>
      waitForCondition(
        () => Promise.reject(locked()),
        "STATE_READ",
        50,
      ),
    Error,
    "STATE_READ_TIMEOUT",
  );
  assertEquals((error.cause as Error).message, "WORKER_STATE_LOCKED");
});

Deno.test("waitForCondition reads a registration store whose lock is held past the 1s lock budget", async () => {
  const directory = await Deno.makeTempDir({ prefix: "wait-for-condition-" });
  try {
    const path = `${directory}/registration.json`;
    const store = new RegistrationStore(path);
    // The first read waits out the lock budget and throws WORKER_STATE_LOCKED;
    // the lock frees while the second read waits, and that read succeeds.
    const held = await acquireStateLock(`${path}.lock`);
    const released = new Promise<void>((resolve) =>
      setTimeout(() => void held.release().then(resolve), 1_400)
    );
    let loaded: unknown = "not read";
    await waitForCondition(async () => {
      loaded = await store.load();
      return true;
    }, "STATE_READ");
    assertEquals(loaded, null);
    await released;
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("waitForCondition names a lock error only while the state is still locked", async () => {
  let reads = 0;
  const error = await assertRejects(
    () =>
      waitForCondition(
        () => {
          reads += 1;
          if (reads === 1) throw locked();
          return false;
        },
        "STATE_READ",
        50,
      ),
    Error,
    "STATE_READ_TIMEOUT",
  );
  assertEquals(error.cause, undefined);
});

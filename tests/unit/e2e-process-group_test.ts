import { assertEquals, assertRejects } from "@std/assert";
import { terminateProcessGroup } from "../e2e/helpers/process-group.ts";

Deno.test("owned teardown waits for children after the launcher exits", async () => {
  const signals: string[] = [];
  let pauses = 0;
  await terminateProcessGroup({
    signal: (name) => {
      signals.push(name);
      return Promise.resolve();
    },
    alive: () => Promise.resolve(pauses < 3),
    exited: Promise.resolve({ code: 0 }),
  }, () => {
    pauses++;
    return Promise.resolve();
  });
  assertEquals(signals, ["TERM"]);
  assertEquals(pauses, 3);
});

Deno.test("owned teardown escalates lingering children even when the launcher exited", async () => {
  const signals: string[] = [];
  let alive = true;
  let pauses = 0;
  await terminateProcessGroup({
    signal: (name) => {
      signals.push(name);
      if (name === "KILL") alive = false;
      return Promise.resolve();
    },
    alive: () => Promise.resolve(alive),
    exited: Promise.resolve({ code: 0 }),
  }, () => {
    pauses++;
    return Promise.resolve();
  });
  assertEquals(signals, ["TERM", "KILL"]);
  assertEquals(pauses, 100);
});

Deno.test("owned teardown fails closed when its process group survives escalation", async () => {
  const signals: string[] = [];
  await assertRejects(
    () =>
      terminateProcessGroup({
        signal: (name) => {
          signals.push(name);
          return Promise.resolve();
        },
        alive: () => Promise.resolve(true),
        exited: Promise.resolve({ code: 0 }),
      }, () => Promise.resolve()),
    Error,
    "OWNED_PROCESS_GROUP_NOT_CLEANED",
  );
  assertEquals(signals, ["TERM", "KILL"]);
});

Deno.test("owned teardown still awaits the launcher exit after its group drains", async () => {
  let resolveExit!: () => void;
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  let groupDrained = false;
  let cleanupFinished = false;
  const cleanup = terminateProcessGroup({
    signal: () => Promise.resolve(),
    alive: () => {
      groupDrained = true;
      return Promise.resolve(false);
    },
    exited,
  }).then(() => {
    cleanupFinished = true;
  });
  try {
    // A new event-loop turn drains the helper's already-resolved awaits.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assertEquals(groupDrained, true);
    assertEquals(cleanupFinished, false);
  } finally {
    resolveExit();
    await cleanup;
  }
  assertEquals(cleanupFinished, true);
});

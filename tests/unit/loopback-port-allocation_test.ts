import {
  assert,
  assertEquals,
  AssertionError,
  assertRejects,
} from "@std/assert";
import {
  bindLoopbackPortWithRetry,
  type PortCollisionRetry,
  reserveUniqueLoopbackPort,
  retryOnPortCollision,
} from "../fixtures/loopback-port-allocation.ts";

// Tests that do not look at the announcement keep it off the unit output.
const quiet = () => {};

const rootlessCollision = (port: number) =>
  new Error(
    `driver failed programming external connectivity: error while calling RootlessKit PortManager.AddPort(): listen tcp4 127.0.0.1:${port}: bind: address already in use`,
  );

Deno.test("loopback allocation skips an occupied stack candidate", () => {
  const candidates = [41_001, 41_002];
  const allocated = new Set([41_001]);

  const selected = reserveUniqueLoopbackPort(
    allocated,
    () => candidates.shift()!,
  );

  assertEquals(selected, 41_002);
  assertEquals([...allocated], [41_001, 41_002]);
});

Deno.test("RootlessKit collision cleans only the owned attempt and retries a new port", async () => {
  const candidates = [42_001, 42_002];
  const allocated = new Set<number>();
  const bound: number[] = [];
  let ownedCleanupCount = 0;
  const unrelatedCleanupCount = 0;

  const selected = await bindLoopbackPortWithRetry({
    allocated,
    probe: () => candidates.shift()!,
    bind: (port) => {
      bound.push(port);
      if (port === 42_001) return Promise.reject(rootlessCollision(port));
      return Promise.resolve();
    },
    cleanupOwnedAttempt: () => {
      ownedCleanupCount++;
      return Promise.resolve();
    },
  });

  assertEquals(selected, 42_002);
  assertEquals(bound, [42_001, 42_002]);
  assertEquals(ownedCleanupCount, 1);
  assertEquals(unrelatedCleanupCount, 0);
  assertEquals([...allocated], [42_001, 42_002]);
});

Deno.test("RootlessKit collision retries are bounded and clean every owned attempt", async () => {
  const candidates = [43_001, 43_002, 43_003];
  let ownedCleanupCount = 0;

  await assertRejects(
    () =>
      bindLoopbackPortWithRetry({
        allocated: new Set<number>(),
        probe: () => candidates.shift()!,
        maxAttempts: 3,
        bind: (port) => Promise.reject(rootlessCollision(port)),
        cleanupOwnedAttempt: () => {
          ownedCleanupCount++;
          return Promise.resolve();
        },
      }),
    Error,
    "LOOPBACK_PORT_BIND_RETRIES_EXHAUSTED:3",
  );

  assertEquals(ownedCleanupCount, 3);
  assertEquals(candidates, []);
});

// The daemon text from the CI failure on a Docker-assigned inngest port.
const daemonCollision = (port: number) =>
  `Error response from daemon: failed to set up container networking: driver failed programming external connectivity on endpoint bakery-e2e-oauth-mcp-inngest-1 (398d9c6c): error while calling RootlessKit PortManager.AddPort(): listen tcp4 127.0.0.1:${port}: bind: address already in use`;

Deno.test("a lost host-port bind re-runs the whole boot on fresh ports after cleaning the owned attempt", async () => {
  const candidates = [44_001, 44_002, 44_003, 44_004];
  const allocated = new Set<number>();
  const drawn: number[][] = [];
  const events: string[] = [];
  const announced: PortCollisionRetry[] = [];

  const result = await retryOnPortCollision({
    onCollision: (retry) => {
      events.push("announce");
      announced.push(retry);
    },
    run: (attempt) => {
      const ports = [
        reserveUniqueLoopbackPort(allocated, () => candidates.shift()!),
        reserveUniqueLoopbackPort(allocated, () => candidates.shift()!),
      ];
      drawn.push(ports);
      events.push(`run:${attempt}`);
      if (attempt < 2) {
        return Promise.reject(new Error(daemonCollision(ports[0])));
      }
      return Promise.resolve(ports);
    },
    cleanupOwnedAttempt: () => {
      events.push("cleanup");
      return Promise.resolve();
    },
  });

  assertEquals(result, [44_003, 44_004]);
  assertEquals(drawn, [[44_001, 44_002], [44_003, 44_004]]);
  assertEquals(events, ["run:1", "announce", "cleanup", "run:2"]);
  assertEquals(
    announced.map(({ attempt, maxAttempts }) => [attempt, maxAttempts]),
    [[1, 3]],
  );
  assert(announced[0].message.includes("bind: address already in use"));
});

Deno.test("the announcement starts at the bind error when logs trail it", async () => {
  const announced: PortCollisionRetry[] = [];
  const logs = "container log line\n".repeat(100);

  await retryOnPortCollision({
    onCollision: (retry) => {
      announced.push(retry);
    },
    run: (attempt) =>
      attempt < 2
        ? Promise.reject(new Error(`${daemonCollision(33_308)}\n${logs}`))
        : Promise.resolve("up"),
    cleanupOwnedAttempt: () => Promise.resolve(),
  });

  assertEquals(announced.length, 1);
  const [{ message }] = announced;
  assert(message.startsWith("…RootlessKit PortManager.AddPort()"));
  assert(message.includes("33308: bind: address already in use"));
  assert(message.length <= 301);
});

Deno.test("a lost bind race is announced on stderr by default", async () => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...parts: unknown[]) => {
    lines.push(parts.join(" "));
  };
  try {
    const result = await retryOnPortCollision({
      run: (attempt) =>
        attempt < 2
          ? Promise.reject(new Error(daemonCollision(33_307)))
          : Promise.resolve("up"),
      cleanupOwnedAttempt: () => Promise.resolve(),
    });
    assertEquals(result, "up");
  } finally {
    console.error = original;
  }
  assertEquals(lines.length, 1);
  assert(
    lines[0].startsWith(
      "[port-collision-retry] attempt 1 of 3 lost a host-port bind race: ",
    ),
  );
  assert(lines[0].includes("bind: address already in use"));
});

Deno.test("a collision is retried once per failure until the boot succeeds", async () => {
  let runs = 0;
  let cleanups = 0;

  const result = await retryOnPortCollision({
    onCollision: quiet,
    maxAttempts: 4,
    run: (attempt) => {
      runs++;
      if (attempt < 4) {
        return Promise.reject(new Error(daemonCollision(33_306)));
      }
      return Promise.resolve("up");
    },
    cleanupOwnedAttempt: () => {
      cleanups++;
      return Promise.resolve();
    },
  });

  assertEquals(result, "up");
  assertEquals(runs, 4);
  assertEquals(cleanups, 3);
});

Deno.test("a collision wrapped in an assertion failure still counts", async () => {
  // upStack reports a failed `compose up` through fail(), which wraps the
  // daemon's stderr in an AssertionError.
  let cleanups = 0;

  const result = await retryOnPortCollision({
    onCollision: quiet,
    run: (attempt) => {
      if (attempt === 1) {
        throw new AssertionError(
          `Failed assertion: docker compose up --wait server failed: ${
            daemonCollision(33_306)
          }\n--- logs ---\n`,
        );
      }
      return Promise.resolve(attempt);
    },
    cleanupOwnedAttempt: () => {
      cleanups++;
      return Promise.resolve();
    },
  });

  assertEquals(result, 2);
  assertEquals(cleanups, 1);
});

Deno.test("an error that is not the named collision rethrows at once without cleanup", async () => {
  const unrelated = [
    new Error(
      "Error response from daemon: Pool overlaps with other one on this address space",
    ),
    new Error("listen tcp4 127.0.0.1:33306: bind: address already in use"),
    new Error("RootlessKit PortManager.AddPort(): permission denied"),
    new Error("DURABLE_CORE_SERVER_READINESS_TIMEOUT"),
  ];
  for (const error of unrelated) {
    let runs = 0;
    let cleanups = 0;
    let announcements = 0;

    const thrown = await assertRejects(() =>
      retryOnPortCollision({
        onCollision: () => {
          announcements++;
        },
        run: () => {
          runs++;
          return Promise.reject(error);
        },
        cleanupOwnedAttempt: () => {
          cleanups++;
          return Promise.resolve();
        },
      })
    );

    assertEquals(thrown, error);
    assertEquals(runs, 1);
    assertEquals(cleanups, 0);
    assertEquals(announcements, 0);
  }
});

Deno.test("an error after one collision is not retried and the failed attempt was already cleaned", async () => {
  let runs = 0;
  let cleanups = 0;
  const later = new Error("server health endpoint did not become ready");

  const thrown = await assertRejects(() =>
    retryOnPortCollision({
      onCollision: quiet,
      run: (attempt) => {
        runs++;
        return Promise.reject(
          attempt === 1 ? new Error(daemonCollision(33_306)) : later,
        );
      },
      cleanupOwnedAttempt: () => {
        cleanups++;
        return Promise.resolve();
      },
    })
  );

  assertEquals(thrown, later);
  assertEquals(runs, 2);
  assertEquals(cleanups, 1);
});

Deno.test("repeated collisions end in a named error that carries the last cause and leaves nothing owned", async () => {
  let cleanups = 0;
  const attempts: number[] = [];
  const announced: number[] = [];

  const thrown = await assertRejects(
    () =>
      retryOnPortCollision({
        onCollision: (retry) => {
          announced.push(retry.attempt);
        },
        maxAttempts: 3,
        run: (attempt) => {
          attempts.push(attempt);
          return Promise.reject(new Error(daemonCollision(33_300 + attempt)));
        },
        cleanupOwnedAttempt: () => {
          cleanups++;
          return Promise.resolve();
        },
      }),
    Error,
    "LOOPBACK_PORT_BIND_RETRIES_EXHAUSTED:3",
  );

  assertEquals((thrown.cause as Error).message, daemonCollision(33_303));
  assertEquals(attempts, [1, 2, 3]);
  assertEquals(cleanups, 3);
  assertEquals(announced, [1, 2, 3]);
});

Deno.test("a first attempt that succeeds is neither retried nor cleaned", async () => {
  let runs = 0;
  let cleanups = 0;

  const result = await retryOnPortCollision({
    run: () => {
      runs++;
      return Promise.resolve("up");
    },
    cleanupOwnedAttempt: () => {
      cleanups++;
      return Promise.resolve();
    },
  });

  assertEquals(result, "up");
  assertEquals(runs, 1);
  assertEquals(cleanups, 0);
});

Deno.test("a cleanup that fails surfaces with the collision that caused it", async () => {
  const cleanupFailure = new Error("docker compose down failed");
  let runs = 0;

  const thrown = await assertRejects(
    () =>
      retryOnPortCollision({
        onCollision: quiet,
        run: () => {
          runs++;
          return Promise.reject(new Error(daemonCollision(33_306)));
        },
        cleanupOwnedAttempt: () => Promise.reject(cleanupFailure),
      }),
    AggregateError,
    "LOOPBACK_PORT_COLLISION_CLEANUP_FAILED",
  );

  assertEquals(runs, 1);
  assertEquals(thrown.errors.length, 2);
  assertEquals(thrown.errors[1], cleanupFailure);
});

Deno.test("an attempt budget below one is rejected before any boot", async () => {
  let runs = 0;

  await assertRejects(
    () =>
      retryOnPortCollision({
        maxAttempts: 0,
        run: () => {
          runs++;
          return Promise.resolve();
        },
        cleanupOwnedAttempt: () => Promise.resolve(),
      }),
    Error,
    "LOOPBACK_PORT_ATTEMPTS_INVALID",
  );

  assertEquals(runs, 0);
});

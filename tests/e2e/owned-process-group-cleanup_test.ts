import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  observeOwnedSystemdUnitStatus,
  ownedSystemdUnitMainRunning,
  ownedSystemdUnitOutput,
  ownedSystemdUnitWrapper,
  startOwnedSystemdUnit,
  stopOwnedSystemdUnit,
} from "../helpers/owned-process-group.ts";

async function startOwnedProcess(
  source: string,
  options: {
    environment?: Readonly<Record<string, string>>;
    workerShutdownReceipt?: Readonly<{ path: string; launchId: string }>;
    gracefulTimeoutMs?: number;
    forceTimeoutMs?: number;
  } = {},
) {
  return await startOwnedSystemdUnit({
    command: Deno.execPath(),
    args: ["eval", source],
    environment: options.environment,
    workerShutdownReceipt: options.workerShutdownReceipt,
    gracefulTimeoutMs: options.gracefulTimeoutMs ?? 1_000,
    forceTimeoutMs: options.forceTimeoutMs ?? 1_000,
  });
}

async function waitForOutput(
  output: () => string,
  marker: string,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!output().includes(marker) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert(output().includes(marker), output());
}

async function waitForMainExit(
  unit: Awaited<ReturnType<typeof startOwnedProcess>>,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (await ownedSystemdUnitMainRunning(unit)) {
    assert(Date.now() < deadline, "OWNED_SYSTEMD_UNIT_MAIN_EXIT_TIMEOUT");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      await Deno.lstat(path);
      return;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`PATH_WAIT_TIMEOUT: ${path}`);
}

Deno.test("owned systemd status publication never exposes staged content", async () => {
  const directory = await Deno.makeTempDir();
  const binDirectory = `${directory}/bin`;
  const statusPath = `${directory}/status`;
  const markerPath = `${directory}/move-ready`;
  const releasePath = `${directory}/move-release`;
  const stdoutPath = `${directory}/stdout`;
  const stderrPath = `${directory}/stderr`;
  const movePath = `${binDirectory}/mv`;
  let releaseNeeded = true;
  let wrapper: Promise<Deno.CommandOutput> | undefined;
  try {
    await Deno.mkdir(binDirectory);
    await Deno.writeTextFile(`${statusPath}.tmp`, "1");
    await Deno.writeTextFile(
      movePath,
      `#!/bin/bash\n: >"$MARKER_PATH"\nwhile [ ! -e "$RELEASE_PATH" ]; do sleep 0.01; done\nexec /bin/mv "$@"\n`,
      { mode: 0o700 },
    );
    let observedSettled = false;
    const observed = observeOwnedSystemdUnitStatus(statusPath);
    void observed.then(
      () => observedSettled = true,
      () => observedSettled = true,
    );
    wrapper = new Deno.Command("/bin/bash", {
      args: [
        "-c",
        ownedSystemdUnitWrapper,
        "bash",
        statusPath,
        stdoutPath,
        stderrPath,
        "/bin/true",
      ],
      env: {
        PATH: `${binDirectory}:/usr/bin:/bin`,
        MARKER_PATH: markerPath,
        RELEASE_PATH: releasePath,
      },
      stdout: "null",
      stderr: "null",
    }).output();

    await waitForPath(markerPath);
    assertEquals(
      await Deno.readTextFile(`${statusPath}.tmp`),
      "0\n",
    );
    await assertRejects(
      () => Deno.readTextFile(statusPath),
      Deno.errors.NotFound,
    );
    assertEquals(observedSettled, false);

    await Deno.writeTextFile(releasePath, "release\n");
    releaseNeeded = false;
    assertEquals((await wrapper).success, true);
    assertEquals(await observed, {
      success: true,
      code: 0,
    });
    await assertRejects(
      () => Deno.lstat(`${statusPath}.tmp`),
      Deno.errors.NotFound,
    );
  } finally {
    if (releaseNeeded) {
      await Deno.writeTextFile(releasePath, "release\n").catch(() => {});
    }
    await wrapper?.catch(() => undefined);
    await Deno.remove(directory, { recursive: true }).catch(() => {});
  }
});

Deno.test("owned systemd status observer rejects invalid published status", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const statusPath = `${directory}/status`;
    await Deno.writeTextFile(statusPath, "1x\n");
    await assertRejects(
      () => observeOwnedSystemdUnitStatus(statusPath),
      Error,
      "OWNED_SYSTEMD_UNIT_STATUS_INVALID",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("owned systemd unit stages its status outside the working directory", async () => {
  const directory = await Deno.makeTempDir();
  try {
    // A ".tmp" directory in the unit's working directory turns a status staged
    // at "<cwd>/.tmp" into a published directory instead of an exit code.
    await Deno.mkdir(`${directory}/.tmp`);
    const unit = await startOwnedSystemdUnit({
      command: "/bin/true",
      cwd: directory,
      gracefulTimeoutMs: 1_000,
      forceTimeoutMs: 1_000,
    });
    const stopped = await stopOwnedSystemdUnit(unit);
    assertEquals(stopped.status, { success: true, code: 0 });
    assertEquals(stopped.forced, false);
    assert((await Deno.stat(`${directory}/.tmp`)).isDirectory);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("owned systemd unit drains and reaps a graceful process", async () => {
  const unit = await startOwnedProcess(`
    Deno.addSignalListener("SIGTERM", () => {
      console.log("OWNED_PROCESS_TERM");
      setTimeout(() => Deno.exit(0), 25);
    });
    console.log("OWNED_PROCESS_READY");
    await new Promise(() => {});
  `);
  const output = () => ownedSystemdUnitOutput(unit);
  await waitForOutput(output, "OWNED_PROCESS_READY");

  const stopped = await stopOwnedSystemdUnit(unit);

  assertEquals(stopped.forced, false);
  assertEquals(stopped.status, {
    success: true,
    code: 0,
  });
  assert(output().includes("OWNED_PROCESS_TERM"), output());
});

Deno.test("owned systemd unit rejects status 143 without a worker receipt", async () => {
  const directory = await Deno.makeTempDir();
  const launchId = crypto.randomUUID();
  try {
    const unit = await startOwnedProcess(
      `
        Deno.addSignalListener("SIGTERM", () => Deno.exit(143));
        console.log("OWNED_PROCESS_READY");
        await new Promise(() => {});
      `,
      {
        workerShutdownReceipt: {
          path: `${directory}/shutdown-complete.json`,
          launchId,
        },
      },
    );
    const output = () => ownedSystemdUnitOutput(unit);
    await waitForOutput(output, "OWNED_PROCESS_READY");

    const stopped = await stopOwnedSystemdUnit(unit);

    assertEquals(stopped, {
      forced: false,
      status: { success: false, code: 143 },
    });
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("owned systemd unit accepts status 143 only with a matching shutdown receipt", async () => {
  const directory = await Deno.makeTempDir();
  const launchId = crypto.randomUUID();
  const workerHostId = crypto.randomUUID();
  const workerSessionId = crypto.randomUUID();
  const receiptPath = `${directory}/shutdown-complete.json`;
  const receipt = {
    event: "bakery.worker.shutdown-complete.v1",
    launchId,
    signal: "SIGTERM",
    outcome: "drained",
    workerHostId,
    workerSessionId,
    workerSessionGeneration: "7",
  } as const;
  try {
    const unit = await startOwnedProcess(
      `
        Deno.addSignalListener("SIGTERM", () => {
          setTimeout(async () => {
            await Deno.writeTextFile(
              Deno.env.get("RECEIPT_PATH")!,
              Deno.env.get("RECEIPT")!,
            );
            Deno.exit(143);
          }, 25);
        });
        console.log("OWNED_PROCESS_READY");
        await new Promise(() => {});
      `,
      {
        environment: {
          RECEIPT_PATH: receiptPath,
          RECEIPT: `${JSON.stringify(receipt)}\n`,
        },
        workerShutdownReceipt: { path: receiptPath, launchId },
      },
    );
    await waitForOutput(
      () => ownedSystemdUnitOutput(unit),
      "OWNED_PROCESS_READY",
    );

    const stopped = await stopOwnedSystemdUnit(unit);

    assertEquals(stopped, {
      forced: false,
      status: { success: true, code: 143 },
      workerShutdownReceipt: receipt,
    });
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("owned systemd unit rejects a receipt for another launch", async () => {
  const directory = await Deno.makeTempDir();
  const launchId = crypto.randomUUID();
  const receiptPath = `${directory}/shutdown-complete.json`;
  const receipt = {
    event: "bakery.worker.shutdown-complete.v1",
    launchId: crypto.randomUUID(),
    signal: "SIGTERM",
    outcome: "drained",
    workerHostId: crypto.randomUUID(),
    workerSessionId: crypto.randomUUID(),
    workerSessionGeneration: "1",
  };
  try {
    const unit = await startOwnedProcess(
      `
        Deno.addSignalListener("SIGTERM", () => {
          Deno.writeTextFileSync(
            Deno.env.get("RECEIPT_PATH")!,
            Deno.env.get("RECEIPT")!,
          );
          Deno.exit(143);
        });
        console.log("OWNED_PROCESS_READY");
        await new Promise(() => {});
      `,
      {
        environment: {
          RECEIPT_PATH: receiptPath,
          RECEIPT: `${JSON.stringify(receipt)}\n`,
        },
        workerShutdownReceipt: { path: receiptPath, launchId },
      },
    );
    await waitForOutput(
      () => ownedSystemdUnitOutput(unit),
      "OWNED_PROCESS_READY",
    );

    await assertRejects(
      () => stopOwnedSystemdUnit(unit),
      Error,
      "OWNED_SYSTEMD_UNIT_SHUTDOWN_RECEIPT_MISMATCH",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("owned systemd unit rejects an unexpected pre-stop SIGTERM exit", async () => {
  const directory = await Deno.makeTempDir();
  const releasePath = `${directory}/release`;
  let unit: Awaited<ReturnType<typeof startOwnedProcess>> | undefined;
  try {
    unit = await startOwnedProcess(
      `
        console.log("OWNED_PROCESS_READY");
        while (true) {
          try {
            await Deno.lstat(Deno.env.get("RELEASE_PATH")!);
            break;
          } catch (error) {
            if (!(error instanceof Deno.errors.NotFound)) throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        Deno.exit(143);
      `,
      { environment: { RELEASE_PATH: releasePath } },
    );
    const output = () => ownedSystemdUnitOutput(unit!);
    await waitForOutput(output, "OWNED_PROCESS_READY");
    await Deno.writeTextFile(releasePath, "release\n");
    await waitForMainExit(unit);

    const stopped = await stopOwnedSystemdUnit(unit);
    unit = undefined;

    assertEquals(stopped, {
      forced: false,
      status: {
        success: false,
        code: 143,
      },
    });
  } finally {
    if (unit) await stopOwnedSystemdUnit(unit).catch(() => undefined);
    await Deno.remove(directory, { recursive: true }).catch(() => {});
  }
});

Deno.test("natural status 143 wins the stop race in 50 iterations", async () => {
  const directory = await Deno.makeTempDir();
  try {
    for (let iteration = 0; iteration < 50; iteration += 1) {
      const markerPath = `${directory}/child-exit-${iteration}`;
      const unit = await startOwnedProcess(
        `
          Deno.writeTextFileSync(
            Deno.env.get("MARKER_PATH")!,
            "child-exit-before-stop\\n",
          );
          Deno.exit(143);
        `,
        { environment: { MARKER_PATH: markerPath } },
      );
      await waitForPath(markerPath);

      const stopped = await stopOwnedSystemdUnit(unit);

      assertEquals(stopped, {
        forced: false,
        status: { success: false, code: 143 },
      });
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("owned systemd unit force-cleans an owned descendant", async () => {
  const descendant = `
    Deno.addSignalListener("SIGTERM", () => {});
    console.log("OWNED_DESCENDANT_READY");
    await new Promise(() => {});
  `;
  const unit = await startOwnedProcess(
    `
      new Deno.Command(${JSON.stringify(Deno.execPath())}, {
        args: ["eval", ${JSON.stringify(descendant)}],
        stdout: "inherit",
        stderr: "inherit",
      }).spawn();
      Deno.addSignalListener("SIGTERM", () => Deno.exit(0));
      await new Promise(() => {});
    `,
    { gracefulTimeoutMs: 50 },
  );
  const output = () => ownedSystemdUnitOutput(unit);
  await waitForOutput(output, "OWNED_DESCENDANT_READY");

  const stopped = await stopOwnedSystemdUnit(unit);

  assertEquals(stopped.forced, true);
  assertEquals(stopped.status.success, false);
  assertEquals(stopped.workerShutdownReceipt, undefined);
});

Deno.test(
  "exited owned launcher with a retained pipe does not signal an unrelated sentinel",
  async () => {
    const directory = await Deno.makeTempDir();
    const pidPath = `${directory}/launcher-pid`;
    const releasePath = `${directory}/release`;
    let unit: Awaited<ReturnType<typeof startOwnedProcess>> | undefined;
    let sentinel: Deno.ChildProcess | undefined;
    try {
      const owned = await startOwnedProcess(
        `
          await Deno.writeTextFile(Deno.env.get("PID_PATH")!, String(Deno.pid));
          console.log("OWNED_LAUNCHER_READY");
          while (true) {
            try {
              await Deno.lstat(Deno.env.get("RELEASE_PATH")!);
              break;
            } catch (error) {
              if (!(error instanceof Deno.errors.NotFound)) throw error;
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          console.log("OWNED_LAUNCHER_EXITED");
        `,
        { environment: { PID_PATH: pidPath, RELEASE_PATH: releasePath } },
      );
      unit = owned;
      const output = () => ownedSystemdUnitOutput(owned);
      await waitForOutput(output, "OWNED_LAUNCHER_READY");
      const launcherPid = (await Deno.readTextFile(pidPath)).trim();
      sentinel = new Deno.Command(Deno.execPath(), {
        args: [
          "eval",
          `
            const pipe = await Deno.open(${
            JSON.stringify(
              `/proc/${launcherPid}/fd/1`,
            )
          }, { write: true });
            const encoder = new TextEncoder();
            const write = async (value: string) => {
              await pipe.write(encoder.encode(value + "\\n"));
            };
            Deno.addSignalListener("SIGTERM", () => {
              write("UNRELATED_SENTINEL_TERM").finally(() => Deno.exit(2));
            });
            await write("UNRELATED_SENTINEL_READY");
            await new Promise((resolve) => setTimeout(resolve, 250));
            await write("UNRELATED_SENTINEL_CLEAN");
            pipe.close();
          `,
        ],
        stdout: "null",
        stderr: "null",
      }).spawn();
      await waitForOutput(output, "UNRELATED_SENTINEL_READY");
      await Deno.writeTextFile(releasePath, "release\n");
      await waitForOutput(output, "OWNED_LAUNCHER_EXITED");
      await waitForMainExit(owned);
      assertEquals(await ownedSystemdUnitMainRunning(owned), false);

      const stopped = await stopOwnedSystemdUnit(owned);
      const sentinelStatus = await sentinel.status;
      sentinel = undefined;

      assertEquals(stopped.forced, false);
      assertEquals(stopped.status, {
        success: true,
        code: 0,
      });
      assertEquals(sentinelStatus.success, true);
      assert(output().includes("UNRELATED_SENTINEL_CLEAN"), output());
      assert(!output().includes("UNRELATED_SENTINEL_TERM"), output());
    } finally {
      if (unit) await stopOwnedSystemdUnit(unit).catch(() => undefined);
      await sentinel?.status.catch(() => undefined);
      await Deno.remove(directory, { recursive: true });
    }
  },
);

Deno.test("owned systemd unit cleanup runs after a test exception", async () => {
  const unit = await startOwnedProcess(`
    Deno.addSignalListener("SIGTERM", () => {
      console.log("EXCEPTION_CLEANUP_TERM");
      Deno.exit(0);
    });
    console.log("EXCEPTION_CLEANUP_READY");
    await new Promise(() => {});
  `);
  const output = () => ownedSystemdUnitOutput(unit);
  let stopped;
  try {
    await waitForOutput(output, "EXCEPTION_CLEANUP_READY");
    throw new Error("EXPECTED_TEST_EXCEPTION");
  } catch (error) {
    assert(error instanceof Error);
    assertEquals(error.message, "EXPECTED_TEST_EXCEPTION");
  } finally {
    stopped = await stopOwnedSystemdUnit(unit);
  }

  assertEquals(stopped.forced, false);
  assertEquals(stopped.status, {
    success: true,
    code: 0,
  });
  assert(output().includes("EXCEPTION_CLEANUP_TERM"), output());
});

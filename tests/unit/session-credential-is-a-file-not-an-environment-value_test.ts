/**
 * The session's credential reaches the CLI as a file, and outlives nothing (#404).
 *
 * Two claims are tested here, and both are the kind that look fine in a diff:
 *
 * - **No secret in the child environment.** The contract says the credential
 *   "must never be copied into job input, a log, an artifact or a subprocess
 *   environment", so the case asserts the exact set of variables a harness child
 *   receives: a path and an address. A helper that leaked the value through
 *   `BAKERY_SESSION_CREDENTIAL` would pass every other test in the repository.
 * - **The file is gone when the attempt ends.** Written before anything spawns
 *   and removed in a `finally`, so success, failure, cancellation and a lost
 *   lease all end with no credential on disk.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "node:path";
import {
  clearSessionCredentials,
  removeSessionCredentialFile,
  sessionCredentialPath,
  sessionEnvironment,
  withSessionCredentialFile,
  writeSessionCredentialFile,
} from "../../apps/worker/src/session-credential-file.ts";
import { claudeChildEnvironment } from "../../apps/worker/src/claude-harness.ts";
import type { WorkerExecutor } from "../../apps/worker/src/executor.ts";

const ATTEMPT = "11111111-1111-4111-8111-111111111111";
const CREDENTIAL = "session_credential_value_abcdef0123456789";
const GATEWAY = "https://bakery.example.com";
const COMPLETED = { status: "completed", result: null } as never;
const SINK = {
  write: () => Promise.resolve(),
  sourceLost: () => Promise.resolve(),
};

const assignmentOf = (overrides: Record<string, unknown> = {}) =>
  ({
    attemptId: ATTEMPT,
    fence: 3,
    sessionCredential: CREDENTIAL,
    ...overrides,
  }) as never;

async function withStateDir(
  work: (stateDir: string) => Promise<void>,
): Promise<void> {
  const stateDir = await Deno.makeTempDir({ prefix: "bakery-404-" });
  try {
    await work(stateDir);
  } finally {
    await Deno.remove(stateDir, { recursive: true }).catch(() => undefined);
  }
}

Deno.test("the child environment carries the file's path and the gateway, never the credential", async () => {
  await withStateDir((stateDir) => {
    const environment = sessionEnvironment(stateDir, GATEWAY, assignmentOf());
    assertEquals(Object.keys(environment).sort(), [
      "BAKERY_SESSION_CREDENTIAL_FILE",
      "BAKERY_URL",
    ]);
    assertEquals(environment.BAKERY_URL, GATEWAY);
    assert(
      environment.BAKERY_SESSION_CREDENTIAL_FILE.startsWith(stateDir),
      "the path is outside the worker's private state",
    );
    // The assertion the contract is about: no variable holds the value.
    for (const value of Object.values(environment)) {
      assert(
        !value.includes(CREDENTIAL),
        `a child environment variable carries the credential: ${value}`,
      );
    }
    // And the whole child environment a harness builds from it, not just ours.
    const childEnvironment = {
      ...claudeChildEnvironment({ home: "/tmp/h", path: "/tmp/h/c" }, {}),
      ...environment,
    };
    for (const value of Object.values(childEnvironment)) {
      assert(!value.includes(CREDENTIAL), `leaked: ${value}`);
    }
    return Promise.resolve();
  });
});

Deno.test("an attempt without a credential gets no variables at all", () => {
  assertEquals(
    sessionEnvironment(
      "/s",
      GATEWAY,
      assignmentOf({ sessionCredential: undefined }),
    ),
    {},
  );
  // An unconfigured gateway is not a licence to send a path with no address.
  assertEquals(
    sessionEnvironment("/s", undefined, assignmentOf()),
    {},
  );
  assertEquals(
    sessionCredentialPath(undefined, assignmentOf()),
    null,
    "a missing state root produced a path",
  );
});

Deno.test("the credential file is owner-only and holds exactly the value", async () => {
  await withStateDir(async (stateDir) => {
    const path = await writeSessionCredentialFile(stateDir, assignmentOf());
    assert(path !== null);
    const { stat, readFile } = await import("node:fs/promises");
    const info = await stat(path);
    assertEquals(info.mode & 0o777, 0o600, "the file is not owner-only");
    // The directory too: a 0755 directory would let any local user read the
    // name of the file, and then race the delete.
    const directory = path.slice(0, path.lastIndexOf("/"));
    assertEquals((await stat(directory)).mode & 0o777, 0o700);
    assertEquals(await readFile(path, "utf8"), CREDENTIAL);
  });
});

Deno.test("a re-claim replaces the earlier file rather than appending to it", async () => {
  await withStateDir(async (stateDir) => {
    const path = await writeSessionCredentialFile(stateDir, assignmentOf());
    assert(path !== null);
    const updated = await writeSessionCredentialFile(
      stateDir,
      assignmentOf({ sessionCredential: "second_credential_0123456789abcdef" }),
    );
    assertEquals(updated, path);
    const { readFile } = await import("node:fs/promises");
    assertEquals(
      await readFile(path, "utf8"),
      "second_credential_0123456789abcdef",
    );
    // A different fence is a different file, so a re-claim cannot overwrite the
    // credential a still-running lease is using.
    assert(
      sessionCredentialPath(stateDir, assignmentOf({ fence: 4 })) !== path,
      "a new fence reused the earlier lease's file",
    );
  });
});

Deno.test("a symlink at the credential path is refused, not written through", async () => {
  await withStateDir(async (stateDir) => {
    // `new Deno.Command`-free setup: create the path as a link to a file outside
    // the private directory, then ask for the write.
    const target = join(stateDir, "outside");
    await Deno.writeTextFile(target, "before");
    const path = sessionCredentialPath(stateDir, assignmentOf());
    assert(path !== null);
    await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    await Deno.symlink(target, path);
    await assertRejects(
      () => writeSessionCredentialFile(stateDir, assignmentOf()),
      Error,
      "SESSION_CREDENTIAL_PATH_UNSAFE",
    );
    // The file the link pointed at is untouched.
    assertEquals(await Deno.readTextFile(target), "before");
  });
});

Deno.test("the file is gone when the attempt ends, however it ended", async () => {
  await withStateDir(async (stateDir) => {
    for (
      const ending of [
        () => Promise.resolve(COMPLETED),
        () => Promise.reject(new Error("the operation failed")),
      ]
    ) {
      const path = sessionCredentialPath(stateDir, assignmentOf());
      assert(path !== null, "the path is not a function of the attempt");
      let existsDuring = false;
      const inner: WorkerExecutor = {
        async execute() {
          existsDuring = await Deno.stat(path).then(() => true).catch(() =>
            false
          );
          return await ending();
        },
      };
      const wrapped = withSessionCredentialFile(inner, { stateDir });
      await wrapped.execute(
        assignmentOf(),
        new AbortController().signal,
        SINK,
      ).catch(() => undefined);
      assert(existsDuring, "the credential was absent while the attempt ran");
      assertEquals(
        await Deno.stat(path).then(() => "present").catch(() => "gone"),
        "gone",
        "the credential outlived the attempt",
      );
    }
  });
});

Deno.test("a worker that starts after a crash clears stale credentials", async () => {
  await withStateDir(async (stateDir) => {
    const stale = await writeSessionCredentialFile(stateDir, assignmentOf());
    assert(stale !== null);
    const wrapped = withSessionCredentialFile(
      { execute: () => Promise.resolve(COMPLETED) },
      { stateDir },
    );
    await wrapped.initialize?.();
    assertEquals(
      await Deno.stat(stale).then(() => "present").catch(() => "gone"),
      "gone",
      "a killed worker's credential survived the next start",
    );
  });
});

Deno.test("clearing is idempotent and refuses nothing it should delete", async () => {
  await withStateDir(async (stateDir) => {
    await clearSessionCredentials(stateDir); // nothing there yet
    const path = await writeSessionCredentialFile(stateDir, assignmentOf());
    assert(path !== null);
    await removeSessionCredentialFile(path);
    await removeSessionCredentialFile(path); // twice is fine
    await clearSessionCredentials(stateDir);
    assertEquals(
      await Deno.stat(path).then(() => "present").catch(() => "gone"),
      "gone",
    );
  });
});

import { assertEquals } from "@std/assert";
import {
  type AttemptLayout,
  type AttemptScope,
  git,
  prepareAttemptRoot,
  removeAttempt,
  sweepAttempts,
} from "../../apps/worker/src/attempt-worktree.ts";

// `git worktree add` registers the worktree and marks it locked with the reason
// "initializing" until it has finished. A checkout that hits its deadline, is
// cancelled or loses its process while it is still setting up is cut off in
// that window and leaves the record locked with no directory behind it. Neither
// `git worktree remove --force` nor `git worktree prune` removes a locked
// record, so without an explicit unlock it stays in the operator's repository
// for good. These cases build exactly that state; the real timing is a lottery
// (about 1 in 150 attempts with a 1 ms deadline), so it cannot be a test.

const scope: AttemptScope = { directory: "checks", unsafeRootCode: "UNSAFE" };

type Fixture = {
  readonly repository: string;
  readonly stateDir: string;
  readonly revision: string;
  readonly options: { repository: string; stateDir: string };
  dispose(): Promise<void>;
};

/** Runs git through the product's own spawn path and requires success. */
async function run(cwd: string, ...args: string[]): Promise<string> {
  const result = await git(cwd, args, 30_000);
  if (result === "aborted" || result.code !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${
        result === "aborted" ? "aborted" : result.stderr
      }`,
    );
  }
  return result.stdout;
}

async function fixture(): Promise<Fixture> {
  const repository = await Deno.makeTempDir({ prefix: "attempt-wt-repo-" });
  const stateDir = await Deno.makeTempDir({ prefix: "attempt-wt-state-" });
  await run(repository, "init", "-q");
  await run(repository, "config", "user.email", "test@example.test");
  await run(repository, "config", "user.name", "test");
  await run(repository, "config", "commit.gpgsign", "false");
  await Deno.writeTextFile(`${repository}/file.txt`, "content\n");
  await run(repository, "add", "-A");
  await run(repository, "commit", "-q", "-m", "initial");
  const revision = (await run(repository, "rev-parse", "HEAD")).trim();
  return {
    repository,
    stateDir,
    revision,
    options: { repository, stateDir },
    async dispose() {
      await Deno.remove(repository, { recursive: true }).catch(() => undefined);
      await Deno.remove(stateDir, { recursive: true }).catch(() => undefined);
    },
  };
}

/** Paths git has registered as worktrees, without the main checkout. */
async function records(repository: string): Promise<string[]> {
  return (await run(repository, "worktree", "list", "--porcelain"))
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length))
    .slice(1);
}

/**
 * The state a cut-off `git worktree add` leaves: registered, locked as
 * "initializing", and no directory.
 */
async function leakInitializingRecord(
  fixture: Fixture,
  layout: AttemptLayout,
): Promise<void> {
  await run(
    fixture.repository,
    "worktree",
    "add",
    "--quiet",
    "--detach",
    layout.worktree,
    fixture.revision,
  );
  await run(
    fixture.repository,
    "worktree",
    "lock",
    "--reason",
    "initializing",
    layout.worktree,
  );
  await Deno.remove(layout.worktree, { recursive: true });
  // The setup is only a faithful copy of the leak if the two commands the
  // cleanup already uses really cannot clear it.
  await run(fixture.repository, "worktree", "prune");
  assertEquals(
    (await records(fixture.repository)).includes(layout.worktree),
    true,
  );
  const removal = await git(
    fixture.repository,
    ["worktree", "remove", "--force", layout.worktree],
    30_000,
  );
  assertEquals(removal !== "aborted" && removal.code !== 0, true);
  assertEquals(
    (await records(fixture.repository)).includes(layout.worktree),
    true,
  );
}

Deno.test("an attempt whose checkout was cut off while initializing leaves no worktree record", async () => {
  const f = await fixture();
  try {
    const layout = await prepareAttemptRoot(
      f.options,
      scope,
      crypto.randomUUID(),
    );
    await leakInitializingRecord(f, layout);
    // `addWorktree` reports `added: false` for a deadline or a cancellation.
    await removeAttempt(f.options, layout, false);
    assertEquals(await records(f.repository), []);
  } finally {
    await f.dispose();
  }
});

Deno.test("a crashed worker's cut-off checkout is cleared by the next sweep", async () => {
  const f = await fixture();
  try {
    const layout = await prepareAttemptRoot(
      f.options,
      scope,
      crypto.randomUUID(),
    );
    await leakInitializingRecord(f, layout);
    await sweepAttempts(f.options, scope);
    assertEquals(await records(f.repository), []);
  } finally {
    await f.dispose();
  }
});

Deno.test("cleaning one attempt never unlocks a worktree somebody else locked", async () => {
  const f = await fixture();
  const held = await Deno.makeTempDir({ prefix: "attempt-wt-held-" });
  const heldPath = `${held}/kept`;
  try {
    await run(
      f.repository,
      "worktree",
      "add",
      "--quiet",
      "--detach",
      heldPath,
      f.revision,
    );
    await run(
      f.repository,
      "worktree",
      "lock",
      "--reason",
      "operator hold",
      heldPath,
    );
    const layout = await prepareAttemptRoot(
      f.options,
      scope,
      crypto.randomUUID(),
    );
    await leakInitializingRecord(f, layout);
    // Both worktrees are registered; only the attempt's own is removed.
    assertEquals(
      (await records(f.repository)).sort(),
      [heldPath, layout.worktree].sort(),
    );
    await removeAttempt(f.options, layout, false);
    await sweepAttempts(f.options, scope);
    assertEquals(await records(f.repository), [heldPath]);
    const stillLocked = await git(
      f.repository,
      ["worktree", "remove", "--force", heldPath],
      30_000,
    );
    assertEquals(stillLocked !== "aborted" && stillLocked.code !== 0, true);
    assertEquals(await records(f.repository), [heldPath]);
  } finally {
    await run(f.repository, "worktree", "unlock", heldPath).catch(() =>
      undefined
    );
    await Deno.remove(held, { recursive: true }).catch(() => undefined);
    await f.dispose();
  }
});

Deno.test("an attempt whose worktree was added is still removed as before", async () => {
  const f = await fixture();
  try {
    const layout = await prepareAttemptRoot(
      f.options,
      scope,
      crypto.randomUUID(),
    );
    await run(
      f.repository,
      "worktree",
      "add",
      "--quiet",
      "--detach",
      layout.worktree,
      f.revision,
    );
    assertEquals(await records(f.repository), [layout.worktree]);
    await removeAttempt(f.options, layout, true);
    assertEquals(await records(f.repository), []);
  } finally {
    await f.dispose();
  }
});

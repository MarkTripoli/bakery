import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from "@std/assert";
import { join } from "node:path";
import {
  addWorktree,
  type AttemptWorktreeOptions,
  prepareAttemptRoot,
  removeAttempt,
} from "../../../apps/worker/src/attempt-worktree.ts";
import {
  removeEscapingSymlinks,
  REVIEWER_FAULTS,
} from "../../../apps/worker/src/reviewer.ts";
import { gitText } from "../harness.ts";
import { extraWorktrees } from "../deterministic-checks/runner-fixture.ts";
import {
  answer,
  assertCleanedUp,
  exists,
  withReview,
} from "./worker-reviewer-cases.ts";
import {
  type CandidatePrepare,
  candidateRepository,
  completed,
  disposeRepository,
  faultOf,
  reviewAssignment,
  type ReviewerRig,
} from "./worker-fixtures.ts";

/**
 * Cases for the checkout the reviewer reads (issue #94, review of Phase 5
 * findings F2, F3, F5, F6 and F8): symlinks of the candidate that leave the
 * checkout, names the worker cannot address, the HEAD proof of the shared
 * attempt worktree, and what a failed or timed-out stat or diff read is
 * reported as. Everything runs real git and fake `claude` executables; none of
 * it proves what the real CLI does with a symlink, only that the worker never
 * leaves one for it to follow.
 */

const SANITIZERS = { sanitizeResources: false, sanitizeOps: false } as const;

function checkoutTest(name: string, fn: () => Promise<void>): void {
  Deno.test({ name: `checkout: ${name}`, ...SANITIZERS, fn });
}

/** The links a candidate commits: some leave the checkout, some do not. */
const linksOutAndIn: CandidatePrepare = async ({ dir, aux }) => {
  await Deno.mkdir(join(aux, "outside-dir"));
  await Deno.writeTextFile(join(aux, "outside.txt"), "outside secret\n");
  await Deno.writeTextFile(join(aux, "outside-dir", "inner.txt"), "inner\n");
  const link = (target: string, name: string) =>
    Deno.symlink(target, join(dir, name));
  // Leave the checkout: an absolute file, an absolute directory, the credential
  // copy beside the worktree (it does not exist yet when the links are checked),
  // and a worker state file two directories above the attempt root.
  await link(join(aux, "outside.txt"), "abs-file-link");
  await link(join(aux, "outside-dir"), "abs-dir-link");
  await link("../config/.credentials.json", "rel-credential-link");
  await link("../../../registration.json", "rel-state-link");
  // Inside by its text, outside once the in-tree link `x/y/s` is followed:
  // `x/y/s/../..` is the attempt root, not `x`.
  await Deno.mkdir(join(dir, "a"), { recursive: true });
  await Deno.writeTextFile(join(dir, "a", "keep.txt"), "kept\n");
  await Deno.mkdir(join(dir, "x", "y"), { recursive: true });
  await link("../../a", "x/y/s");
  await link("x/y/s/../../config/.credentials.json", "trick-link");
  // Stay inside.
  await link("feature.ts", "src/link-to-feature");
  await link("src", "link-to-dir");
};

/** Reads every link into `$AUX`, the way a model with a file tool would. */
const READ_THROUGH_LINKS = [
  'cat ./abs-file-link > "$AUX/leak-abs.txt" 2>/dev/null',
  'cat ./rel-credential-link > "$AUX/leak-credential.txt" 2>/dev/null',
  'cat ./rel-state-link > "$AUX/leak-state.txt" 2>/dev/null',
  'cat ./trick-link > "$AUX/leak-trick.txt" 2>/dev/null',
  'ls ./abs-dir-link > "$AUX/leak-dir.txt" 2>/dev/null',
  'cat ./src/link-to-feature > "$AUX/inside.txt" 2>/dev/null',
  "true",
].join("\n");

async function sizeOf(path: string): Promise<number> {
  try {
    return (await Deno.stat(path)).size;
  } catch {
    return -1;
  }
}

export function registerWorkerCheckoutCases(): void {
  checkoutTest(
    "symlinks that leave the checkout are unlinked before the model starts and in-tree links stay",
    () =>
      withReview(answer([]), async ({ rig, fake, review }) => {
        const aux = rig.repository.aux;
        const outcome = await review.execute(
          reviewAssignment(rig.repository, rig.profile),
          new AbortController().signal,
        );
        // The baseline status was taken after the removal: had it been taken
        // before, the removed links would read as writes by the model.
        assertEquals(completed(outcome).findings, []);

        // Five links were removed; the three in-tree links are what is left.
        assertEquals(
          (await Deno.readTextFile(fake.linksPath)).trim().split("\n"),
          [
            "./link-to-dir",
            "./src/link-to-feature",
            "./x/y/s",
          ],
        );
        // Reading through any removed link yields nothing, the credential
        // copy included; the in-tree link still reads its file.
        for (
          const leak of [
            "leak-abs.txt",
            "leak-credential.txt",
            "leak-state.txt",
            "leak-trick.txt",
            "leak-dir.txt",
          ]
        ) assertEquals(await sizeOf(join(aux, leak)), 0, leak);
        assertEquals(
          await Deno.readTextFile(join(aux, "inside.txt")),
          "export const feature = () => 42;\n",
        );
        // The credential copy existed by then, so the links would have worked.
        assertEquals(
          (await Deno.readTextFile(fake.configListPath)).trim(),
          ".credentials.json",
        );

        // Only the links went: their targets, a directory behind a link and
        // the worker's own state file are untouched.
        assertEquals(
          await Deno.readTextFile(join(aux, "outside.txt")),
          "outside secret\n",
        );
        assertEquals(
          await Deno.readTextFile(join(aux, "outside-dir", "inner.txt")),
          "inner\n",
        );
        assertEquals(
          await Deno.readTextFile(rig.registrationPath),
          "{}",
        );

        const prompt = await Deno.readTextFile(fake.promptPath);
        assertStringIncludes(
          prompt,
          "5 symlinks pointing outside the repository were removed from this checkout",
        );
        // The statement is Bakery's own, ahead of the untrusted block.
        assert(
          prompt.indexOf("symlinks pointing outside") <
            prompt.indexOf("untrusted_candidate_"),
        );
        await assertCleanedUp(rig);
      }, {
        prepare: linksOutAndIn,
        middle: READ_THROUGH_LINKS,
      }),
  );

  checkoutTest(
    "a candidate whose links all stay inside keeps them and the prompt says nothing",
    () =>
      withReview(answer([]), async ({ rig, fake, review }) => {
        const outcome = await review.execute(
          reviewAssignment(rig.repository, rig.profile),
          new AbortController().signal,
        );
        assertEquals(completed(outcome).findings, []);
        assertEquals(
          (await Deno.readTextFile(fake.linksPath)).trim().split("\n"),
          [
            "./link-to-dir",
            "./src/link-to-feature",
            "./sub/deep/up",
          ],
        );
        assertFalse(
          (await Deno.readTextFile(fake.promptPath)).includes(
            "symlinks pointing outside",
          ),
        );
        await assertCleanedUp(rig);
      }, {
        prepare: async ({ dir }) => {
          await Deno.mkdir(join(dir, "sub", "deep"), { recursive: true });
          await Deno.symlink("feature.ts", join(dir, "src", "link-to-feature"));
          await Deno.symlink("src", join(dir, "link-to-dir"));
          // `..` that stays inside is not an escape.
          await Deno.symlink("../../src/feature.ts", join(dir, "sub/deep/up"));
        },
      }),
  );

  checkoutTest(
    "a link that points nowhere is removed too, since its target could appear later",
    () =>
      withReview(answer([]), async ({ rig, fake, review }) => {
        const outcome = await review.execute(
          reviewAssignment(rig.repository, rig.profile),
          new AbortController().signal,
        );
        assertEquals(completed(outcome).findings, []);
        assertEquals((await Deno.readTextFile(fake.linksPath)).trim(), "");
        assertStringIncludes(
          await Deno.readTextFile(fake.promptPath),
          "3 symlinks pointing outside the repository were removed from this checkout",
        );
        await assertCleanedUp(rig);
      }, {
        prepare: async ({ dir }) => {
          await Deno.symlink("missing.txt", join(dir, "dangling"));
          // A loop never resolves either.
          await Deno.symlink("loop-b", join(dir, "loop-a"));
          await Deno.symlink("loop-a", join(dir, "loop-b"));
        },
      }),
  );

  // The two reads have their own deadlines, so each case fails exactly one of
  // them and a check on the other cannot cover for a missing one. A bound of
  // zero has already passed, so the miss does not depend on how fast git is.
  for (
    const [read, limits, detail] of [
      ["stat", { statMs: 0 }, "list of changed files"],
      ["diff", { diffMs: 0 }, "diff between"],
    ] as const
  ) {
    checkoutTest(
      `a ${read} read that hits its deadline is a retryable REVIEWER_UNAVAILABLE and no model starts`,
      () =>
        withReview(answer([]), async ({ rig, fake, review }) => {
          const fault = faultOf(
            await review.execute(
              reviewAssignment(rig.repository, rig.profile),
              new AbortController().signal,
            ),
          );
          assertEquals(fault.code, REVIEWER_FAULTS.unavailable);
          assertEquals(fault.retryable, true);
          assertEquals(fault.status, 503);
          assertStringIncludes(String(fault.detail), "in time");
          assertStringIncludes(String(fault.detail), detail);
          assertFalse(await exists(fake.ranPath), "the CLI started");
          await assertCleanedUp(rig);
        }, { limits }),
    );
  }

  checkoutTest(
    "a base commit git cannot diff against is a non-retryable REVIEWER_REVISION_UNAVAILABLE",
    () =>
      withReview(answer([]), async ({ rig, fake, review }) => {
        const fault = faultOf(
          await review.execute(
            reviewAssignment(rig.repository, rig.profile),
            new AbortController().signal,
          ),
        );
        assertEquals(fault.code, REVIEWER_FAULTS.revisionUnavailable);
        assertEquals(fault.retryable, false);
        assertEquals(fault.status, 422);
        assertStringIncludes(String(fault.detail), "could not be read");
        assertFalse(await exists(fake.ranPath), "the CLI started");
        await assertCleanedUp(rig);
      }, { baseSha: "e".repeat(40) }),
  );

  checkoutTest(
    "a link into a sibling directory named like the checkout does not count as inside it",
    async () => {
      const base = await Deno.makeTempDir({ prefix: "bakery-sibling-" });
      try {
        const root = join(base, "wt");
        const sibling = join(base, "wt-evil");
        await Deno.mkdir(root);
        await Deno.mkdir(sibling);
        await Deno.writeTextFile(join(sibling, "secret.txt"), "secret\n");
        await Deno.writeTextFile(join(root, "inside.txt"), "inside\n");
        await Deno.symlink("../wt-evil/secret.txt", join(root, "to-evil"));
        await Deno.symlink(
          join(sibling, "secret.txt"),
          join(root, "to-evil-absolute"),
        );
        await Deno.symlink("inside.txt", join(root, "to-inside"));
        assertEquals(await removeEscapingSymlinks(root), 2);
        assertFalse(await exists(join(root, "to-evil")));
        assertFalse(await exists(join(root, "to-evil-absolute")));
        assert(await exists(join(root, "to-inside")));
        assertEquals(
          await Deno.readTextFile(join(sibling, "secret.txt")),
          "secret\n",
        );
      } finally {
        await Deno.remove(base, { recursive: true }).catch(() => undefined);
      }
    },
  );

  // Names that are not valid UTF-8 cannot be created through Deno, and Deno
  // reads them back with each bad byte replaced by U+FFFD. Git can store them,
  // so these cases build the candidate commit with git plumbing and check it
  // out with the reviewer's own `git worktree add --detach`.
  const encoder = new TextEncoder();
  const concat = (parts: readonly Uint8Array[]): Uint8Array => {
    const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  };
  const gitWithInput = async (
    cwd: string,
    args: string[],
    input: Uint8Array,
  ): Promise<string> => {
    const child = new Deno.Command("git", {
      args,
      cwd,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const writer = child.stdin.getWriter();
    await writer.write(input);
    await writer.close();
    const output = await child.output();
    if (output.code !== 0) {
      throw new Error(
        `SCRATCH_GIT_FAILED:${new TextDecoder().decode(output.stderr)}`,
      );
    }
    return new TextDecoder().decode(output.stdout).trim();
  };
  const entry = (
    mode: string,
    type: "blob" | "tree",
    sha: string,
    name: Uint8Array,
  ): Uint8Array =>
    concat([
      encoder.encode(`${mode} ${type} ${sha}\t`),
      name,
      new Uint8Array([0]),
    ]);
  const blob = (dir: string, text: string) =>
    gitWithInput(dir, ["hash-object", "-w", "--stdin"], encoder.encode(text));
  const tree = (dir: string, entries: readonly Uint8Array[]) =>
    gitWithInput(dir, ["mktree", "-z"], concat(entries));
  /** `name` with its last byte 0xE9: Latin-1 "e acute", which is not UTF-8. */
  const latin1 = (name: string) =>
    concat([encoder.encode(name), new Uint8Array([0xe9])]);

  /** Commits `entries` on top of the base without moving HEAD or the index. */
  const candidateOf = async (
    dir: string,
    baseSha: string,
    entries: readonly Uint8Array[],
  ) =>
    await gitText(dir, [
      "commit-tree",
      await tree(dir, entries),
      "-p",
      baseSha,
      "-m",
      "candidate",
    ]);

  async function assertCheckoutRefused(
    build: (rig: ReviewerRig) => Promise<string>,
  ): Promise<void> {
    await withReview(answer([]), async ({ rig, fake, review }) => {
      const revision = await build(rig);
      const fault = faultOf(
        await review.execute(
          reviewAssignment(rig.repository, rig.profile, {}, { revision }),
          new AbortController().signal,
        ),
      );
      assertEquals(fault.code, REVIEWER_FAULTS.checkoutUnsafe);
      assertEquals(fault.retryable, false);
      assertEquals(fault.status, 422);
      assertStringIncludes(String(fault.detail), "U+FFFD");
      assertStringIncludes(String(fault.detail), "refused too");
      assertFalse(await exists(fake.ranPath), "the model started");
      await assertCleanedUp(rig);
    });
  }

  checkoutTest(
    "a non-UTF-8 name beside a U+FFFD decoy cannot hide an escaping link: the checkout is refused",
    () =>
      assertCheckoutRefused(async (rig) => {
        const { dir, aux, baseSha } = rig.repository;
        const outside = join(aux, "outside.txt");
        await Deno.writeTextFile(outside, "outside secret\n");
        const revision = await candidateOf(dir, baseSha, [
          // The escaping link, named with a byte that is not UTF-8 ...
          entry("120000", "blob", await blob(dir, outside), latin1("lnk")),
          // ... and a decoy whose name is what Deno reads that link as.
          entry(
            "100644",
            "blob",
            await blob(dir, "decoy\n"),
            encoder.encode("lnk\ufffd"),
          ),
        ]);
        return revision;
      }),
  );

  checkoutTest(
    "a lone non-UTF-8 directory is refused instead of failing the walk on every retry",
    () =>
      assertCheckoutRefused(async (rig) => {
        const { dir, baseSha } = rig.repository;
        const inner = await tree(dir, [
          entry("100644", "blob", await blob(dir, "x\n"), encoder.encode("f")),
        ]);
        const revision = await candidateOf(dir, baseSha, [
          entry("040000", "tree", inner, latin1("dir")),
        ]);
        return revision;
      }),
  );

  checkoutTest(
    "a non-UTF-8 directory with a decoy directory beside it cannot hide a link inside it",
    () =>
      assertCheckoutRefused(async (rig) => {
        const { dir, aux, baseSha } = rig.repository;
        const outside = join(aux, "outside.txt");
        await Deno.writeTextFile(outside, "outside secret\n");
        const escaping = await tree(dir, [
          entry(
            "120000",
            "blob",
            await blob(dir, outside),
            encoder.encode("esc"),
          ),
        ]);
        const decoy = await tree(dir, [
          entry("100644", "blob", await blob(dir, "d\n"), encoder.encode("f")),
        ]);
        const revision = await candidateOf(dir, baseSha, [
          entry("040000", "tree", escaping, latin1("d")),
          entry("040000", "tree", decoy, encoder.encode("d\ufffd")),
        ]);
        return revision;
      }),
  );

  checkoutTest(
    "a file name that really uses U+FFFD is refused too, and the fault says so",
    () =>
      withReview(answer([]), async ({ rig, fake, review }) => {
        const fault = faultOf(
          await review.execute(
            reviewAssignment(rig.repository, rig.profile),
            new AbortController().signal,
          ),
        );
        assertEquals(fault.code, REVIEWER_FAULTS.checkoutUnsafe);
        assertEquals(fault.retryable, false);
        assertStringIncludes(String(fault.detail), "refused too");
        assertFalse(await exists(fake.ranPath), "the model started");
        await assertCleanedUp(rig);
      }, {
        prepare: async ({ dir }) => {
          await Deno.writeTextFile(join(dir, "weird\ufffd.txt"), "x\n");
        },
      }),
  );

  checkoutTest(
    "the baseline status still catches a write after escaping links were removed",
    () =>
      withReview(answer([]), async ({ rig, review }) => {
        const fault = faultOf(
          await review.execute(
            reviewAssignment(rig.repository, rig.profile),
            new AbortController().signal,
          ),
        );
        // The removed links are part of the baseline, so only the model's own
        // new file reads as a change.
        assertEquals(fault.code, REVIEWER_FAULTS.wroteFiles);
        assertEquals(fault.retryable, false);
        await assertCleanedUp(rig);
      }, {
        prepare: linksOutAndIn,
        middle: "echo drift > injected.txt",
      }),
  );

  async function withAttemptRoot<T>(
    run: (context: {
      options: AttemptWorktreeOptions;
      revision: string;
      repositoryDir: string;
      attempt: (name: string) => ReturnType<typeof prepareAttemptRoot>;
    }) => Promise<T>,
  ): Promise<T> {
    const repository = await candidateRepository();
    const stateDir = await Deno.makeTempDir({ prefix: "bakery-head-proof-" });
    try {
      const options: AttemptWorktreeOptions = {
        repository: repository.dir,
        stateDir,
      };
      return await run({
        options,
        revision: repository.revision,
        repositoryDir: repository.dir,
        attempt: (name) =>
          prepareAttemptRoot(options, {
            directory: "head-proof",
            unsafeRootCode: "HEAD_PROOF_ROOT_UNSAFE",
          }, name),
      });
    } finally {
      await Deno.remove(stateDir, { recursive: true }).catch(() => undefined);
      await disposeRepository(repository);
    }
  }

  checkoutTest(
    "the attempt worktree is ready only when HEAD is exactly the revision it was asked for",
    () =>
      withAttemptRoot(async (context) => {
        const signal = new AbortController().signal;
        const full = context.revision;
        const cases: ReadonlyArray<
          readonly [string, string, "ready" | "unavailable", boolean]
        > = [
          ["the exact commit", full, "ready", true],
          // Git resolves each of these to the right commit, but HEAD reads back
          // as the full lowercase SHA, which is not what was asked for.
          ["a symbolic name", "HEAD", "unavailable", true],
          ["an ancestor expression", "HEAD~1", "unavailable", true],
          ["an abbreviation", full.slice(0, 12), "unavailable", true],
          ["upper case", full.toUpperCase(), "unavailable", true],
          // Git cannot check it out at all: nothing was added.
          [
            "an object that does not exist",
            "f".repeat(40),
            "unavailable",
            false,
          ],
        ];
        let index = 0;
        for (const [name, revision, state, added] of cases) {
          const layout = await context.attempt(`proof-${index++}`);
          const result = await addWorktree(
            context.options,
            layout,
            revision,
            signal,
          );
          assertEquals(result, { state, added }, name);
          if (state === "ready") {
            assertEquals(
              await gitText(layout.worktree, ["rev-parse", "HEAD"]),
              full,
            );
          }
          // The caller removes what was added, ready or not.
          await removeAttempt(context.options, layout, result.added);
          assertEquals(await extraWorktrees(context.repositoryDir), [], name);
          assertFalse(await exists(layout.root), name);
        }
      }),
  );
}

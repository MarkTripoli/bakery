import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  publishHarnessPatch,
  restoreHarnessWorktree,
} from "../../apps/worker/src/harness-common.ts";
import { localAssignment } from "../helpers/worker-execution/recovery-support.ts";
import { gitText, prepareScratchRepository } from "../helpers/harness.ts";

// #428 part 2 (chapter 25 section 8, point 3): a writer checks out at the
// pinned candidate, ends with a clean commit and names {baseSha, headSha}.
// Nothing here relies on a warm clone: the writer is put back on the pin from
// whatever state the tree was left in.

async function publishFrom(repository: string, baseSha: string) {
  const refs: { subjectBaseSha?: string; subjectHeadSha?: string }[] = [];
  const result = await publishHarnessPatch({
    assignment: localAssignment(),
    repository,
    baseSha,
    signal: new AbortController().signal,
    publish: async (artifact) => {
      refs.push(artifact);
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new Uint8Array(artifact.bytes),
      );
      const sha256 = Array.from(
        new Uint8Array(digest),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
      return { artifactId: crypto.randomUUID(), sha256 } as never;
    },
    commitMessage: "writer change",
    commitUserEmail: "writer@bakery.local",
    commitUserName: "Writer",
    artifactName: "writer.patch",
    source: "test",
    commitFailureCode: "TEST_COMMIT_FAILED",
    digestMismatchCode: "TEST_DIGEST_MISMATCH",
  });
  return { result, refs };
}

Deno.test("a writer put back on the pin starts from the pinned revision whatever the tree held", async () => {
  const repo = await prepareScratchRepository("writers-pin-");
  try {
    await Deno.writeTextFile(`${repo.dir}/leftover.txt`, "an earlier attempt");
    await gitText(repo.dir, ["add", "-A"]);
    await gitText(repo.dir, ["commit", "-m", "an earlier attempt"]);
    await Deno.writeTextFile(`${repo.dir}/untracked.txt`, "stray");
    assertNotEquals(
      (await gitText(repo.dir, ["rev-parse", "HEAD"])).trim(),
      repo.baseSha,
    );

    await restoreHarnessWorktree({ worktree: repo.dir, baseSha: repo.baseSha });

    assertEquals(
      (await gitText(repo.dir, ["rev-parse", "HEAD"])).trim(),
      repo.baseSha,
    );
    assertEquals(
      (await gitText(repo.dir, ["status", "--porcelain"])).trim(),
      "",
    );
  } finally {
    await Deno.remove(repo.dir, { recursive: true });
  }
});

Deno.test("a writer that changed something ends on a clean commit and names baseSha and headSha", async () => {
  const repo = await prepareScratchRepository("writers-pin-");
  try {
    await Deno.writeTextFile(`${repo.dir}/feature.txt`, "new work");

    const { result, refs } = await publishFrom(repo.dir, repo.baseSha);

    assert("headSha" in result);
    assertNotEquals(result.headSha, repo.baseSha);
    assertEquals(
      (await gitText(repo.dir, ["rev-parse", "HEAD"])).trim(),
      result.headSha,
    );
    assertEquals(
      (await gitText(repo.dir, ["status", "--porcelain"])).trim(),
      "",
    );
    assertEquals(refs.length, 1);
    assertEquals(refs[0]!.subjectBaseSha, repo.baseSha);
    assertEquals(refs[0]!.subjectHeadSha, result.headSha);
  } finally {
    await Deno.remove(repo.dir, { recursive: true });
  }
});

Deno.test("a writer that changed nothing names the pin as its head and publishes no patch", async () => {
  const repo = await prepareScratchRepository("writers-pin-");
  try {
    const { result, refs } = await publishFrom(repo.dir, repo.baseSha);

    assert("headSha" in result);
    assertEquals(result.headSha, repo.baseSha);
    assertEquals(refs.length, 0);
  } finally {
    await Deno.remove(repo.dir, { recursive: true });
  }
});

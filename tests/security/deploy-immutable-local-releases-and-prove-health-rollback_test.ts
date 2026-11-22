import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "node:path";
import {
  createLocalReleaseTarget,
  type LocalReleaseTargetOptions,
} from "../../apps/server/src/modules/delivery/local-release-target.ts";
import {
  type ReleaseAdapter,
  ReleaseRefused,
} from "../../apps/server/src/modules/delivery/release-adapter.ts";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const REPOSITORY = "00000000-0000-4000-8000-000000000001";
const encoder = new TextEncoder();

async function digestOf(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return `sha256:${
    Array.from(
      new Uint8Array(hash),
      (byte) => byte.toString(16).padStart(2, "0"),
    )
      .join("")
  }`;
}

/** A target inside a parent directory the test can list, so a write outside the root shows. */
async function world(overrides: Partial<LocalReleaseTargetOptions> = {}) {
  const parent = await Deno.makeTempDir({ prefix: "bakery-target-parent-" });
  const root = join(parent, "target");
  await Deno.mkdir(root);
  const target: ReleaseAdapter = createLocalReleaseTarget({
    root,
    environment: "staging",
    artifacts: async (input) => {
      const bytes = encoder.encode(`build of ${input.headSha}`);
      return { bytes, digest: await digestOf(bytes) };
    },
    probe: async () => {
      const pointer = JSON.parse(
        await Deno.readTextFile(join(root, "current.json")),
      );
      return { version: pointer.commitSha, state: "ok" };
    },
    saveEvidence: () => Promise.resolve(crypto.randomUUID()),
    ...overrides,
  });
  const listParent = async () => {
    const names: string[] = [];
    for await (const entry of Deno.readDir(parent)) names.push(entry.name);
    return names.sort();
  };
  return { parent, root, target, listParent };
}

const prepared = (target: ReleaseAdapter, headSha: string) =>
  target.prepare({ repositoryId: REPOSITORY, headSha, profileRevision: 1 });

/**
 * #43 security: the local target takes ids, digests and effect keys from callers
 * it does not trust (workflow data reaches it through the driver). None of them
 * may reach outside its directory, run anything, or make an unverified artifact
 * serve.
 */

Deno.test("hostile ids and keys never leave the target's directory (#43 AC3)", async () => {
  const w = await world();
  try {
    const hostile = [
      "../escape",
      "..",
      "/etc/passwd",
      "a/b",
      "x".repeat(12) + "-" + "../y",
      "\u0000",
    ];
    const before = await w.listParent();
    for (const releaseId of hostile) {
      await assertRejects(
        () => w.target.deploy({ releaseId, effectKey: "k" }),
        ReleaseRefused,
      );
    }
    for (const deploymentId of hostile) {
      await assertRejects(
        () => w.target.health({ deploymentId }),
        ReleaseRefused,
      );
      await assertRejects(
        () => w.target.rollback({ deploymentId, effectKey: "k" }),
        ReleaseRefused,
      );
    }
    // An effect key is hashed into a file name, never used as one.
    const release = await prepared(w.target, SHA_A);
    const key = "../../outside/\u0000key";
    await w.target.deploy({ releaseId: release.releaseId, effectKey: key });
    assertEquals(
      await w.listParent(),
      before,
      "nothing was written beside the target",
    );
  } finally {
    await Deno.remove(w.parent, { recursive: true });
  }
});

Deno.test("an artifact that does not match its digest never becomes a release (#43 AC3)", async () => {
  // The build claims one digest and ships other bytes.
  const lying = await world({
    artifacts: () =>
      Promise.resolve({
        bytes: encoder.encode("not what was built"),
        digest: `sha256:${"0".repeat(64)}`,
      }),
  });
  try {
    const error = await assertRejects(
      () => prepared(lying.target, SHA_A),
      ReleaseRefused,
    );
    assertEquals(error.refusal, "digest_mismatch");
    await assertRejects(
      () => Deno.stat(join(lying.root, "releases")),
      Deno.errors.NotFound,
    );
  } finally {
    await Deno.remove(lying.parent, { recursive: true });
  }

  // The caller verified another digest earlier: the build must match it.
  const honest = await world();
  try {
    const error = await assertRejects(
      () =>
        honest.target.prepare({
          repositoryId: REPOSITORY,
          headSha: SHA_A,
          profileRevision: 1,
          expectedDigest: `sha256:${"1".repeat(64)}`,
        }),
      ReleaseRefused,
    );
    assertEquals(error.refusal, "digest_mismatch");
  } finally {
    await Deno.remove(honest.parent, { recursive: true });
  }
});

Deno.test("a release edited after it was prepared cannot be deployed or restored (#43 AC3)", async () => {
  const w = await world();
  try {
    const first = await prepared(w.target, SHA_A);
    await w.target.deploy({ releaseId: first.releaseId, effectKey: "first" });
    const second = await prepared(w.target, SHA_B);
    const live = await w.target.deploy({
      releaseId: second.releaseId,
      effectKey: "second",
    });
    // Someone edits the previous release's artifact on disk.
    await Deno.writeTextFile(
      join(w.root, "releases", first.releaseId, "artifact.bin"),
      "edited",
    );
    const error = await assertRejects(
      () =>
        w.target.rollback({
          deploymentId: live.deploymentId,
          effectKey: "back",
        }),
      ReleaseRefused,
    );
    assertEquals(error.refusal, "release_changed");
    // The environment still serves the second release: nothing was switched.
    assertEquals(
      JSON.parse(await Deno.readTextFile(join(w.root, "current.json")))
        .commitSha,
      SHA_B,
    );
    // And the edited one cannot be deployed again.
    await assertRejects(
      () => w.target.deploy({ releaseId: first.releaseId, effectKey: "again" }),
      ReleaseRefused,
    );
  } finally {
    await Deno.remove(w.parent, { recursive: true });
  }
});

Deno.test("health is healthy only for the exact revision, and an unreachable release is failed with evidence (#43 AC1)", async () => {
  let report: () => Promise<{ version: string; state: string }> = () =>
    Promise.resolve({ version: SHA_A, state: "ok" });
  const evidence: unknown[] = [];
  const w = await world({
    probe: () => report(),
    saveEvidence: (entry) => {
      evidence.push(entry);
      return Promise.resolve(crypto.randomUUID());
    },
  });
  try {
    const release = await prepared(w.target, SHA_A);
    const live = await w.target.deploy({
      releaseId: release.releaseId,
      effectKey: "k",
    });
    assertEquals(
      (await w.target.health({ deploymentId: live.deploymentId })).status,
      "healthy",
    );
    report = () => Promise.resolve({ version: SHA_B, state: "ok" });
    assertEquals(
      (await w.target.health({ deploymentId: live.deploymentId })).status,
      "failed",
    );
    report = () => Promise.resolve({ version: SHA_A, state: "starting" });
    assertEquals(
      (await w.target.health({ deploymentId: live.deploymentId })).status,
      "failed",
    );
    report = () => Promise.reject(new Error("connection refused"));
    assertEquals(
      (await w.target.health({ deploymentId: live.deploymentId })).status,
      "failed",
    );
    assertEquals(evidence.length, 4, "every check keeps its evidence");
    assert(JSON.stringify(evidence.at(-1)).includes("probeError"));
  } finally {
    await Deno.remove(w.parent, { recursive: true });
  }
});

import { assertEquals } from "@std/assert";
import { join } from "node:path";
import {
  createLocalReleaseTarget,
  type LocalReleaseTargetOptions,
} from "../../apps/server/src/modules/delivery/local-release-target.ts";
import type { ReleaseAdapter } from "../../apps/server/src/modules/delivery/release-adapter.ts";

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
 * #43 recovery: the target is killed between its steps. A mutation writes its
 * journal first, switches the pointer second and records the result last, so a
 * read after a crash can say whether it applied. These tests cut the files the
 * way each crash would leave them and read the effect back by its key.
 */

const pointerPath = (root: string) => join(root, "current.json");
const readJson = async (path: string) =>
  JSON.parse(await Deno.readTextFile(path));

Deno.test("a crash after the journal and before the switch reads back as failed, not unknown (#43 AC2)", async () => {
  const w = await world();
  try {
    const first = await prepared(w.target, SHA_A);
    await w.target.deploy({ releaseId: first.releaseId, effectKey: "first" });
    const before = await readJson(pointerPath(w.root));
    const second = await prepared(w.target, SHA_B);
    const live = await w.target.deploy({
      releaseId: second.releaseId,
      effectKey: "second",
    });
    // The crash: journal and record exist, the pointer never moved.
    const recordPath = join(w.root, "deployments", `${live.deploymentId}.json`);
    const record = await readJson(recordPath);
    await Deno.writeTextFile(
      recordPath,
      JSON.stringify({ ...record, switched: false }),
    );
    await Deno.writeTextFile(pointerPath(w.root), JSON.stringify(before));
    const read = await w.target.status({ effectKey: "second" });
    assertEquals(read.status, "failed");
    assertEquals(
      read.observedCommitSha,
      SHA_A,
      "the environment still serves the first release",
    );
  } finally {
    await Deno.remove(w.parent, { recursive: true });
  }
});

Deno.test("a crash after the switch and before the record reads back as applied (#43 AC2)", async () => {
  const w = await world();
  try {
    const release = await prepared(w.target, SHA_A);
    const live = await w.target.deploy({
      releaseId: release.releaseId,
      effectKey: "k",
    });
    const recordPath = join(w.root, "deployments", `${live.deploymentId}.json`);
    const record = await readJson(recordPath);
    // The record was not updated after the pointer switched.
    await Deno.writeTextFile(
      recordPath,
      JSON.stringify({ ...record, switched: false }),
    );
    const read = await w.target.status({ effectKey: "k" });
    assertEquals(read.status, "deploying");
    assertEquals(read.observedCommitSha, SHA_A);
  } finally {
    await Deno.remove(w.parent, { recursive: true });
  }
});

Deno.test("a key the target never saw reads back as failed with nothing recorded (#43 AC2)", async () => {
  const w = await world();
  try {
    const read = await w.target.status({ effectKey: "lost-before-arrival" });
    assertEquals(read, {
      deploymentId: null,
      effectId: null,
      status: "failed",
    });
  } finally {
    await Deno.remove(w.parent, { recursive: true });
  }
});

Deno.test("a rollback cut before the switch reads back failed, after it reads back rolled back, and repeating it never switches twice (#43 AC2)", async () => {
  const w = await world();
  try {
    const first = await prepared(w.target, SHA_A);
    await w.target.deploy({ releaseId: first.releaseId, effectKey: "first" });
    const second = await prepared(w.target, SHA_B);
    const live = await w.target.deploy({
      releaseId: second.releaseId,
      effectKey: "second",
    });
    const done = await w.target.rollback({
      deploymentId: live.deploymentId,
      effectKey: "back",
    });
    assertEquals(done.status, "rolled_back");
    assertEquals((await readJson(pointerPath(w.root))).commitSha, SHA_A);

    // Repeating the same key answers from the journal and moves nothing.
    await Deno.writeTextFile(
      pointerPath(w.root),
      JSON.stringify({
        releaseId: second.releaseId,
        commitSha: SHA_B,
        deploymentId: live.deploymentId,
      }),
    );
    const again = await w.target.rollback({
      deploymentId: live.deploymentId,
      effectKey: "back",
    });
    assertEquals(again.effectId, done.effectId);
    assertEquals(
      (await readJson(pointerPath(w.root))).commitSha,
      SHA_B,
      "a repeated key is a read, not a second switch",
    );

    // The crash cut before the switch: journal there, the environment still on B.
    const recordPath = join(w.root, "deployments", `${live.deploymentId}.json`);
    const record = await readJson(recordPath);
    await Deno.writeTextFile(
      recordPath,
      JSON.stringify({ ...record, status: "rolling_back" }),
    );
    assertEquals(
      (await w.target.status({ effectKey: "back" })).status,
      "failed",
    );

    // The crash cut after the switch: the environment is back on A.
    await Deno.writeTextFile(
      pointerPath(w.root),
      JSON.stringify(record.previous),
    );
    assertEquals(
      (await w.target.status({ effectKey: "back" })).status,
      "rolled_back",
    );
  } finally {
    await Deno.remove(w.parent, { recursive: true });
  }
});

Deno.test("a rollback cut after the switch answers the same by status and by its repeated key (#43 AC2)", async () => {
  const w = await world();
  try {
    const first = await prepared(w.target, SHA_A);
    await w.target.deploy({ releaseId: first.releaseId, effectKey: "first" });
    const second = await prepared(w.target, SHA_B);
    const live = await w.target.deploy({
      releaseId: second.releaseId,
      effectKey: "second",
    });
    await w.target.rollback({
      deploymentId: live.deploymentId,
      effectKey: "back",
    });
    // The crash: the pointer is back on the first release, the record write was lost.
    const recordPath = join(w.root, "deployments", `${live.deploymentId}.json`);
    const record = await readJson(recordPath);
    await Deno.writeTextFile(
      recordPath,
      JSON.stringify({ ...record, status: "rolling_back" }),
    );
    const byStatus = await w.target.status({ effectKey: "back" });
    const byKey = await w.target.rollback({
      deploymentId: live.deploymentId,
      effectKey: "back",
    });
    assertEquals(byStatus.status, "rolled_back");
    assertEquals(byKey.status, "rolled_back");
    assertEquals(byKey.restoredCommitSha, SHA_A);
  } finally {
    await Deno.remove(w.parent, { recursive: true });
  }
});

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "node:path";
import {
  canMove,
  ROLLBACK_SOURCE_STATUSES,
} from "../../apps/server/src/modules/delivery/deployment-states.ts";
import type { DeploymentRead } from "../../apps/server/src/modules/delivery/deployments.ts";
import {
  createDeploymentDriver,
  type DeploymentLedger,
} from "../../apps/server/src/modules/delivery/deployment-driver.ts";
import {
  createLocalReleaseTarget,
  type HealthEvidence,
  type ReleaseProbe,
} from "../../apps/server/src/modules/delivery/local-release-target.ts";
import {
  type ReleaseAdapter,
  ReleaseRefused,
} from "../../apps/server/src/modules/delivery/release-adapter.ts";

/**
 * #43 slice 2: the delivery adapter over a local directory, and the driver that
 * moves a deployment record by what the adapter reports. Everything runs on a
 * temporary directory: no network, no database, no process.
 */

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const REPOSITORY = "00000000-0000-4000-8000-000000000001";
const RUN = "00000000-0000-4000-8000-000000000002";

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

const encoder = new TextEncoder();
const buildBytes = (sha: string) => encoder.encode(`build of ${sha}`);

/** A ledger with the store's rules: an allowed move, on the version the caller read. */
function memoryLedger() {
  const rows = new Map<string, DeploymentRead>();
  const ledger: DeploymentLedger = {
    read: (id) => {
      const row = rows.get(id);
      if (!row) throw new Error("no such deployment");
      return Promise.resolve({ ...row });
    },
    advance: (id, move) => {
      const row = rows.get(id);
      if (!row) throw new Error("no such deployment");
      if (!canMove(move.from, move.to)) throw new Error("move_not_allowed");
      if (row.status !== move.from || row.version !== move.expectedVersion) {
        throw new Error("deployment_changed");
      }
      const next = {
        ...row,
        status: move.to,
        version: row.version + 1,
        healthEvidenceId: row.healthEvidenceId ?? move.healthEvidenceId ?? null,
      };
      rows.set(id, next);
      return Promise.resolve({ ...next });
    },
    startRollback: (id) => {
      const row = rows.get(id);
      if (!row) throw new Error("no such deployment");
      if (!ROLLBACK_SOURCE_STATUSES.includes(row.status)) {
        throw new Error("deployment_in_progress");
      }
      const next = {
        ...row,
        status: "rolling_back" as const,
        version: row.version + 1,
      };
      rows.set(id, next);
      return Promise.resolve({ ...next });
    },
  };
  let serial = 10;
  const queue = async (
    commitSha: string,
    previous: DeploymentRead | null = null,
  ): Promise<DeploymentRead> => {
    serial += 1;
    const row: DeploymentRead = {
      id: `00000000-0000-4000-8000-0000000000${serial}`,
      repositoryId: REPOSITORY,
      runId: RUN,
      environment: "staging",
      commitSha,
      artifactDigest: await digestOf(buildBytes(commitSha)),
      previousDeploymentId: previous?.id ?? null,
      status: "queued",
      externalEffectId: null,
      healthEvidenceId: null,
      createdAt: "2026-11-22T00:00:00.000Z",
      updatedAt: "2026-11-22T00:00:00.000Z",
      version: 1,
    };
    rows.set(row.id, row);
    return { ...row };
  };
  return { ledger, queue, rows };
}

async function harness(
  overrides: {
    probe?: (served: string | null) => ReleaseProbe;
    builds?: (sha: string) => Uint8Array | null;
  } = {},
) {
  const root = await Deno.makeTempDir({ prefix: "bakery-release-" });
  const evidence: HealthEvidence[] = [];
  const served = async (): Promise<string | null> => {
    try {
      return JSON.parse(await Deno.readTextFile(join(root, "current.json")))
        .commitSha;
    } catch {
      return null;
    }
  };
  const target = createLocalReleaseTarget({
    root,
    environment: "staging",
    artifacts: async (input) => {
      const bytes = (overrides.builds ?? buildBytes)(input.headSha);
      return bytes === null ? null : { bytes, digest: await digestOf(bytes) };
    },
    // The running app reports the release the pointer names, unless a test says otherwise.
    probe: async () => {
      const commit = await served();
      return overrides.probe?.(commit) ??
        { version: commit ?? "none", state: "ok" };
    },
    saveEvidence: (entry) => {
      evidence.push(entry);
      return Promise.resolve(crypto.randomUUID());
    },
  });
  const store = memoryLedger();
  const calls = { deploy: 0, rollback: 0 };
  return { root, target, evidence, served, calls, ...store };
}

/** An adapter whose answers can be lost: the mutation ran (or not) and the caller sees an error. */
function lossy(
  target: ReleaseAdapter,
  calls: { deploy: number; rollback: number },
  loss: { deploy?: "before" | "after"; rollback?: "before" | "after" },
): ReleaseAdapter {
  return {
    ...target,
    deploy: async (input) => {
      if (loss.deploy === "before") throw new Error("connection reset");
      calls.deploy += 1;
      const answer = await target.deploy(input);
      if (loss.deploy === "after") throw new Error("connection reset");
      return answer;
    },
    rollback: async (input) => {
      if (loss.rollback === "before") throw new Error("connection reset");
      calls.rollback += 1;
      const answer = await target.rollback(input);
      if (loss.rollback === "after") throw new Error("connection reset");
      return answer;
    },
  };
}

Deno.test("a deployment closes healthy only when the running release reports the exact revision (#43 AC1)", async () => {
  const h = await harness();
  const driver = createDeploymentDriver({
    ledger: h.ledger,
    adapter: h.target,
  });
  const queued = await h.queue(SHA_A);
  const { deployment, effectKey } = await driver.deploy(queued.id, {
    profileRevision: 1,
  });
  assertEquals(deployment.status, "healthy");
  assertEquals(effectKey, null);
  assert(deployment.healthEvidenceId !== null, "real health evidence is kept");
  assertEquals(h.evidence.length, 1);
  assertEquals(h.evidence[0].observedVersion, SHA_A);
  assertEquals(await h.served(), SHA_A);
});

Deno.test("a release that does not report the revision is not healthy, and the previous release is restored (#43 AC2)", async () => {
  // The new release never takes over: the app keeps reporting the old commit.
  const h = await harness({ probe: () => ({ version: SHA_A, state: "ok" }) });
  const driver = createDeploymentDriver({
    ledger: h.ledger,
    adapter: h.target,
  });
  const first = await h.queue(SHA_A);
  assertEquals(
    (await driver.deploy(first.id, { profileRevision: 1 })).deployment.status,
    "healthy",
  );
  const second = await h.queue(SHA_B, await h.ledger.read(first.id));
  const outcome = await driver.deploy(second.id, { profileRevision: 1 });
  assertEquals(outcome.deployment.status, "rolled_back");
  assertEquals(await h.served(), SHA_A, "the previous release serves again");
  assertEquals(h.evidence.at(-1)?.observedVersion, SHA_A);
});

Deno.test("a degraded release is rolled back too; a first release with nothing before it just ends degraded (#43 AC2)", async () => {
  const h = await harness({
    probe: (served) => ({ version: served ?? "none", state: "degraded" }),
  });
  const driver = createDeploymentDriver({
    ledger: h.ledger,
    adapter: h.target,
  });
  const first = await h.queue(SHA_A);
  // Nothing to restore: it ends degraded and the environment keeps what it has.
  assertEquals(
    (await driver.deploy(first.id, { profileRevision: 1 })).deployment.status,
    "degraded",
  );
  const second = await h.queue(SHA_B, await h.ledger.read(first.id));
  assertEquals(
    (await driver.deploy(second.id, { profileRevision: 1 })).deployment.status,
    "rolled_back",
  );
  assertEquals(await h.served(), SHA_A);
});

Deno.test("a lost answer to deploy is unknown, is read back by the same key, and never deploys twice (#43 AC2)", async () => {
  const h = await harness();
  const adapter = lossy(h.target, h.calls, { deploy: "after" });
  const driver = createDeploymentDriver({ ledger: h.ledger, adapter });
  const queued = await h.queue(SHA_A);
  const lost = await driver.deploy(queued.id, { profileRevision: 1 });
  assertEquals(lost.deployment.status, "unknown");
  assertEquals(lost.effectKey, `deploy:${queued.id}`);
  // While it is unknown the driver does not start it again.
  assertEquals(
    (await driver.deploy(queued.id, { profileRevision: 1 })).deployment.status,
    "unknown",
  );
  assertEquals(h.calls.deploy, 1);
  const settled = await driver.settle(queued.id, lost.effectKey!);
  assertEquals(settled.deployment.status, "healthy");
  assertEquals(h.calls.deploy, 1, "settling only reads");
  assertEquals(await h.served(), SHA_A);
});

Deno.test("a deploy that never reached the target settles failed and leaves the environment alone (#43 AC2)", async () => {
  const h = await harness();
  const first = await h.queue(SHA_A);
  await createDeploymentDriver({ ledger: h.ledger, adapter: h.target })
    .deploy(first.id, { profileRevision: 1 });
  const adapter = lossy(h.target, h.calls, { deploy: "before" });
  const driver = createDeploymentDriver({ ledger: h.ledger, adapter });
  const second = await h.queue(SHA_B, await h.ledger.read(first.id));
  const lost = await driver.deploy(second.id, { profileRevision: 1 });
  assertEquals(lost.deployment.status, "unknown");
  const settled = await driver.settle(second.id, lost.effectKey!);
  assertEquals(settled.deployment.status, "failed");
  assertEquals(await h.served(), SHA_A);
});

Deno.test("a lost answer to rollback stays unknown until a read says the previous release serves (#43 AC2)", async () => {
  const h = await harness({
    probe: (served) => ({
      version: served === SHA_B ? SHA_A : (served ?? "none"),
      state: "ok",
    }),
  });
  const plain = createDeploymentDriver({ ledger: h.ledger, adapter: h.target });
  const first = await h.queue(SHA_A);
  await plain.deploy(first.id, { profileRevision: 1 });
  const adapter = lossy(h.target, h.calls, { rollback: "after" });
  const driver = createDeploymentDriver({ ledger: h.ledger, adapter });
  const second = await h.queue(SHA_B, await h.ledger.read(first.id));
  const outcome = await driver.deploy(second.id, { profileRevision: 1 });
  assertEquals(outcome.deployment.status, "unknown");
  assert(outcome.effectKey?.startsWith("rollback:"));
  assertEquals(h.calls.rollback, 1);
  const settled = await driver.settle(second.id, outcome.effectKey!);
  assertEquals(settled.deployment.status, "rolled_back");
  assertEquals(h.calls.rollback, 1, "settling only reads");
  assertEquals(await h.served(), SHA_A);
});

Deno.test("a changed artifact, a missing build and a tampered release never reach the environment (#43 AC3)", async () => {
  // The build produces other bytes than the digest the deployment was verified with.
  const changed = await harness({
    builds: (sha) => encoder.encode(`tampered ${sha}`),
  });
  const queued = await changed.queue(SHA_A);
  const driver = createDeploymentDriver({
    ledger: changed.ledger,
    adapter: changed.target,
  });
  assertEquals(
    (await driver.deploy(queued.id, { profileRevision: 1 })).deployment.status,
    "failed",
  );
  assertEquals(await changed.served(), null);

  const missing = await harness({ builds: () => null });
  const none = await missing.queue(SHA_A);
  assertEquals(
    (await createDeploymentDriver({
      ledger: missing.ledger,
      adapter: missing.target,
    })
      .deploy(none.id, { profileRevision: 1 })).deployment.status,
    "failed",
  );

  // A staged artifact edited after it was prepared is refused at deploy and at rollback.
  const staged = await harness();
  const prepared = await staged.target.prepare({
    repositoryId: REPOSITORY,
    headSha: SHA_A,
    profileRevision: 1,
  });
  await Deno.writeTextFile(
    join(staged.root, "releases", prepared.releaseId, "artifact.bin"),
    "edited",
  );
  const error = await assertRejects(
    () =>
      staged.target.deploy({ releaseId: prepared.releaseId, effectKey: "k1" }),
    ReleaseRefused,
  );
  assertEquals(error.refusal, "release_changed");
  assertEquals(await staged.served(), null);
});

Deno.test("the same effect key answers with the first call, and nothing from outside the target is reachable (#43 AC3)", async () => {
  const h = await harness();
  const prepared = await h.target.prepare({
    repositoryId: REPOSITORY,
    headSha: SHA_A,
    profileRevision: 1,
  });
  const one = await h.target.deploy({
    releaseId: prepared.releaseId,
    effectKey: "k",
  });
  const two = await h.target.deploy({
    releaseId: prepared.releaseId,
    effectKey: "k",
  });
  assertEquals(two, one);
  // The same key for another release is a misuse, not a second deploy.
  const other = await h.target.prepare({
    repositoryId: REPOSITORY,
    headSha: SHA_B,
    profileRevision: 1,
  });
  const reused = await assertRejects(
    () => h.target.deploy({ releaseId: other.releaseId, effectKey: "k" }),
    ReleaseRefused,
  );
  assertEquals(reused.refusal, "effect_key_reused");
  // Ids are never paths.
  for (
    const releaseId of [
      "../outside",
      "/etc/passwd",
      "a".repeat(12) + "-" + "../x",
    ]
  ) {
    const refused = await assertRejects(
      () => h.target.deploy({ releaseId, effectKey: "k2" }),
      ReleaseRefused,
    );
    assertEquals(refused.refusal, "no_such_release");
  }
  const unknownEffect = await h.target.status({ effectKey: "never-sent" });
  assertEquals(unknownEffect.status, "failed");
  assertEquals(unknownEffect.deploymentId, null);
});

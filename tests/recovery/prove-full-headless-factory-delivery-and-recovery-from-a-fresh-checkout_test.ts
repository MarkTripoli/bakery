import { assert, assertEquals } from "@std/assert";
import { join } from "node:path";
import { withPgTransaction } from "@bakery/persistence/postgres";
import {
  advanceDeployment,
  createDeployment,
} from "../../apps/server/src/modules/delivery/deployments.ts";
import { createLocalReleaseTarget } from "../../apps/server/src/modules/delivery/local-release-target.ts";
import type { PgDatabase } from "../../apps/server/src/platform/database.ts";
import {
  removeSeededEffects,
  seedEffect,
} from "../helpers/external-effects-seed.ts";
import { withReviewedRun } from "../helpers/review-repair/loop-world.ts";
import {
  adminDatabaseUrl,
  REPO,
  startPointerHealth,
  withLauncherSandbox,
} from "../helpers/recovery-launcher-sandbox.ts";

/**
 * #50 AC3: given a broken Bakery release, when it is recovered without its API
 * or UI, the independent launcher (scripts/deploy/recovery-launcher.sh) puts
 * the known-good release back with verified data and sends nothing external
 * again, and its diagnostics answer while the API is down. The ledger rows are
 * written by the real deployment store, the releases are staged by the real
 * local release target, and the launcher reads both straight from Postgres and
 * the target directory.
 */

const SHA_GOOD = "a1".repeat(20);
const SHA_BAD = "b2".repeat(20);
const TRACE = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const encoder = new TextEncoder();

async function digestOf(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return `sha256:${
    Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0"))
      .join("")
  }`;
}

type Ledger = { organizationId: string; repositoryId: string };

/** Stages both releases, records good as healthy and bad as failed, leaves bad live. */
async function deployGoodThenBad(
  database: PgDatabase,
  world: {
    organizationId: string;
    repositoryId: string;
    runId: string;
    taskId: string;
  },
  target: string,
): Promise<void> {
  const adapter = createLocalReleaseTarget({
    root: target,
    environment: "staging",
    artifacts: async (input) => {
      const bytes = encoder.encode(`build of ${input.headSha}`);
      return { bytes, digest: await digestOf(bytes) };
    },
    probe: async () => {
      const pointer = JSON.parse(
        await Deno.readTextFile(join(target, "current.json")),
      );
      return { version: pointer.commitSha, state: "ok" };
    },
    saveEvidence: () => Promise.resolve(crypto.randomUUID()),
  });
  const principal = (await database.query<{ id: string }>(
    `select principal_id as id from bakery.organization_memberships
      where organization_id = $1 and status = 'active'
      order by created_at limit 1`,
    [world.organizationId],
  )).rows[0].id;
  let number = 500;
  for (const sha of [SHA_GOOD, SHA_BAD]) {
    const prepared = await adapter.prepare({
      repositoryId: world.repositoryId,
      headSha: sha,
      profileRevision: 1,
    });
    await adapter.deploy({
      releaseId: prepared.releaseId,
      effectKey: `deploy-${sha}`,
    });
    await database.query(
      `insert into bakery.pull_requests (
         id,organization_id,task_id,repository_id,provider_number,url,head_sha,
         base_sha,status,merged_sha,run_id,version
       ) values (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,'merged',$8,$9,1)`,
      [
        world.organizationId,
        world.taskId,
        world.repositoryId,
        ++number,
        `https://github.com/acme/widgets/pull/${number}`,
        sha.replace(/./, "c"),
        "1".repeat(40),
        sha,
        world.runId,
      ],
    );
    await withPgTransaction(database, async (transaction) => {
      const row = await createDeployment(
        transaction,
        world.organizationId,
        principal,
        {
          requestId: `request-${crypto.randomUUID()}`,
          traceId: TRACE,
          create: {
            repositoryId: world.repositoryId,
            runId: world.runId,
            environment: "staging",
            commitSha: sha,
            artifactDigest: prepared.artifactDigest,
          },
        },
      );
      let current = await advanceDeployment(
        transaction,
        world.organizationId,
        row.id,
        { from: "queued", to: "deploying", expectedVersion: 1 },
      );
      current = await advanceDeployment(
        transaction,
        world.organizationId,
        row.id,
        {
          from: "deploying",
          to: "verifying",
          expectedVersion: current.version,
        },
      );
      await advanceDeployment(transaction, world.organizationId, row.id, {
        from: "verifying",
        to: sha === SHA_GOOD ? "healthy" : "failed",
        expectedVersion: current.version,
      });
    });
  }
}

const effectRows = async (database: PgDatabase, ids: string[]) =>
  (await database.query<{ id: string; status: string; updated_at: string }>(
    `select id, status, updated_at::text from bakery.external_effects
      where id = any($1::uuid[]) order by id`,
    [ids],
  )).rows;

Deno.test("a broken release with the API down is rolled back by the independent launcher, data verified, nothing sent again (#50 AC3)", async () => {
  await withReviewedRun(async (loop) => {
    const database = loop.fixture.pgDatabase;
    const world = {
      organizationId: loop.repository.organizationId,
      repositoryId: loop.repository.repositoryId,
      runId: loop.runId,
      taskId: loop.taskId,
    } satisfies Ledger & { runId: string; taskId: string };
    const effects = [
      await seedEffect(
        database,
        world.organizationId,
        "confirmed",
        "github.comment.create",
      ),
      await seedEffect(
        database,
        world.organizationId,
        "prepared",
        "github.comment.create",
      ),
    ];
    try {
      let health: ReturnType<typeof startPointerHealth> | undefined;
      await withLauncherSandbox(
        { healthUrl: "http://127.0.0.1:9/health/ready" },
        async (sandbox) => {
          health = startPointerHealth(sandbox.target, new Set([SHA_BAD]));
          await deployGoodThenBad(database, world, sandbox.target);
          const env = { BAKERY_RECOVERY_HEALTH_URL: health.url };
          const before = await effectRows(database, effects);

          // Diagnostics answer while the API is down, from Postgres and the host.
          const diagnosis = await sandbox.run(
            ["diagnose", "--environment", "staging"],
            env,
          );
          assertEquals(diagnosis.code, 0, diagnosis.stderr);
          const report = JSON.parse(diagnosis.stdout);
          assertEquals(report.health.ok, false);
          assertEquals(report.pointer.commitSha, SHA_BAD);
          const ours = report.ledger.filter((row: { repository_id: string }) =>
            row.repository_id === world.repositoryId
          );
          assertEquals(
            ours.map((
              row: { commit_sha: string; status: string },
            ) => [row.commit_sha, row.status]),
            [[SHA_BAD, "failed"], [SHA_GOOD, "healthy"]],
          );
          assert(
            Object.keys(report.migrations).length > 0,
            "the migration ledger is read",
          );
          assert(Array.isArray(report.restores), "the restore record is read");
          assertEquals(
            report.compose.map((s: { service: string }) => s.service),
            ["postgres", "redis", "inngest"],
          );
          assertEquals(
            await sandbox.calls().then((c) =>
              c.filter((l) => l.startsWith("runtime"))
            ),
            [],
          );

          // Recovery: the operator types the known-good sha the report names.
          const recovered = await sandbox.run(
            ["rollback", "--environment", "staging", "--confirm", SHA_GOOD],
            env,
          );
          assertEquals(recovered.code, 0, recovered.stderr + recovered.stdout);
          const result = JSON.parse(recovered.stdout);
          assertEquals(result.outcome, "RECOVERY_VERIFIED");
          assertEquals(
            result.checks.map((
              c: { name: string; ok: boolean },
            ) => [c.name, c.ok]),
            [
              ["api_start", true],
              ["health", true],
              ["migration_checksums", true],
              ["core_row_counts", true],
              ["no_external_replay", true],
            ],
          );
          const pointer = JSON.parse(
            await Deno.readTextFile(join(sandbox.target, "current.json")),
          );
          assertEquals(pointer.commitSha, SHA_GOOD);
          const answer = await (await fetch(health.url)).json();
          assertEquals(answer, { version: SHA_GOOD, state: "ok" });
          assert(
            (await sandbox.calls()).includes(
              `runtime api-start blue ${SHA_GOOD}`,
            ),
          );
          // The confirmed effect is untouched and the prepared one was not sent.
          assertEquals(await effectRows(database, effects), before);
          // The report is kept on the host.
          const kept = [];
          for await (
            const entry of Deno.readDir(join(sandbox.state, "deploy/recovery"))
          ) {
            kept.push(entry.name);
          }
          assertEquals(kept.length, 1);
        },
      ).finally(() => health?.stop());
    } finally {
      await removeSeededEffects(database);
      await database.query(
        "delete from bakery.deployments where repository_id = $1",
        [world.repositoryId],
      );
      await database.query(
        "delete from bakery.pull_requests where repository_id = $1 and provider_number > 500",
        [world.repositoryId],
      );
    }
  }, { bare: true });
});

Deno.test("a rollback whose API start fails still verifies and keeps a record, and reports failure", async () => {
  await withReviewedRun(async (loop) => {
    const database = loop.fixture.pgDatabase;
    const world = {
      organizationId: loop.repository.organizationId,
      repositoryId: loop.repository.repositoryId,
      runId: loop.runId,
      taskId: loop.taskId,
    } satisfies Ledger & { runId: string; taskId: string };
    try {
      let health: ReturnType<typeof startPointerHealth> | undefined;
      await withLauncherSandbox(
        { healthUrl: "http://127.0.0.1:9/health/ready", runtimeExit: 1 },
        async (sandbox) => {
          health = startPointerHealth(sandbox.target, new Set([SHA_BAD]));
          await deployGoodThenBad(database, world, sandbox.target);
          const recovered = await sandbox.run(
            ["rollback", "--environment", "staging", "--confirm", SHA_GOOD],
            { BAKERY_RECOVERY_HEALTH_URL: health.url },
          );
          assertEquals(recovered.code, 71, recovered.stderr + recovered.stdout);
          const result = JSON.parse(recovered.stdout);
          assertEquals(result.outcome, "RECOVERY_VERIFY_FAILED");
          const apiStart = result.checks.find((c: { name: string }) =>
            c.name === "api_start"
          );
          assertEquals(apiStart, {
            name: "api_start",
            ok: false,
            detail: { exitCode: 1 },
          });
          const kept = [];
          for await (
            const entry of Deno.readDir(join(sandbox.state, "deploy/recovery"))
          ) {
            kept.push(entry.name);
          }
          assertEquals(kept.length, 1, "the failed recovery is recorded");
        },
      ).finally(() => health?.stop());
    } finally {
      await database.query(
        "delete from bakery.deployments where repository_id = $1",
        [world.repositoryId],
      );
      await database.query(
        "delete from bakery.pull_requests where repository_id = $1 and provider_number > 500",
        [world.repositoryId],
      );
    }
  }, { bare: true });
});

Deno.test("a restore through the launcher is verified only while the restore fence holds every unsettled effect (#50 AC3)", async () => {
  await withReviewedRun(async (loop) => {
    const database = loop.fixture.pgDatabase;
    const organizationId = loop.repository.organizationId;
    const confirmed = await seedEffect(
      database,
      organizationId,
      "confirmed",
      "github.comment.create",
    );
    const prepared = await seedEffect(
      database,
      organizationId,
      "prepared",
      "github.comment.create",
    );
    const setName = "20261122T000000Z-recovery-launcher";
    try {
      let health: ReturnType<typeof startPointerHealth> | undefined;
      const fence = `deno run -A ${
        JSON.stringify(join(REPO, "tests/helpers/recovery-launcher-fence.ts"))
      } ${JSON.stringify(adminDatabaseUrl())} ${setName} > /dev/null`;
      await withLauncherSandbox(
        {
          healthUrl: "http://127.0.0.1:9/health/ready",
          activeSha: SHA_GOOD,
          restoreScript: `${fence}\necho RESTORE_COMPLETED_HELD`,
        },
        async (sandbox) => {
          health = startPointerHealth(sandbox.target, new Set());
          await Deno.writeTextFile(
            join(sandbox.target, "current.json"),
            JSON.stringify({
              releaseId: "x",
              commitSha: SHA_GOOD,
              deploymentId: "x",
            }),
          );
          const set = join(sandbox.dir, "sets", setName);
          await Deno.mkdir(set, { recursive: true });
          const identity = join(sandbox.dir, "identity.txt");
          await Deno.writeTextFile(identity, "AGE-SECRET-KEY-FAKE\n");
          const restored = await sandbox.run(
            ["restore", set, identity, "--confirm", setName],
            { BAKERY_RECOVERY_HEALTH_URL: health.url },
          );
          assertEquals(restored.code, 0, restored.stderr + restored.stdout);
          const result = JSON.parse(restored.stdout);
          assertEquals(result.outcome, "RECOVERY_VERIFIED");
          assertEquals(
            result.checks.map((
              c: { name: string; ok: boolean },
            ) => [c.name, c.ok]),
            [["health", true], ["migration_checksums", true], [
              "restore_fence_holds",
              true,
            ]],
          );
          assert(
            (await sandbox.calls()).some((c) =>
              c.startsWith(`restore ${set} ${identity} --confirm ${setName}`)
            ),
          );
          const rows = await effectRows(database, [confirmed, prepared].sort());
          const byId = new Map(rows.map((r) => [r.id, r.status]));
          assertEquals(
            byId.get(confirmed),
            "confirmed",
            "a confirmed effect stays settled",
          );
          assertEquals(
            byId.get(prepared),
            "uncertain",
            "an unsent effect is held, never sent",
          );
        },
      ).finally(() => health?.stop());
    } finally {
      await removeSeededEffects(database);
      await database.query(
        "delete from bakery.installation_restores where backup_name = $1",
        [setName],
      );
    }
  }, { bare: true });
});

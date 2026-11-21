import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  type BackupSettingsFixture,
  openBackupSettingsFixture,
} from "../helpers/backup-settings.ts";
import {
  clearInstallationMaintenance,
  holdInstallation,
} from "../helpers/installation-maintenance.ts";
import { effectsDigest } from "../../apps/server/src/modules/backups/cutoff-rules.ts";
import {
  removeSeededEffects,
  seedEffect as seed,
} from "../helpers/external-effects-seed.ts";

/**
 * #64 slice C (also #49) against real Postgres: backupRunner.cutoff takes the
 * database clock at the moment the installation is quiet, with a census of the
 * external effects that could still reach a provider, only while the run holds
 * the installation quiesced, only for the runner that holds the claim, and
 * only once per run.
 */

const CUTOFF = "backupRunner.cutoff";

type CutoffBody = {
  runId: string;
  cutoffAt: string;
  effectsTotal: number;
  effectsPrepared: number;
  effectsSubmitted: number;
  effectsUncertain: number;
  effectsByOperation: { operation: string; count: number }[];
  effectsDigest: string;
};

const query = (o: BackupSettingsFixture) => o.f.pgDatabase;

async function cleanup(o: BackupSettingsFixture) {
  // The switch row points at a backup run; effects point at a principal.
  await clearInstallationMaintenance(query(o));
  await removeSeededEffects(query(o));
}

async function withFixture<T>(work: (o: BackupSettingsFixture) => Promise<T>) {
  const o = await openBackupSettingsFixture();
  try {
    await cleanup(o);
    return await work(o);
  } finally {
    try {
      await cleanup(o);
    } finally {
      await o.finish();
    }
  }
}

/** A backup the runner has claimed: its credential, the run and its lease. */
async function claimed(o: BackupSettingsFixture) {
  const credential = await o.issueCredential();
  const asked = await o.admin("POST", "/v1/installation/backups", {}, {
    keyed: true,
  });
  assertEquals(asked.status, 202, await asked.clone().text());
  const response = await o.runner(
    credential,
    "POST",
    "/v1/backup-runner/claims",
    {},
  );
  assertEquals(response.status, 200, await response.clone().text());
  const claim = await response.json() as {
    claimed: boolean;
    runId: string;
    leaseToken: string;
  };
  assertEquals(claim.claimed, true);
  return { credential, runId: claim.runId, leaseToken: claim.leaseToken };
}

const askCutoff = (
  o: BackupSettingsFixture,
  credential: string,
  runId: string,
  leaseToken: string,
) =>
  o.runner(credential, "POST", `/v1/backup-runner/runs/${runId}/cutoff`, {
    leaseToken,
  });

const seedEffect = (
  o: BackupSettingsFixture,
  status: string,
  operation: string,
) => seed(query(o), o.f.organizationId, status, operation);

const storedCutoffs = async (o: BackupSettingsFixture, runId: string) =>
  (await query(o).query<{ cutoffAt: Date; digest: string }>(
    `select cutoff_at as "cutoffAt", effects_digest as digest
       from bakery.backup_cutoffs where run_id = $1`,
    [runId],
  )).rows;

const cutoffAudit = async (o: BackupSettingsFixture, runId: string) =>
  (await query(o).query<{ details: Record<string, unknown> }>(
    `select details from bakery.audit_events
      where operation = $1 and details->>'runId' = $2 order by created_at`,
    [CUTOFF, runId],
  )).rows;

Deno.test("the cutoff is the database clock at the quiet moment, with a census of unsettled effects only", async () => {
  await withFixture(async (o) => {
    const run = await claimed(o);
    await holdInstallation(query(o), {
      state: "quiesced",
      ownerRunId: run.runId,
    });
    // Unsettled: prepared, submitted, uncertain. Settled: confirmed, failed.
    const live = [
      await seedEffect(o, "prepared", "github.merge"),
      await seedEffect(o, "prepared", "github.merge"),
      await seedEffect(o, "submitted", "slack.post"),
      await seedEffect(o, "uncertain", "github.merge"),
      // An operation name outside the code-defined shape counts as other.
      await seedEffect(o, "prepared", "Tenant X/Secret Project"),
    ];
    await seedEffect(o, "confirmed", "github.merge");
    await seedEffect(o, "confirmed", "linear.update");
    await seedEffect(o, "failed", "slack.post");

    const before = (await query(o).query<{ t: Date }>(
      "select clock_timestamp() as t",
    )).rows[0].t;
    const response = await askCutoff(
      o,
      run.credential,
      run.runId,
      run.leaseToken,
    );
    const after = (await query(o).query<{ t: Date }>(
      "select clock_timestamp() as t",
    )).rows[0].t;
    assertEquals(response.status, 200, await response.clone().text());
    assertEquals(response.headers.get("cache-control"), "no-store");
    const text = await response.clone().text();
    const body = await response.json() as CutoffBody;

    // The database clock, between the two readings around the call.
    const at = new Date(body.cutoffAt);
    assert(at >= before && at <= after, `${body.cutoffAt} outside the call`);
    assertEquals(body.runId, run.runId);
    // Counts: only the five unsettled effects, by status and by operation.
    assertEquals(
      [
        body.effectsTotal,
        body.effectsPrepared,
        body.effectsSubmitted,
        body.effectsUncertain,
      ],
      [5, 3, 1, 1],
    );
    assertEquals(body.effectsByOperation, [
      { operation: "github.merge", count: 3 },
      { operation: "other", count: 1 },
      { operation: "slack.post", count: 1 },
    ]);
    assertEquals(body.effectsDigest, await effectsDigest(live));
    // Nothing about any effect leaves the server: no id, target or odd name.
    for (const id of live) assert(!text.includes(id), "an effect id leaked");
    assert(!text.includes("secret-target"), "a target leaked");
    assert(!text.includes("Secret Project"), "an operation name leaked");

    // The record is stored once, and audited without any effect detail.
    const stored = await storedCutoffs(o, run.runId);
    assertEquals(stored.length, 1);
    assertEquals(stored[0].cutoffAt.toISOString(), body.cutoffAt);
    assertEquals(stored[0].digest, body.effectsDigest);
    const audit = await cutoffAudit(o, run.runId);
    assertEquals(audit.length, 1);
    assertEquals(audit[0].details.effectsTotal, 5);
    assertEquals(audit[0].details.effectsDigest, body.effectsDigest);
    const auditText = JSON.stringify(audit[0].details);
    for (const id of live) assert(!auditText.includes(id));
    assert(!auditText.includes("secret-target"));
    assert(!auditText.includes(run.leaseToken));
  });
});

Deno.test("an installation with nothing unsettled has an empty census, and asking again returns the same cutoff", async () => {
  await withFixture(async (o) => {
    const run = await claimed(o);
    await holdInstallation(query(o), {
      state: "quiesced",
      ownerRunId: run.runId,
    });
    await seedEffect(o, "confirmed", "github.merge");
    const first = await askCutoff(o, run.credential, run.runId, run.leaseToken);
    assertEquals(first.status, 200, await first.clone().text());
    const one = await first.json() as CutoffBody;
    assertEquals(one.effectsTotal, 0);
    assertEquals(one.effectsByOperation, []);
    assertEquals(one.effectsDigest, await effectsDigest([]));

    // Time passes and an effect becomes unsettled: the cutoff of a run never moves.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await seedEffect(o, "prepared", "github.merge");
    const second = await askCutoff(
      o,
      run.credential,
      run.runId,
      run.leaseToken,
    );
    assertEquals(second.status, 200, await second.clone().text());
    assertEquals(await second.json(), one);
    assertEquals((await storedCutoffs(o, run.runId)).length, 1);
    // Audited on the first ask only.
    assertEquals((await cutoffAudit(o, run.runId)).length, 1);
  });
});

Deno.test("no cutoff unless the run holds the installation quiesced", async () => {
  await withFixture(async (o) => {
    const run = await claimed(o);
    const refused = async (name: string) => {
      const response = await askCutoff(
        o,
        run.credential,
        run.runId,
        run.leaseToken,
      );
      assertEquals(
        response.status,
        409,
        `${name}: ${await response.clone().text()}`,
      );
      assertEquals(
        (await response.json() as { reason: string }).reason,
        "not_quiesced",
        name,
      );
      assertEquals((await storedCutoffs(o, run.runId)).length, 0, name);
      assertEquals((await cutoffAudit(o, run.runId)).length, 0, name);
    };
    // Not held at all.
    await refused("not held");
    // Draining: new work is refused but things may still be in flight.
    await holdInstallation(query(o), {
      state: "draining",
      ownerRunId: run.runId,
    });
    await refused("draining");
    // Quiesced, but by nobody, or by another run.
    await holdInstallation(query(o), { state: "quiesced", ownerRunId: null });
    await refused("held by nobody");
    // Quiesced, but its lease has lapsed: it counts as off.
    await holdInstallation(query(o), {
      state: "quiesced",
      ownerRunId: run.runId,
      leaseSeconds: -5,
    });
    await refused("lapsed");
    // Released.
    await holdInstallation(query(o), {
      state: "quiesced",
      ownerRunId: run.runId,
    });
    await query(o).query(
      "update bakery.installation_maintenance set state = 'off'",
    );
    await refused("released");
    // And once it does hold it quiesced, the cutoff is given.
    await holdInstallation(query(o), {
      state: "quiesced",
      ownerRunId: run.runId,
    });
    const ok = await askCutoff(o, run.credential, run.runId, run.leaseToken);
    assertEquals(ok.status, 200, await ok.clone().text());
  });
});

Deno.test("only the runner that holds the claim gets a cutoff", async () => {
  await withFixture(async (o) => {
    const run = await claimed(o);
    await holdInstallation(query(o), {
      state: "quiesced",
      ownerRunId: run.runId,
    });
    const path = `/v1/backup-runner/runs/${run.runId}/cutoff`;

    // A wrong lease token is forbidden; so is a token for no run.
    const wrong = await askCutoff(
      o,
      run.credential,
      run.runId,
      "x".repeat(43),
    );
    assertEquals(wrong.status, 403);
    await wrong.body?.cancel();
    const unknown = await askCutoff(
      o,
      run.credential,
      crypto.randomUUID(),
      run.leaseToken,
    );
    assertEquals(unknown.status, 404);
    await unknown.body?.cancel();
    const malformed = await o.runner(
      run.credential,
      "POST",
      "/v1/backup-runner/runs/not-a-uuid/cutoff",
      { leaseToken: run.leaseToken },
    );
    assertEquals(malformed.status, 400);
    await malformed.body?.cancel();

    // The credential is checked before the body is read: a wrong credential
    // with an invalid body is 403, never a validation error.
    const noBody = await o.runner("not-the-credential", "POST", path, {
      nonsense: "x".repeat(10_000),
    });
    assertEquals(noBody.status, 403);
    await noBody.body?.cancel();
    // An administrator's session is not the runner, and neither is nobody.
    const session = await o.admin("POST", path, { leaseToken: run.leaseToken });
    assertEquals(session.status, 401);
    await session.body?.cancel();
    // Nothing was recorded by any refusal.
    assertEquals((await storedCutoffs(o, run.runId)).length, 0);

    // A claim whose lease has lapsed is gone: 409, and no cutoff.
    await query(o).query(
      "update bakery.backup_runs set lease_expires_at = clock_timestamp() - interval '1 second' where id = $1",
      [run.runId],
    );
    const lapsed = await askCutoff(
      o,
      run.credential,
      run.runId,
      run.leaseToken,
    );
    assertEquals(lapsed.status, 409);
    assertEquals(
      (await lapsed.json() as { reason: string }).reason,
      "lease_expired",
    );
    assertEquals((await storedCutoffs(o, run.runId)).length, 0);
  });
});

Deno.test("the status shows the cutoff of the newest completed backup that recorded one", async () => {
  await withFixture(async (o) => {
    const status = async () =>
      await (await o.admin("GET", "/v1/installation/backups/status"))
        .json() as {
          lastBackupCutoffAt: string | null;
        };
    assertEquals((await status()).lastBackupCutoffAt, null);
    const run = await claimed(o);
    await holdInstallation(query(o), {
      state: "quiesced",
      ownerRunId: run.runId,
    });
    const response = await askCutoff(
      o,
      run.credential,
      run.runId,
      run.leaseToken,
    );
    const cutoff = await response.json() as CutoffBody;
    // A cutoff of a run still going is not the cutoff of a backup yet.
    assertEquals((await status()).lastBackupCutoffAt, null);
    const done = await o.runner(
      run.credential,
      "POST",
      `/v1/backup-runner/runs/${run.runId}/reports`,
      {
        leaseToken: run.leaseToken,
        sequence: 1,
        status: "completed",
        sizeBytes: "10",
        locations: ["server-host"],
      },
    );
    assertEquals(done.status, 200, await done.clone().text());
    assertEquals((await status()).lastBackupCutoffAt, cutoff.cutoffAt);
    assertNotEquals(cutoff.cutoffAt, null);
  });
});

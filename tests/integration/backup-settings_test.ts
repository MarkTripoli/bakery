import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { authTestOrigin } from "../helpers/auth.ts";
import { call } from "../helpers/installation-settings.ts";
import {
  accessKeyId,
  type BackupSettingsFixture,
  namedHost,
  offsiteBody,
  offsitePath,
  openBackupSettingsFixture,
  type Problem,
  publicAddress,
  runnerSettingsPath,
  schedulePath,
  secretAccessKey,
  startS3Receiver,
  verificationPath,
} from "../helpers/backup-settings.ts";

/**
 * #80 slice S1b: the backup schedule and the off-site destination, the runner's
 * settings read, and the scheduled backup a claim records when one is due, over
 * the real routes and a real Postgres. The destination is a test the test
 * steers, except one test that talks to a tiny in-process S3-compatible
 * receiver to prove the real client path.
 */

type Schedule = {
  enabled: boolean;
  interval: string;
  timeOfDayUtc: string;
  daysToKeep: number;
  updatedAt: string | null;
  version: number;
};
type Offsite = {
  configured: boolean;
  endpoint: string | null;
  region: string | null;
  bucket: string | null;
  prefix: string | null;
  credentialRevision: number | null;
  credentialUpdatedAt: string | null;
  version: number;
};
type Verification = {
  outcome: string;
  detail: string | null;
  checkedAt: string;
};

const schedule = {
  enabled: true,
  interval: "daily",
  timeOfDayUtc: "03:00",
  daysToKeep: 30,
};

const problem = async (response: Response) => await response.json() as Problem;

type RunnerAudit = {
  principal_id: string | null;
  resource_type: string;
  resource_id: string;
  outcome: string;
  details: Record<string, unknown>;
};

/** Every audit row the runner's settings reads wrote, oldest first. */
async function runnerAudit(o: BackupSettingsFixture): Promise<RunnerAudit[]> {
  return (await o.f.pgDatabase.query<RunnerAudit>(
    `select principal_id, resource_type, resource_id, outcome, details
       from bakery.audit_events
      where operation = 'backupRunner.settings' order by created_at, id`,
  )).rows;
}
const runnerAuditCount = async (o: BackupSettingsFixture) =>
  (await runnerAudit(o)).length;

async function secretCount(o: BackupSettingsFixture): Promise<number> {
  return Number(
    (await o.f.pgDatabase.query<{ count: string }>(
      `select count(*) from bakery.secrets
      where organization_id is null and provider = 's3-backup'`,
    )).rows[0].count,
  );
}

Deno.test("the schedule reads as off before a save, saves under If-Match and replays by key", async () => {
  const o = await openBackupSettingsFixture();
  try {
    const before = await o.admin("GET", schedulePath);
    assertEquals(before.status, 200);
    assertEquals(await before.json() as Schedule, {
      enabled: false,
      interval: "daily",
      timeOfDayUtc: "03:00",
      daysToKeep: 30,
      updatedAt: null,
      version: 0,
    });
    // The first save carries no If-Match; a bad time or a closed-set miss is 422/400.
    const badTime = await o.putSchedule({ ...schedule, timeOfDayUtc: "24:00" });
    assertEquals(badTime.status, 422, await badTime.clone().text());
    assertEquals((await problem(badTime)).issues?.[0].path, ["timeOfDayUtc"]);
    const badInterval = await o.putSchedule({
      ...schedule,
      interval: "monthly",
    });
    assert(badInterval.status >= 400 && badInterval.status < 500);
    const withMatch = await o.putSchedule(schedule, { version: 1 });
    assertEquals(withMatch.status, 412);

    // No Idempotency-Key at all is refused.
    const unkeyed = await o.admin("PUT", schedulePath, schedule);
    assert(
      unkeyed.status >= 400,
      "a save without an Idempotency-Key is refused",
    );
    const key = crypto.randomUUID();
    const send = () =>
      call(o.f, "PUT", schedulePath, o.f.adminCookie, {
        body: schedule,
        headers: { "Idempotency-Key": key },
      });
    const saved = await send();
    assertEquals(saved.status, 200, await saved.clone().text());
    const savedBody = await saved.json() as Schedule;
    assertEquals(savedBody.version, 1);
    assertEquals(savedBody.enabled, true);
    // The same key and body replays the stored answer without a second version.
    const replay = await send();
    assertEquals(replay.status, 200);
    assertEquals((await replay.json() as Schedule).version, 1);
    // Once a schedule exists If-Match is required (428) and a stale one is 412.
    const missing = await o.putSchedule({ ...schedule, enabled: false });
    assertEquals(missing.status, 428);
    const stale = await o.putSchedule({ ...schedule, enabled: false }, {
      version: 7,
    });
    assertEquals(stale.status, 412);
    const next = await o.putSchedule(
      { ...schedule, interval: "weekly", daysToKeep: 90 },
      { version: 1 },
    );
    assertEquals(next.status, 200, await next.clone().text());
    const nextBody = await next.json() as Schedule;
    assertEquals([nextBody.interval, nextBody.daysToKeep, nextBody.version], [
      "weekly",
      90,
      2,
    ]);
    // The change is audited with its figures.
    const audit = await o.f.pgDatabase.query<
      { details: Record<string, unknown> }
    >(
      `select details from bakery.audit_events
        where operation = 'backupSchedule.put' and outcome = 'succeeded'
        order by created_at desc limit 1`,
    );
    assertEquals(audit.rows[0].details.interval, "weekly");
  } finally {
    await o.finish();
  }
});

Deno.test("a destination is tested before it is saved, and a refused one stores nothing", async () => {
  const o = await openBackupSettingsFixture();
  try {
    const empty = await (await o.admin("GET", offsitePath)).json() as Offsite;
    assertEquals([empty.configured, empty.version], [false, 0]);
    // A lone half of the pair, and a first save with no pair, are 400.
    const half = await o.putOffsite(
      offsiteBody({ secretAccessKey: undefined }),
    );
    assertEquals(half.status, 400, await half.clone().text());
    const none = await o.putOffsite(
      offsiteBody({ accessKeyId: undefined, secretAccessKey: undefined }),
    );
    assertEquals(none.status, 400);
    // An unsafe endpoint is 422 before anything is called.
    for (const endpoint of ["http://s3.example.com", "https://10.0.0.5"]) {
      const bad = await o.putOffsite(offsiteBody({ endpoint }));
      assertEquals(bad.status, 422, endpoint);
      assertEquals((await problem(bad)).issues?.[0].path, ["endpoint"]);
    }
    assertEquals(o.calls.length, 0);

    // The destination says no: 422 with its own answer, and nothing is stored.
    o.setProbe(() =>
      Promise.resolve({
        outcome: "destination_refused",
        detail: "AccessDenied: the key may not write to this bucket",
      })
    );
    const refused = await o.putOffsite(offsiteBody());
    assertEquals(refused.status, 422, await refused.clone().text());
    const refusal = await problem(refused);
    assertEquals(refusal.issues?.[0].code, "destination_refused");
    assertEquals(
      refusal.issues?.[0].message,
      "AccessDenied: the key may not write to this bucket",
    );
    assertEquals(o.calls.length, 1);
    assertEquals(
      (await (await o.admin("GET", offsitePath)).json() as Offsite).version,
      0,
    );
    assertEquals(await secretCount(o), 0);

    // It says yes: saved at version 1 with revision 1, and the read has no secret.
    o.setProbe(() => Promise.resolve({ outcome: "verified", detail: null }));
    const saved = await o.putOffsite(offsiteBody());
    assertEquals(saved.status, 200, await saved.clone().text());
    const text = await saved.clone().text();
    const body = await saved.json() as Offsite;
    assertEquals(body.configured, true);
    assertEquals(
      [body.version, body.credentialRevision, body.bucket, body.prefix],
      [1, 1, "bakery-backups", "prod/"],
    );
    assert(!text.includes(accessKeyId) && !text.includes(secretAccessKey));
    const read = await (await o.admin("GET", offsitePath)).text();
    assert(!read.includes(accessKeyId) && !read.includes(secretAccessKey));
    assertEquals(o.calls.at(-1)?.secretAccessKey, secretAccessKey);
    assertEquals(o.calls.at(-1)?.prefix, "prod/");
  } finally {
    await o.finish();
  }
});

Deno.test("a save that moves the destination is tested with the new pair, a plain save is not tested at all", async () => {
  const o = await openBackupSettingsFixture();
  try {
    assertEquals((await o.putOffsite(offsiteBody())).status, 200);
    assertEquals(o.calls.length, 1);
    // Nothing about where or how to connect changed: no test object is sent.
    const same = await o.putOffsite(
      offsiteBody({ accessKeyId: undefined, secretAccessKey: undefined }),
      { version: 1 },
    );
    assertEquals(same.status, 200, await same.clone().text());
    assertEquals(o.calls.length, 1);
    assertEquals((await same.json() as Offsite).version, 2);
    // A moved bucket is tested with the pair that came with the move, never
    // with the stored one.
    const moved = await o.putOffsite(
      offsiteBody({
        bucket: "other-bucket",
        accessKeyId: "AKIAMOVED",
        secretAccessKey: "moved/secret",
      }),
      { version: 2 },
    );
    assertEquals(moved.status, 200, await moved.clone().text());
    assertEquals(o.calls.length, 2);
    assertEquals(o.calls[1].bucket, "other-bucket");
    assertEquals(o.calls[1].accessKeyId, "AKIAMOVED");
    assertEquals(o.calls[1].secretAccessKey, "moved/secret");
    // A move the destination refuses keeps the old bucket.
    o.setProbe(() =>
      Promise.resolve({ outcome: "destination_unreachable", detail: "timeout" })
    );
    const refused = await o.putOffsite(
      offsiteBody({
        bucket: "third-bucket",
        accessKeyId: "AKIATHIRD",
        secretAccessKey: "third/secret",
      }),
      { version: 3 },
    );
    assertEquals(refused.status, 422);
    assertEquals(
      (await (await o.admin("GET", offsitePath)).json() as Offsite).bucket,
      "other-bucket",
    );
    // New credentials are the next revision, and the old one is kept for audit.
    o.setProbe(() => Promise.resolve({ outcome: "verified", detail: null }));
    const rotated = await o.putOffsite(
      offsiteBody({
        bucket: "other-bucket",
        accessKeyId: "AKIAROTATED",
        secretAccessKey: "rotated/secret",
      }),
      { version: 3 },
    );
    assertEquals(rotated.status, 200, await rotated.clone().text());
    const rotatedBody = await rotated.json() as Offsite;
    assertEquals([rotatedBody.credentialRevision, rotatedBody.version], [3, 4]);
    assertEquals(await secretCount(o), 1);
    const versions = await o.f.pgDatabase.query<{ count: string }>(
      `select count(*) from bakery.secret_versions version
         join bakery.secrets secret on secret.id = version.secret_id
        where secret.provider = 's3-backup'`,
    );
    assertEquals(Number(versions.rows[0].count), 3);
    // A stale or missing If-Match is refused.
    assertEquals(
      (await o.putOffsite(offsiteBody({ bucket: "other-bucket" }), {
        version: 1,
      }))
        .status,
      412,
    );
    assertEquals(
      (await o.putOffsite(offsiteBody({ bucket: "other-bucket" }))).status,
      428,
    );
  } finally {
    await o.finish();
  }
});

Deno.test("moving the destination needs the key pair again, and a prefix-only change keeps it", async () => {
  const o = await openBackupSettingsFixture();
  try {
    assertEquals((await o.putOffsite(offsiteBody())).status, 200);
    assertEquals(o.calls.length, 1);
    const saved = await (await o.admin("GET", offsitePath)).json() as Offsite;
    const noKeys = { accessKeyId: undefined, secretAccessKey: undefined };
    // A new endpoint, region or bucket without the pair is refused, naming the
    // access key id. No test object is sent and nothing is stored, so the saved
    // pair never reaches the new host and the runner never releases it there.
    for (
      const moved of [
        { endpoint: "http://127.0.0.1:9100" },
        { region: "eu-west-1" },
        { bucket: "somewhere-else" },
      ]
    ) {
      const refused = await o.putOffsite(offsiteBody({ ...noKeys, ...moved }), {
        version: saved.version,
      });
      assertEquals(refused.status, 422, JSON.stringify(moved));
      const problem = await refused.json() as Problem;
      assertEquals(problem.issues?.[0].path, ["accessKeyId"]);
      assertEquals(problem.issues?.[0].code, "credentials_required");
      assertEquals(o.calls.length, 1, `${JSON.stringify(moved)} sent a test`);
      const after = await (await o.admin("GET", offsitePath)).json() as Offsite;
      assertEquals(after, saved, JSON.stringify(moved));
    }
    // One half is not the pair, move or not.
    const half = await o.putOffsite(
      offsiteBody({
        bucket: "somewhere-else",
        accessKeyId: "AKIAONLYHALF",
        secretAccessKey: undefined,
      }),
      { version: saved.version },
    );
    assertEquals(half.status, 400);
    assertEquals(o.calls.length, 1);
    // A folder in the same bucket is not a move: the stored pair is kept, and
    // the test object goes to the same host with it.
    const folder = await o.putOffsite(
      offsiteBody({ ...noKeys, prefix: "other/folder" }),
      { version: saved.version },
    );
    assertEquals(folder.status, 200, await folder.clone().text());
    assertEquals(o.calls.length, 2);
    assertEquals(o.calls[1].endpoint, o.calls[0].endpoint);
    assertEquals(o.calls[1].bucket, o.calls[0].bucket);
    assertEquals(o.calls[1].accessKeyId, accessKeyId);
    assertEquals(o.calls[1].secretAccessKey, secretAccessKey);
    // A move with both halves is tested with the NEW pair and only that.
    const next = await folder.json() as Offsite;
    const moved = await o.putOffsite(
      offsiteBody({
        endpoint: "http://127.0.0.1:9100",
        bucket: "somewhere-else",
        accessKeyId: "AKIANEWHOST",
        secretAccessKey: "new/host/secret",
      }),
      { version: next.version },
    );
    assertEquals(moved.status, 200, await moved.clone().text());
    assertEquals(o.calls.length, 3);
    assertEquals(o.calls[2].endpoint, "http://127.0.0.1:9100");
    assertEquals(o.calls[2].accessKeyId, "AKIANEWHOST");
    assertEquals(o.calls[2].secretAccessKey, "new/host/secret");
  } finally {
    await o.finish();
  }
});

Deno.test("sending a test reports a stable outcome and the destination's own answer", async () => {
  const o = await openBackupSettingsFixture();
  try {
    const unconfigured = await o.admin("POST", verificationPath, {}, {
      keyed: true,
    });
    assertEquals(unconfigured.status, 200, await unconfigured.clone().text());
    assertEquals(
      (await unconfigured.json() as Verification).outcome,
      "not_configured",
    );
    assertEquals(o.calls.length, 0);
    assertEquals((await o.putOffsite(offsiteBody())).status, 200);
    const verified = await o.admin("POST", verificationPath, {}, {
      keyed: true,
    });
    const verifiedBody = await verified.json() as Verification;
    assertEquals([verifiedBody.outcome, verifiedBody.detail], [
      "verified",
      null,
    ]);
    assertEquals(o.calls.at(-1)?.accessKeyId, accessKeyId);
    o.setProbe(() =>
      Promise.resolve({
        outcome: "destination_refused",
        detail: "NoSuchBucket: the bucket does not exist",
      })
    );
    const refused = await o.admin("POST", verificationPath, {}, {
      keyed: true,
    });
    // A failed test is still a 200 answer carrying the cause.
    assertEquals(refused.status, 200);
    const refusedBody = await refused.json() as Verification;
    assertEquals(refusedBody.outcome, "destination_refused");
    assertEquals(refusedBody.detail, "NoSuchBucket: the bucket does not exist");
    // Only the outcome word is audited, never the destination's answer text.
    const audit = await o.f.pgDatabase.query<
      { details: Record<string, unknown> }
    >(
      `select details from bakery.audit_events
        where operation = 'backupOffsite.verify' order by created_at desc limit 1`,
    );
    assertEquals(audit.rows[0].details, { outcome: "destination_refused" });
  } finally {
    await o.finish();
  }
});

Deno.test("the real client sends a test object to an S3-compatible receiver and keeps the key out of its answer", async () => {
  const receiver = startS3Receiver({ rejectKey: "AKIAREJECTEDKEY" });
  const o = await openBackupSettingsFixture({ realProbe: true });
  try {
    const good = await o.putOffsite(
      offsiteBody({ endpoint: receiver.endpoint, prefix: "bakery/prod" }),
    );
    assertEquals(good.status, 200, await good.clone().text());
    // The probe wrote, read and removed one object under <prefix>bakery-probe/.
    assert(
      receiver.requests.some((r) =>
        /^PUT \/bakery-backups\/bakery\/prod\/bakery-probe\//.test(r)
      ),
      receiver.requests.join("\n"),
    );
    assert(receiver.requests.some((r) => r.startsWith("GET ")));
    assert(receiver.requests.some((r) => r.startsWith("DELETE ")));
    assertEquals(receiver.objects.size, 0);
    const verified = await o.admin("POST", verificationPath, {}, {
      keyed: true,
    });
    assertEquals((await verified.json() as Verification).outcome, "verified");

    // A destination that answers 403 naming the key: refused, and the key is
    // not in the text the page would show.
    const refused = await o.putOffsite(
      offsiteBody({
        endpoint: receiver.endpoint,
        accessKeyId: "AKIAREJECTEDKEY",
        secretAccessKey: "rejected/secret/value",
      }),
      { version: 1 },
    );
    assertEquals(refused.status, 422, await refused.clone().text());
    const text = await refused.text();
    assert(text.includes("destination_refused"));
    assert(!text.includes("AKIAREJECTEDKEY"), text);
    assert(!text.includes("rejected/secret/value"), text);
    assert(text.includes("[redacted]"), text);
    // Nothing was stored by the refused save.
    assertEquals(
      (await (await o.admin("GET", offsitePath)).json() as Offsite).version,
      1,
    );
    // A receiver that is gone is "unreachable", not "refused".
    await receiver.stop();
    const unreachable = await o.admin("POST", verificationPath, {}, {
      keyed: true,
    });
    assertEquals(
      (await unreachable.json() as Verification).outcome,
      "destination_unreachable",
    );
  } finally {
    await receiver.stop().catch(() => {});
    await o.finish();
  }
});

Deno.test("only the runner credential reads the decrypted settings, and no session does", async () => {
  const o = await openBackupSettingsFixture();
  try {
    const credential = await o.issueCredential();
    const baseline = await runnerAuditCount(o);
    // Nothing saved: schedule defaults, no destination, no credentials.
    const empty = await o.runner(credential, "GET", runnerSettingsPath);
    assertEquals(empty.status, 200, await empty.clone().text());
    assertEquals(empty.headers.get("cache-control"), "no-store");
    const emptyBody = await empty.json() as Record<string, unknown>;
    assertEquals(emptyBody.scheduleEnabled, false);
    assertEquals(emptyBody.offsiteConfigured, false);
    assertEquals(emptyBody.offsiteSecretAccessKey, null);
    assertEquals(emptyBody.offsiteRefusal, null);
    assertEquals(emptyBody.offsiteVersion, 0);
    // A read that releases nothing writes no audit row.
    assertEquals(await runnerAuditCount(o), baseline);

    assertEquals((await o.putSchedule(schedule)).status, 200);
    assertEquals((await o.putOffsite(offsiteBody())).status, 200);
    const read = await o.runner(credential, "GET", runnerSettingsPath);
    assertEquals(read.status, 200, await read.clone().text());
    assertEquals(read.headers.get("cache-control"), "no-store");
    const body = await read.json() as Record<string, unknown>;
    assertEquals(body, {
      scheduleEnabled: true,
      scheduleInterval: "daily",
      scheduleTimeOfDayUtc: "03:00",
      daysToKeep: 30,
      scheduleVersion: 1,
      offsiteConfigured: true,
      offsiteEndpoint: "http://127.0.0.1:9000",
      offsiteRegion: "us-east-1",
      offsiteBucket: "bakery-backups",
      offsitePrefix: "prod/",
      offsiteAccessKeyId: accessKeyId,
      offsiteSecretAccessKey: secretAccessKey,
      offsiteRefusal: null,
      offsiteVersion: 1,
    });
    // No key material of the backups themselves is part of the answer.
    assert(!JSON.stringify(body).toLowerCase().includes("age1"));

    // A wrong credential, no credential, and a signed-in administrator or
    // developer are all refused: the route is not a session route.
    assertEquals(
      (await o.runner("wrong-credential", "GET", runnerSettingsPath)).status,
      403,
    );
    const anonymous = await o.f.app.fetch(
      new Request(`${authTestOrigin}${runnerSettingsPath}`),
    );
    assert([401, 403].includes(anonymous.status), String(anonymous.status));
    for (const cookie of [o.f.adminCookie, o.f.developerCookie]) {
      const session = await o.f.app.fetch(
        new Request(`${authTestOrigin}${runnerSettingsPath}`, {
          headers: { cookie, origin: authTestOrigin },
        }),
      );
      assert([401, 403].includes(session.status), String(session.status));
      assert(!(await session.text()).includes(secretAccessKey));
    }
    // Rotating the runner credential retires the old one.
    const rotated = await o.issueCredential();
    assertNotEquals(rotated, credential);
    assertEquals(
      (await o.runner(credential, "GET", runnerSettingsPath)).status,
      403,
    );
    assertEquals(
      (await o.runner(rotated, "GET", runnerSettingsPath)).status,
      200,
    );
  } finally {
    await o.finish();
  }
});

/** Claims as the runner and returns the answer. */
async function claim(o: BackupSettingsFixture, credential: string) {
  const response = await o.runner(
    credential,
    "POST",
    "/v1/backup-runner/claims",
    {},
  );
  assertEquals(response.status, 200, await response.clone().text());
  return await response.json() as {
    claimed: boolean;
    runId: string | null;
    leaseToken: string | null;
    triggerKind: string | null;
  };
}

const runCount = async (o: BackupSettingsFixture, where = "true") =>
  Number(
    (await o.f.pgDatabase.query<{ count: string }>(
      `select count(*) from bakery.backup_runs where ${where}`,
    )).rows[0].count,
  );

Deno.test("a claim records one scheduled backup when it is due, and none when it is not", async () => {
  const o = await openBackupSettingsFixture();
  try {
    const credential = await o.issueCredential();
    // No schedule: nothing to do, and no row is made up.
    assertEquals((await claim(o, credential)).claimed, false);
    assertEquals(await runCount(o), 0);
    // A schedule that is off does the same.
    assertEquals(
      (await o.putSchedule({ ...schedule, enabled: false })).status,
      200,
    );
    assertEquals((await claim(o, credential)).claimed, false);
    assertEquals(await runCount(o), 0);

    // Switched on with nothing requested since the latest slot: due at once, and
    // the claim hands that one scheduled run over.
    assertEquals(
      (await o.putSchedule(schedule, { version: 1 })).status,
      200,
    );
    const first = await claim(o, credential);
    assertEquals(first.claimed, true);
    assertEquals(first.triggerKind, "scheduled");
    assertEquals(await runCount(o, "trigger_kind = 'scheduled'"), 1);
    // The run is held: a second claim gets nothing and makes no second row.
    assertEquals((await claim(o, credential)).claimed, false);
    assertEquals(await runCount(o), 1);
    // Finish it; the slot is covered, so no further scheduled run appears.
    const done = await o.runner(
      credential,
      "POST",
      `/v1/backup-runner/runs/${first.runId}/reports`,
      {
        leaseToken: first.leaseToken,
        sequence: 1,
        status: "completed",
        sizeBytes: "1024",
        locations: ["server-host"],
      },
    );
    assertEquals(done.status, 200, await done.clone().text());
    assertEquals((await claim(o, credential)).claimed, false);
    assertEquals(await runCount(o), 1);

    // An older backup leaves the next slot due again.
    await o.f.pgDatabase.query(
      "update bakery.backup_runs set requested_at = now() - interval '3 days'",
    );
    const again = await claim(o, credential);
    assertEquals([again.claimed, again.triggerKind], [true, "scheduled"]);
    assertEquals(await runCount(o), 2);
  } finally {
    await o.finish();
  }
});

Deno.test("two claims racing for a due schedule make one scheduled backup between them", async () => {
  const o = await openBackupSettingsFixture();
  try {
    const credential = await o.issueCredential();
    assertEquals((await o.putSchedule(schedule)).status, 200);
    const answers = await Promise.all([
      claim(o, credential),
      claim(o, credential),
      claim(o, credential),
    ]);
    assertEquals(answers.filter((a) => a.claimed).length, 1);
    assertEquals(await runCount(o), 1);
    assertEquals(await runCount(o, "trigger_kind = 'scheduled'"), 1);
  } finally {
    await o.finish();
  }
});

Deno.test("a backup a person started covers the slot, so no scheduled one is added", async () => {
  const o = await openBackupSettingsFixture();
  try {
    const credential = await o.issueCredential();
    assertEquals((await o.putSchedule(schedule)).status, 200);
    const asked = await o.admin("POST", "/v1/installation/backups", {}, {
      keyed: true,
    });
    assertEquals(asked.status, 202, await asked.clone().text());
    const got = await claim(o, credential);
    assertEquals([got.claimed, got.triggerKind], [true, "manual"]);
    assertEquals(await runCount(o, "trigger_kind = 'scheduled'"), 0);
  } finally {
    await o.finish();
  }
});

Deno.test("the status goes stale at twice the schedule interval, or seven days without one", async () => {
  const o = await openBackupSettingsFixture();
  try {
    const status = async () =>
      (await (await o.admin("GET", "/v1/installation/backups/status"))
        .json() as {
          state: string;
        }).state;
    const completedAgo = async (interval: string) => {
      await o.f.pgDatabase.query("delete from bakery.backup_runs");
      await o.f.pgDatabase.query(
        `insert into bakery.backup_runs (trigger_kind, status, requested_at,
           finished_at, size_bytes, locations)
         values ('manual', 'completed', now() - $1::interval, now() - $1::interval,
           1, '{server-host}')`,
        [interval],
      );
    };
    // No schedule: three days old is fine, eight is stale.
    await completedAgo("3 days");
    assertEquals(await status(), "protected");
    await completedAgo("8 days");
    assertEquals(await status(), "stale");
    // A daily schedule makes two days the limit.
    assertEquals((await o.putSchedule(schedule)).status, 200);
    await completedAgo("47 hours");
    assertEquals(await status(), "protected");
    await completedAgo("3 days");
    assertEquals(await status(), "stale");
    // An hourly schedule makes two hours the limit.
    assertEquals(
      (await o.putSchedule({ ...schedule, interval: "hourly" }, { version: 1 }))
        .status,
      200,
    );
    await completedAgo("90 minutes");
    assertEquals(await status(), "protected");
    await completedAgo("3 hours");
    assertEquals(await status(), "stale");
  } finally {
    await o.finish();
  }
});

const named = `https://${namedHost}`;

Deno.test("a save is refused when the host resolves to an address the server may not dial", async () => {
  const o = await openBackupSettingsFixture();
  try {
    const refusal = async (body: Record<string, unknown>) => {
      const response = await o.putOffsite(body);
      assertEquals(response.status, 422, await response.clone().text());
      return (await problem(response)).issues?.[0];
    };
    // A private answer, a mixed answer, and the metadata address are all refused.
    for (
      const answer of [
        ["10.0.0.5"],
        [publicAddress, "10.0.0.5"],
        ["169.254.169.254"],
        ["fd00:ec2::254"],
        ["::ffff:192.168.1.1"],
        ["100.64.0.1"],
        ["127.0.0.1"],
      ]
    ) {
      o.setHost(namedHost, answer);
      const issue = await refusal(offsiteBody({ endpoint: named }));
      assertEquals(issue?.path, ["endpoint"], answer.join());
      assertEquals(issue?.code, "destination_private_address", answer.join());
    }
    // A literal private address gets the same word, with no lookup at all.
    const literal = await refusal(
      offsiteBody({ endpoint: "https://10.0.0.5" }),
    );
    assertEquals(literal?.code, "destination_private_address");
    // A name that cannot be resolved is "unreachable", not "private".
    o.setHost(namedHost, "unresolvable");
    assertEquals(
      (await refusal(offsiteBody({ endpoint: named })))?.code,
      "destination_unreachable",
    );
    // Nothing was called and nothing was stored by any refusal.
    assertEquals(o.calls.length, 0);
    assertEquals(await secretCount(o), 0);
    assertEquals(
      (await (await o.admin("GET", offsitePath)).json() as Offsite).version,
      0,
    );

    // A public answer is saved; the stored host is then held to the policy on
    // every later save, even one that changes nothing else.
    o.setHost(namedHost, [publicAddress]);
    const saved = await o.putOffsite(offsiteBody({ endpoint: named }));
    assertEquals(saved.status, 200, await saved.clone().text());
    o.setHost(namedHost, ["10.0.0.5"]);
    const again = await o.putOffsite(
      offsiteBody({
        endpoint: named,
        accessKeyId: undefined,
        secretAccessKey: undefined,
      }),
      { version: 1 },
    );
    assertEquals(again.status, 422, await again.clone().text());
    assertEquals(
      (await (await o.admin("GET", offsitePath)).json() as Offsite).version,
      1,
    );
    // The loopback fixture is still allowed in a test environment. Moving the
    // endpoint takes the key pair again, so the body carries it.
    o.setHost(namedHost, [publicAddress]);
    const fixture = await o.putOffsite(
      offsiteBody({ endpoint: "http://127.0.0.1:9000" }),
      { version: 1 },
    );
    assertEquals(fixture.status, 200, await fixture.clone().text());
  } finally {
    await o.finish();
  }
});

Deno.test("sending a test re-checks the saved host, and a re-pointed name is refused without a call", async () => {
  const o = await openBackupSettingsFixture();
  try {
    o.setHost(namedHost, [publicAddress]);
    assertEquals(
      (await o.putOffsite(offsiteBody({ endpoint: named }))).status,
      200,
    );
    const callsAfterSave = o.calls.length;
    const verify = async () =>
      await (await o.admin("POST", verificationPath, {}, { keyed: true }))
        .json() as Verification;
    assertEquals((await verify()).outcome, "verified");
    assertEquals(o.calls.length, callsAfterSave + 1);

    // Re-pointed at a private address, then a mixed answer: refused, no test sent.
    for (const answer of [["10.0.0.5"], [publicAddress, "169.254.169.254"]]) {
      o.setHost(namedHost, answer);
      const refused = await verify();
      assertEquals(refused.outcome, "destination_private_address");
      assert(refused.detail?.includes("may not connect"));
    }
    // A name that stopped resolving is unreachable.
    o.setHost(namedHost, "unresolvable");
    assertEquals((await verify()).outcome, "destination_unreachable");
    assertEquals(o.calls.length, callsAfterSave + 1);
    // Back to a public answer: the test goes through again.
    o.setHost(namedHost, [publicAddress]);
    assertEquals((await verify()).outcome, "verified");
    assertEquals(o.calls.length, callsAfterSave + 2);
  } finally {
    await o.finish();
  }
});

Deno.test("the runner is not given the credentials once the saved name is re-pointed, and every release or refusal is audited", async () => {
  const o = await openBackupSettingsFixture();
  try {
    const credential = await o.issueCredential();
    const baseline = await runnerAuditCount(o);
    const mine = async () => (await runnerAudit(o)).slice(baseline);
    const read = async () => {
      const response = await o.runner(credential, "GET", runnerSettingsPath);
      assertEquals(response.status, 200, await response.clone().text());
      return await response.json() as Record<string, unknown>;
    };
    // Nothing saved: nothing released, no audit row.
    assertEquals((await read()).offsiteConfigured, false);
    assertEquals((await mine()).length, 0);

    o.setHost(namedHost, [publicAddress]);
    assertEquals(
      (await o.putOffsite(offsiteBody({ endpoint: named }))).status,
      200,
    );
    // Released: one audit row, with no principal and no key of any kind.
    const released = await read();
    assertEquals(released.offsiteAccessKeyId, accessKeyId);
    assertEquals(released.offsiteSecretAccessKey, secretAccessKey);
    assertEquals(released.offsiteRefusal, null);
    let rows = await mine();
    assertEquals(rows.length, 1);
    assertEquals(rows[0].principal_id, null);
    assertEquals(rows[0].resource_type, "backup_runner_credential");
    assertEquals(rows[0].resource_id, "backup-runner");
    assertEquals(rows[0].outcome, "succeeded");
    assertEquals(rows[0].details, {
      released: true,
      generation: 1,
      bucket: "bakery-backups",
      region: "us-east-1",
      endpointHost: namedHost,
      credentialRevision: 1,
    });

    // Re-pointed at private addresses: the pair is withheld, the destination
    // still reads as configured, the refusal is named, and each read is one row.
    const withheld = async (
      answer: readonly string[] | "unresolvable",
      endpoint = named,
    ) => {
      o.setHost(namedHost, answer);
      const body = await read();
      assertEquals(body.offsiteConfigured, true);
      assertEquals(body.offsiteAccessKeyId, null);
      assertEquals(body.offsiteSecretAccessKey, null);
      assertEquals(body.offsiteEndpoint, endpoint);
      assertEquals(body.offsiteBucket, "bakery-backups");
      return body.offsiteRefusal;
    };
    assertEquals(await withheld(["10.0.0.5"]), "destination_private_address");
    assertEquals(
      await withheld([publicAddress, "169.254.169.254"]),
      "destination_private_address",
    );
    assertEquals(
      await withheld(["fd00:ec2::254"]),
      "destination_private_address",
    );
    assertEquals(await withheld("unresolvable"), "destination_unresolvable");
    rows = await mine();
    assertEquals(rows.length, 5);
    assertEquals(rows.slice(1).map((r) => r.details.released), [
      false,
      false,
      false,
      false,
    ]);
    assertEquals(
      rows.slice(1).map((r) => r.details.refusal),
      [
        "destination_private_address",
        "destination_private_address",
        "destination_private_address",
        "destination_unresolvable",
      ],
    );

    // Back to a public answer: released again.
    o.setHost(namedHost, [publicAddress]);
    const back = await read();
    assertEquals(back.offsiteSecretAccessKey, secretAccessKey);
    assertEquals((await mine()).length, 6);

    // A saved destination that is no longer a valid one is withheld as invalid.
    await o.f.pgDatabase.query(
      "update bakery.backup_offsite_settings set endpoint = 'ftp://nowhere'",
    );
    assertEquals(
      await withheld([publicAddress], "ftp://nowhere"),
      "destination_invalid",
    );
    assertEquals((await mine()).length, 7);

    // No row and no log line of any read holds a key.
    const text = JSON.stringify(await mine());
    assert(!text.includes(accessKeyId) && !text.includes(secretAccessKey));
  } finally {
    await o.finish();
  }
});

Deno.test("the loopback fixture is released to the runner in a test environment, and no other private address is", async () => {
  const o = await openBackupSettingsFixture();
  try {
    const credential = await o.issueCredential();
    assertEquals((await o.putOffsite(offsiteBody())).status, 200);
    const read = async () =>
      await (await o.runner(credential, "GET", runnerSettingsPath)).json() as {
        offsiteSecretAccessKey: string | null;
        offsiteRefusal: string | null;
      };
    const fixture = await read();
    assertEquals(fixture.offsiteSecretAccessKey, secretAccessKey);
    assertEquals(fixture.offsiteRefusal, null);
    // The same row pointed at a private (non-loopback) literal is withheld.
    await o.f.pgDatabase.query(
      "update bakery.backup_offsite_settings set endpoint = 'http://10.0.0.5:9000'",
    );
    const privateRead = await read();
    assertEquals(privateRead.offsiteSecretAccessKey, null);
    // http to a non-test host is not a valid destination at all.
    assert(
      ["destination_private_address", "destination_invalid"].includes(
        privateRead.offsiteRefusal ?? "",
      ),
      String(privateRead.offsiteRefusal),
    );
  } finally {
    await o.finish();
  }
});

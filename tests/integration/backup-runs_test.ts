import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  call,
  openInstallationFixture,
} from "../helpers/installation-settings.ts";
import { authTestOrigin } from "../helpers/auth.ts";

/**
 * #80 slice S1a: backup requests, the runner credential, the claim with its
 * lease and the report sequence, over the real routes and a real Postgres. The
 * runner is simulated with plain requests that carry only the runner credential.
 */

type Run = {
  id: string;
  status: string;
  triggerKind: string;
  progressPercent: number | null;
  sizeBytes: string | null;
  locations: string[];
  failureCode: string | null;
  failureDetail: string | null;
  leaseExpiresAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
};
type Problem = { code: string; reason?: string };

const key = () => ({ "Idempotency-Key": crypto.randomUUID() });

async function open() {
  const f = await openInstallationFixture(true);
  // A backup row belongs to the installation, not to a fixture email.
  await f.pgDatabase.query("delete from bakery.backup_runs");
  await f.pgDatabase.query("delete from bakery.backup_runner_credentials");
  const admin = (method: string, path: string, body?: unknown, keyed = false) =>
    call(f, method, path, f.adminCookie, {
      body,
      headers: keyed ? key() : undefined,
    });
  const start = async () => {
    const response = await admin("POST", "/v1/installation/backups", {}, true);
    assertEquals(response.status, 202, await response.clone().text());
    return await response.json() as Run;
  };
  const issue = async () => {
    const response = await admin(
      "POST",
      "/v1/installation/backup-runner/credential",
      {},
    );
    assertEquals(response.status, 201, await response.clone().text());
    return await response.json() as {
      credential: string;
      generation: number;
      issuedAt: string;
    };
  };
  const runner = (
    credential: string,
    method: string,
    path: string,
    body?: unknown,
  ) =>
    f.app.fetch(
      new Request(`${authTestOrigin}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${credential}`,
          "content-type": "application/json",
          origin: authTestOrigin,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  const claim = async (credential: string) => {
    const response = await runner(
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
      leaseExpiresAt: string | null;
    };
  };
  const report = (
    credential: string,
    runId: string,
    leaseToken: string,
    body: Record<string, unknown>,
  ) =>
    runner(credential, "POST", `/v1/backup-runner/runs/${runId}/reports`, {
      leaseToken,
      ...body,
    });
  const status = async () => {
    const response = await admin("GET", "/v1/installation/backups/status");
    assertEquals(response.status, 200, await response.clone().text());
    return await response.json() as {
      state: string;
      lastGoodBackupAt: string | null;
      runningRunId: string | null;
      waitingRunId: string | null;
      runnerConfigured: boolean;
      runnerLastUsedAt: string | null;
    };
  };
  return {
    f,
    admin,
    start,
    issue,
    runner,
    claim,
    report,
    status,
    finish: async () => {
      await f.pgDatabase.query("delete from bakery.backup_runs");
      await f.pgDatabase.query("delete from bakery.backup_runner_credentials");
      await f.finish();
    },
  };
}

const problem = async (response: Response) => await response.json() as Problem;

Deno.test("asking for a backup queues one request, and only an installation administrator may ask", async () => {
  const o = await open();
  try {
    const refused = await call(
      o.f,
      "POST",
      "/v1/installation/backups",
      o.f.developerCookie,
      { body: {}, headers: key() },
    );
    assertEquals(refused.status, 403);
    assertEquals((await problem(refused)).code, "AUTH_FORBIDDEN");
    for (
      const path of [
        "/v1/installation/backups",
        "/v1/installation/backups/status",
      ]
    ) {
      const read = await call(o.f, "GET", path, o.f.developerCookie);
      assertEquals(read.status, 403, path);
    }

    const first = await o.start();
    assertEquals(first.status, "requested");
    assertEquals(first.triggerKind, "manual");
    // A second ask while one waits returns that request, not another.
    const second = await o.start();
    assertEquals(second.id, first.id);
    assertEquals(
      (await o.f.pgDatabase.query("select 1 from bakery.backup_runs")).rowCount,
      1,
    );
    assertEquals((await o.status()).waitingRunId, first.id);

    // The same key replays the stored answer.
    const keyed = { "Idempotency-Key": crypto.randomUUID() };
    const a = await call(
      o.f,
      "POST",
      "/v1/installation/backups",
      o.f.adminCookie,
      {
        body: {},
        headers: keyed,
      },
    );
    const b = await call(
      o.f,
      "POST",
      "/v1/installation/backups",
      o.f.adminCookie,
      {
        body: {},
        headers: keyed,
      },
    );
    assertEquals(b.headers.get("Idempotent-Replayed"), "true");
    assertEquals((await a.json() as Run).id, (await b.json() as Run).id);
  } finally {
    await o.finish();
  }
});

Deno.test("the list is newest first, keyset paged, and never shows a lease", async () => {
  const o = await open();
  try {
    for (let minute = 0; minute < 5; minute++) {
      await o.f.pgDatabase.query(
        `insert into bakery.backup_runs
           (trigger_kind, status, requested_at, finished_at, size_bytes, locations,
            lease_token_hash, lease_expires_at)
         values ('manual', 'completed', now() - make_interval(mins => $1),
                 now() - make_interval(mins => $1), 100, '{server-host}',
                 'secrethash', null)`,
        [minute + 1],
      );
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = `limit=2${cursor ? `&cursor=${cursor}` : ""}`;
      const response = await o.admin(
        "GET",
        `/v1/installation/backups?${query}`,
      );
      assertEquals(response.status, 200, await response.clone().text());
      const text = await response.text();
      assert(!text.includes("secrethash"), "no lease hash in the list");
      const page = JSON.parse(text) as {
        items: Run[];
        nextCursor: string | null;
      };
      assert(page.items.length <= 2);
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
      pages++;
    } while (cursor !== null && pages < 10);
    assertEquals(pages, 3);
    assertEquals(new Set(seen).size, 5);
    const ordered = await o.f.pgDatabase.query<{ id: string }>(
      "select id from bakery.backup_runs order by requested_at desc, id desc",
    );
    assertEquals(seen, ordered.rows.map((row) => row.id));
  } finally {
    await o.finish();
  }
});

Deno.test("the runner credential is shown once, rotates, and only its hash is stored", async () => {
  const o = await open();
  try {
    assertEquals((await o.status()).runnerConfigured, false);
    const nobody = await o.runner(
      "not-a-credential",
      "POST",
      "/v1/backup-runner/claims",
      {},
    );
    assertEquals(nobody.status, 403);
    const first = await o.issue();
    assertEquals(first.generation, 1);
    assert(first.credential.length >= 32);
    const stored = await o.f.pgDatabase.query<{ token_hash: string }>(
      "select token_hash from bakery.backup_runner_credentials",
    );
    assertEquals(stored.rows.length, 1);
    assertNotEquals(stored.rows[0].token_hash, first.credential);
    assertEquals(stored.rows[0].token_hash.length, 64);

    const before = await o.status();
    assertEquals(before.runnerConfigured, true);
    assertEquals(before.runnerLastUsedAt, null);
    assertEquals((await o.claim(first.credential)).claimed, false);
    assertNotEquals((await o.status()).runnerLastUsedAt, null);

    const second = await o.issue();
    assertEquals(second.generation, 2);
    assertNotEquals(second.credential, first.credential);
    const old = await o.runner(
      first.credential,
      "POST",
      "/v1/backup-runner/claims",
      {},
    );
    assertEquals(old.status, 403);
    assertEquals((await o.claim(second.credential)).claimed, false);

    // Nothing later returns the secret.
    for (
      const path of [
        "/v1/installation/backups",
        "/v1/installation/backups/status",
      ]
    ) {
      const text = await (await o.admin("GET", path)).text();
      assert(!text.includes(second.credential), path);
    }
  } finally {
    await o.finish();
  }
});

Deno.test("a claim holds one run with a lease; a live lease blocks a second claim; a lapsed one is taken over", async () => {
  const o = await open();
  try {
    const { credential } = await o.issue();
    assertEquals((await o.claim(credential)).claimed, false);
    const run = await o.start();
    const claimed = await o.claim(credential);
    assertEquals(claimed.claimed, true);
    assertEquals(claimed.runId, run.id);
    assert(claimed.leaseToken && claimed.leaseToken.length >= 32);
    const row = await o.f.pgDatabase.query<
      { status: string; lease_token_hash: string }
    >("select status, lease_token_hash from bakery.backup_runs where id = $1", [
      run.id,
    ]);
    assertEquals(row.rows[0].status, "claimed");
    assertNotEquals(row.rows[0].lease_token_hash, claimed.leaseToken);

    // Asking again queues exactly one more; the live lease blocks any claim.
    const queued = await o.start();
    assertNotEquals(queued.id, run.id);
    assertEquals((await o.start()).id, queued.id);
    assertEquals((await o.claim(credential)).claimed, false);
    const status = await o.status();
    assertEquals(status.state, "running");
    assertEquals(status.runningRunId, run.id);
    assertEquals(status.waitingRunId, queued.id);

    // The runner vanishes: the lease lapses and the run is taken over.
    await o.f.pgDatabase.query(
      "update bakery.backup_runs set lease_expires_at = now() - interval '1 second' where id = $1",
      [run.id],
    );
    assertEquals((await o.status()).state, "failed");
    const again = await o.claim(credential);
    assertEquals(again.claimed, true);
    assertEquals(again.runId, run.id);
    assertNotEquals(again.leaseToken, claimed.leaseToken);
    // The old holder's late report is refused: its token no longer matches.
    const late = await o.report(credential, run.id, claimed.leaseToken!, {
      sequence: 1,
      status: "running",
      progressPercent: 5,
    });
    assertEquals(late.status, 403);
  } finally {
    await o.finish();
  }
});

Deno.test("reports apply in sequence, replay exactly, and refuse gaps and changed bodies", async () => {
  const o = await open();
  try {
    const { credential } = await o.issue();
    const run = await o.start();
    const claimed = await o.claim(credential);
    const token = claimed.leaseToken!;
    const send = (body: Record<string, unknown>) =>
      o.report(credential, run.id, token, body);

    const one = await send({
      sequence: 1,
      status: "running",
      progressPercent: 10,
    });
    assertEquals(one.status, 200, await one.clone().text());
    const afterOne = await one.json() as Run;
    assertEquals(afterOne.status, "running");
    assertEquals(afterOne.progressPercent, 10);
    assert(afterOne.startedAt !== null);

    // The same sequence and body: answered from the row, nothing applied twice.
    const replay = await send({
      sequence: 1,
      status: "running",
      progressPercent: 10,
    });
    assertEquals(replay.status, 200);
    assertEquals((await replay.json() as Run).startedAt, afterOne.startedAt);
    const changed = await send({
      sequence: 1,
      status: "running",
      progressPercent: 11,
    });
    assertEquals(changed.status, 422);
    assertEquals((await problem(changed)).code, "IDEMPOTENCY_PAYLOAD_MISMATCH");

    const gap = await send({
      sequence: 3,
      status: "running",
      progressPercent: 50,
    });
    assertEquals(gap.status, 409);
    assertEquals((await problem(gap)).reason, "sequence_gap");
    const back = await send({
      sequence: 2,
      status: "running",
      progressPercent: 5,
    });
    assertEquals(back.status, 422);

    const incomplete = await send({ sequence: 2, status: "completed" });
    assertEquals(incomplete.status, 422);
    const done = await send({
      sequence: 2,
      status: "completed",
      sizeBytes: "52428800",
      locations: ["server-host"],
    });
    assertEquals(done.status, 200, await done.clone().text());
    const finished = await done.json() as Run;
    assertEquals(finished.status, "completed");
    assertEquals(finished.sizeBytes, "52428800");
    assertEquals(finished.locations, ["server-host"]);
    assertEquals(finished.progressPercent, 100);
    assert(finished.finishedAt !== null);

    // The final answer can be asked for again; nothing new is accepted.
    const again = await send({
      sequence: 2,
      status: "completed",
      sizeBytes: "52428800",
      locations: ["server-host"],
    });
    assertEquals(again.status, 200);
    const late = await send({
      sequence: 3,
      status: "running",
      progressPercent: 100,
    });
    assertEquals(late.status, 409);
    assertEquals((await problem(late)).reason, "run_finished");

    const status = await o.status();
    assertEquals(status.state, "protected");
    assertNotEquals(status.lastGoodBackupAt, null);
    assertEquals(status.runningRunId, null);
  } finally {
    await o.finish();
  }
});

Deno.test("a failed report keeps the cause and makes the installation not protected", async () => {
  const o = await open();
  try {
    const { credential } = await o.issue();
    const run = await o.start();
    const claimed = await o.claim(credential);
    const wrong = await o.report(credential, run.id, "x".repeat(43), {
      sequence: 1,
      status: "failed",
      failureCode: "disk_full",
    });
    assertEquals(wrong.status, 403);
    const missing = await o.report(
      credential,
      crypto.randomUUID(),
      claimed.leaseToken!,
      { sequence: 1, status: "failed", failureCode: "disk_full" },
    );
    assertEquals(missing.status, 404);
    const failed = await o.report(credential, run.id, claimed.leaseToken!, {
      sequence: 1,
      status: "failed",
      failureCode: "destination_refused",
      failureDetail: "AccessDenied: the bucket policy refused the write",
    });
    assertEquals(failed.status, 200, await failed.clone().text());
    const body = await failed.json() as Run;
    assertEquals(body.status, "failed");
    assertEquals(body.failureCode, "destination_refused");
    assertEquals(
      body.failureDetail,
      "AccessDenied: the bucket policy refused the write",
    );
    assertEquals((await o.status()).state, "failed");
  } finally {
    await o.finish();
  }
});

Deno.test("two runners claiming at once get one run, and two asks queue one request", async () => {
  const o = await open();
  try {
    const { credential } = await o.issue();
    const asks = await Promise.all([o.start(), o.start(), o.start()]);
    assertEquals(new Set(asks.map((run) => run.id)).size, 1);
    const claims = await Promise.all([
      o.claim(credential),
      o.claim(credential),
      o.claim(credential),
    ]);
    assertEquals(claims.filter((claim) => claim.claimed).length, 1);
    const active = await o.f.pgDatabase.query(
      "select 1 from bakery.backup_runs where status in ('claimed','running')",
    );
    assertEquals(active.rowCount, 1);
  } finally {
    await o.finish();
  }
});

Deno.test("the database itself refuses a second active or a second waiting run", async () => {
  const o = await open();
  try {
    await o.f.pgDatabase.query(
      "insert into bakery.backup_runs (trigger_kind, status) values ('manual', 'running')",
    );
    let refused = false;
    try {
      await o.f.pgDatabase.query(
        "insert into bakery.backup_runs (trigger_kind, status) values ('manual', 'claimed')",
      );
    } catch {
      refused = true;
    }
    assert(refused, "a second active run must violate the unique index");
    await o.f.pgDatabase.query(
      "insert into bakery.backup_runs (trigger_kind, status) values ('manual', 'requested')",
    );
    refused = false;
    try {
      await o.f.pgDatabase.query(
        "insert into bakery.backup_runs (trigger_kind, status) values ('manual', 'requested')",
      );
    } catch {
      refused = true;
    }
    assert(refused, "a second waiting run must violate the unique index");
  } finally {
    await o.finish();
  }
});

Deno.test("a completed report may name why the off-site copy failed: accepted, shown as not_copied, replayed exactly, and superseded by a later full backup", async () => {
  const o = await open();
  try {
    const { credential } = await o.issue();
    const first = await o.start();
    const claimed = await o.claim(credential);
    const token = claimed.leaseToken!;
    const send = (id: string, lease: string, body: Record<string, unknown>) =>
      o.report(credential, id, lease, body);
    assertEquals(
      (await send(first.id, token, {
        sequence: 1,
        status: "running",
        progressPercent: 60,
      })).status,
      200,
    );
    // Taken on the host; the off-site copy then failed.
    const notCopied = {
      sequence: 2,
      status: "completed",
      sizeBytes: "2048",
      locations: ["server-host"],
      failureCode: "destination_unreachable",
      failureDetail: "connect ECONNREFUSED 203.0.113.9:443",
    };
    const done = await send(first.id, token, notCopied);
    assertEquals(done.status, 200, await done.clone().text());
    const run = await done.json() as Run;
    assertEquals(run.status, "completed");
    assertEquals(run.locations, ["server-host"]);
    assertEquals(run.sizeBytes, "2048");
    assertEquals(run.failureCode, "destination_unreachable");
    assertEquals(run.failureDetail, "connect ECONNREFUSED 203.0.113.9:443");
    assert(run.finishedAt !== null);

    // Its own state, and the local copy counts as a backup taken.
    const status = await o.status();
    assertEquals(status.state, "not_copied");
    assert(status.lastGoodBackupAt !== null);

    // The same report again is answered from the row, byte for byte.
    const replay = await send(first.id, token, notCopied);
    assertEquals(replay.status, 200);
    assertEquals(await replay.json(), run);
    // A changed cause on the same sequence is a different request.
    const changed = await send(first.id, token, {
      ...notCopied,
      failureCode: "destination_refused",
    });
    assertEquals(changed.status, 422);
    assertEquals((await problem(changed)).code, "IDEMPOTENCY_PAYLOAD_MISMATCH");
    assertEquals((await o.status()).state, "not_copied");

    // The shape rules: each of these is refused before anything is stored.
    const second = await o.start();
    const claimedAgain = await o.claim(credential);
    assertEquals(claimedAgain.runId, second.id);
    const lease = claimedAgain.leaseToken!;
    const refused: Record<string, unknown>[] = [
      // copied off-site AND failed to copy
      {
        sequence: 1,
        status: "completed",
        sizeBytes: "1",
        locations: ["server-host", "off-site"],
        failureCode: "destination_refused",
      },
      // a cause that is not about the off-site copy ends the run as failed
      {
        sequence: 1,
        status: "completed",
        sizeBytes: "1",
        locations: ["server-host"],
        failureCode: "disk_full",
      },
      // a detail with no cause
      {
        sequence: 1,
        status: "completed",
        sizeBytes: "1",
        locations: ["server-host"],
        failureDetail: "words only",
      },
      // a failed report still carries no size or locations
      {
        sequence: 1,
        status: "failed",
        failureCode: "destination_refused",
        sizeBytes: "1",
        locations: ["server-host"],
      },
    ];
    for (const body of refused) {
      const response = await send(second.id, lease, body);
      assertEquals(response.status, 422, JSON.stringify(body));
    }
    // Nothing was stored: the run is still claimed and the status still amber.
    assertEquals((await o.status()).state, "running");

    // A later good FULL backup supersedes the amber state.
    assertEquals(
      (await send(second.id, lease, {
        sequence: 1,
        status: "completed",
        sizeBytes: "4096",
        locations: ["server-host", "off-site"],
      })).status,
      200,
    );
    assertEquals((await o.status()).state, "protected");
    const list = await o.admin("GET", "/v1/installation/backups");
    const items = (await list.json() as { items: Run[] }).items;
    assertEquals(items.map((item) => item.failureCode), [
      null,
      "destination_unreachable",
    ]);
  } finally {
    await o.finish();
  }
});

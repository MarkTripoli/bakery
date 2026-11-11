import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
} from "@std/assert";
import type { Inngest } from "inngest";
import { authTestOrigin } from "../auth.ts";
import {
  count,
  type GitHubAppFixture,
  started,
} from "../github-app-registration.ts";
import {
  buildGitHubAppManifest,
  GITHUB_APP_DEFAULT_EVENTS,
} from "../../../apps/server/src/modules/integrations/github-app.ts";
import { RECEIPT_RETENTION_DAYS } from "../../../apps/server/src/modules/integrations/intake-receipts.ts";
import {
  createIntegrationIntakeRetention,
  RECEIPT_SWEEP_BATCH,
  RECEIPT_SWEEP_BATCH_CEILING,
  RECEIPT_SWEEP_BATCHES_CEILING,
  RECEIPT_SWEEP_MAX_BATCHES,
  sweepExpiredReceipts,
} from "../../../apps/server/src/modules/integrations/intake-retention.ts";
import { failingQuery, settlesWithin } from "./faults.ts";
import {
  checkRunPayload,
  checkSuitePayload,
  enabledReceiver,
  installationPayload,
  instrumentedDatabase,
  issuesPayload,
  pullRequestPayload,
  receipt,
  receiptRow,
  receiptRows,
  type Receiver,
  routeRows,
  SHA_A,
  sharedSecondConnection,
  withFixture,
} from "./receipts-shared.ts";

/**
 * Issue 71 retention and manifest: receipts expire seven days after arrival
 * and the sweep removes them with their routes, in batches, without touching
 * a live receipt; a redelivery after the sweep is a new receipt; and a new
 * App registers with the hook on and the five repository events.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Sends `total` issue deliveries, numbered from `first`, and returns their receipts. */
async function deliver(
  r: Receiver,
  total: number,
  first: number,
): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < total; index++) {
    const sent = await receipt(r, {
      event: "issues",
      payload: issuesPayload(r, first + index, "opened"),
    });
    assertEquals(sent.status, "accepted");
    ids.push(sent.eventId);
  }
  return ids;
}

/**
 * Moves the named receipts' arrival and expiry into the past. Their routes
 * are marked `completed`, as a processor that ran long ago would have left
 * them, unless `routes` is `"as-is"`: a receipt whose route has work to do is
 * not deleted, and the tests of that rule set the route states themselves.
 */
async function expire(
  f: GitHubAppFixture,
  eventIds: string[],
  routes: "completed" | "as-is" = "completed",
): Promise<void> {
  const moved = await f.pgDatabase.query(
    `update bakery.inbound_events
        set received_at = now() - interval '8 days',
            expires_at = now() - interval '1 second'
      where id = any($1::uuid[])`,
    [eventIds],
  );
  assertEquals(moved.rowCount, eventIds.length);
  if (routes === "completed") {
    await f.pgDatabase.query(
      `update bakery.inbound_event_routes
          set status = 'completed', outcome_code = 'fact_written'
        where inbound_event_id = any($1::uuid[])`,
      [eventIds],
    );
  }
}

/** Receipt ids that exist, sorted. */
async function receiptIds(f: GitHubAppFixture): Promise<string[]> {
  return (await receiptRows(f)).map(({ id }) => id).sort();
}

/** The named receipts and their routes as text, to prove a sweep left them byte-identical. */
async function textOf(
  f: GitHubAppFixture,
  eventIds: string[],
): Promise<string> {
  const result = await f.pgDatabase.query<{ text: string }>(
    `select concat_ws('|',
       (select coalesce(string_agg(e::text, ',' order by e.id), '')
          from bakery.inbound_events e where e.id = any($1::uuid[])),
       (select coalesce(string_agg(r::text, ',' order by r.id), '')
          from bakery.inbound_event_routes r
         where r.inbound_event_id = any($1::uuid[]))) as text`,
    [eventIds],
  );
  return result.rows[0].text;
}

async function routesOf(
  f: GitHubAppFixture,
  eventIds: string[],
): Promise<number> {
  return (await routeRows(f)).filter(({ inbound_event_id }) =>
    eventIds.includes(inbound_event_id)
  ).length;
}

Deno.test("issue 71 retention: the sweep deletes expired receipts and their routes in batches and leaves live ones untouched", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    const live = await deliver(r, 3, 100);
    const old = await deliver(r, 6, 200);
    // Their routes have ended, so only the expiry time keeps the live
    // receipts: a receipt with a route that has work is kept for that reason.
    for (const id of live) await setRouteStatus(f, id, "completed");
    // One receipt a minute short of its expiry is still live.
    await f.pgDatabase.query(
      `update bakery.inbound_events
          set expires_at = now() + interval '1 minute' where id = $1`,
      [live[0]],
    );
    await expire(f, old);
    const liveText = await textOf(f, live);
    assertEquals((await receiptRows(f)).length, 9);
    assertEquals((await routeRows(f)).length, 9);

    // The application role does the sweep, so its delete grant is exercised.
    // Six expired receipts in batches of three end on a full batch, so a third
    // statement runs and must find nothing: the receipt a minute short of its
    // expiry is next in the order and is not deleted.
    const swept = await sweepExpiredReceipts(f.runtimePgDatabase!, 3);
    assertEquals(swept, { deleted: 6, batches: 2 });
    assertEquals(await receiptIds(f), [...live].sort());
    assertEquals(
      await routesOf(f, old),
      0,
      "the routes went with the receipts",
    );
    assertEquals((await routeRows(f)).length, 3);
    assertEquals(
      await textOf(f, live),
      liveText,
      "a live receipt and its route are byte-identical",
    );
    assertEquals(
      await sweepExpiredReceipts(f.runtimePgDatabase!, 3),
      { deleted: 0, batches: 0 },
      "nothing is left to delete",
    );
  });
});

Deno.test("issue 71 retention: a run stops at a short batch, continues after a full one and stops at its batch cap", async () => {
  assertEquals(RECEIPT_SWEEP_BATCH, 500);
  assertEquals(RECEIPT_SWEEP_MAX_BATCHES, 100);
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    const [kept] = await deliver(r, 1, 300);

    // Four expired receipts in batches of two: the second batch is full, so a
    // third statement runs, finds nothing and ends the run.
    const four = await deliver(r, 4, 310);
    await expire(f, four);
    const full = instrumentedDatabase(f.runtimePgDatabase!);
    assertEquals(
      await sweepExpiredReceipts(full.database, 2),
      { deleted: 4, batches: 2 },
    );
    assertEquals(deleteStatements(full.state.queries), 3);
    assertEquals(await receiptIds(f), [kept]);

    // Three expired receipts and room for ten: the batch is short, so it is
    // the only statement.
    const three = await deliver(r, 3, 315);
    await expire(f, three);
    const short = instrumentedDatabase(f.runtimePgDatabase!);
    assertEquals(
      await sweepExpiredReceipts(short.database, 10),
      { deleted: 3, batches: 1 },
    );
    assertEquals(deleteStatements(short.state.queries), 1);
    assertEquals(await receiptIds(f), [kept]);

    // Five expired receipts, one per batch, two batches per run.
    const five = await deliver(r, 5, 320);
    await expire(f, five);
    assertEquals(
      await sweepExpiredReceipts(f.runtimePgDatabase!, 1, 2),
      { deleted: 2, batches: 2 },
    );
    assertEquals((await receiptRows(f)).length, 4, "three are left to expire");
    assertEquals(
      await sweepExpiredReceipts(f.runtimePgDatabase!, 1, 10),
      { deleted: 3, batches: 3 },
      "the next run takes the rest",
    );
    assertEquals(await receiptIds(f), [kept]);

    // A limit or batch count that is not a whole number inside its bounds
    // deletes nothing, so a run is always finite.
    const [expired] = await deliver(r, 1, 330);
    await expire(f, [expired]);
    assertEquals(RECEIPT_SWEEP_BATCH_CEILING, 5_000);
    assertEquals(RECEIPT_SWEEP_BATCHES_CEILING, 1_000);
    const unbounded = [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER,
    ];
    for (const limit of [...unbounded, RECEIPT_SWEEP_BATCH_CEILING + 1]) {
      await assertRejects(
        () => sweepExpiredReceipts(f.runtimePgDatabase!, limit),
        Error,
        "INTEGRATION_INTAKE_RETENTION_LIMIT_INVALID",
        `limit ${limit}`,
      );
    }
    for (const batches of [...unbounded, RECEIPT_SWEEP_BATCHES_CEILING + 1]) {
      await assertRejects(
        () => sweepExpiredReceipts(f.runtimePgDatabase!, 10, batches),
        Error,
        "INTEGRATION_INTAKE_RETENTION_BATCHES_INVALID",
        `batches ${batches}`,
      );
    }
    assertEquals((await receiptRows(f)).length, 2, "refusals delete nothing");
    // The ceilings themselves are allowed.
    assertEquals(
      await sweepExpiredReceipts(
        f.runtimePgDatabase!,
        RECEIPT_SWEEP_BATCH_CEILING,
        RECEIPT_SWEEP_BATCHES_CEILING,
      ),
      { deleted: 1, batches: 1 },
    );
    assertEquals(await receiptIds(f), [kept]);
  });
});

/**
 * How long a sweep may take to skip a locked receipt. A sweep that waits for
 * the lock instead never ends while the locking transaction is open, so the
 * test gives it this deadline and fails at it rather than hang the lane. A
 * skipping sweep takes milliseconds.
 */
const LOCK_SKIP_DEADLINE_MS = 5_000;

Deno.test("issue 71 retention: a receipt locked by another transaction is skipped and swept by the next run", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    const [first, second, third] = await deliver(r, 3, 400);
    await expire(f, [first, second, third]);
    const lock = await f.runtimePgDatabase!.connect();
    let sweep: Promise<unknown> | undefined;
    try {
      await lock.query("begin");
      await lock.query(
        "select id from bakery.inbound_events where id = $1 for update",
        [first],
      );
      const running = sweepExpiredReceipts(f.runtimePgDatabase!, 10);
      sweep = running;
      const outcome = await settlesWithin(LOCK_SKIP_DEADLINE_MS, running);
      assert(
        outcome !== "waited",
        `the sweep waited more than ${LOCK_SKIP_DEADLINE_MS} ms for a locked receipt instead of skipping it`,
      );
      assertEquals(
        outcome.value,
        { deleted: 2, batches: 1 },
        "the locked receipt is skipped, not waited for",
      );
      assertEquals(await receiptIds(f), [first]);
      assertEquals(await routesOf(f, [first]), 1);
    } finally {
      await lock.query("rollback");
      lock.release();
      // A sweep that was still waiting ends once the lock is gone, so nothing
      // it started outlives the test.
      await sweep?.catch(() => undefined);
    }
    assertEquals(
      await sweepExpiredReceipts(f.runtimePgDatabase!, 10),
      { deleted: 1, batches: 1 },
    );
    assertEquals((await receiptRows(f)).length, 0);
    assertEquals((await routeRows(f)).length, 0);
  });
});

Deno.test("issue 71 retention: a backlog goes oldest expiry first, and receipts with the same expiry go by id", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    const ids = await deliver(r, 6, 900);
    for (const id of ids) await setRouteStatus(f, id, "completed");
    // Receipts 3 and 4 expire at the same instant, so the id decides.
    const [tieFirst, tieLast] = [ids[3], ids[4]].sort();
    const now = Date.now();
    const hoursAgo = (hours: number) => new Date(now - hours * 60 * 60 * 1000);
    // Newest expiry first: the rows are rewritten in this order, so a scan
    // that follows the physical order meets the newest expiry first, and only
    // the ORDER BY puts the oldest first. The tie is rewritten larger id first
    // for the same reason.
    const schedule: Array<[string, Date]> = [
      [ids[5], hoursAgo(10)],
      [tieLast, hoursAgo(20)],
      [tieFirst, hoursAgo(20)],
      [ids[0], hoursAgo(30)],
      [ids[2], hoursAgo(40)],
      [ids[1], hoursAgo(50)],
    ];
    for (const [id, expiresAt] of schedule) {
      const moved = await f.pgDatabase.query(
        "update bakery.inbound_events set expires_at = $2 where id = $1",
        [id, expiresAt],
      );
      assertEquals(moved.rowCount, 1);
    }
    assertEquals(await receiptIds(f), [...ids].sort());

    // One batch of two per run, so each run shows which two went.
    const oneBatchOfTwo = () =>
      sweepExpiredReceipts(f.runtimePgDatabase!, 2, 1);
    assertEquals(await oneBatchOfTwo(), { deleted: 2, batches: 1 });
    assertEquals(
      await receiptIds(f),
      [ids[0], tieFirst, tieLast, ids[5]].sort(),
      "the 50 and 40 hours old receipts went first",
    );
    assertEquals(await oneBatchOfTwo(), { deleted: 2, batches: 1 });
    assertEquals(
      await receiptIds(f),
      [tieLast, ids[5]].sort(),
      "then the 30 hours old receipt and the smaller id of the tie",
    );
    assertEquals(await oneBatchOfTwo(), { deleted: 2, batches: 1 });
    assertEquals(await receiptIds(f), []);
  });
});

/** How many retention batch statements a recorded run sent. */
function deleteStatements(queries: readonly string[]): number {
  return queries.filter((sql) =>
    sql.includes("delete from bakery.inbound_events")
  )
    .length;
}

/** Sets the status of the one route of each named receipt. */
async function setRouteStatus(
  f: GitHubAppFixture,
  eventId: string,
  status: string,
): Promise<void> {
  const moved = await f.pgDatabase.query(
    `update bakery.inbound_event_routes set status = $2
      where inbound_event_id = $1`,
    [eventId, status],
  );
  assertEquals(moved.rowCount, 1);
}

Deno.test("issue 71 retention: an expired receipt is kept while its route is pending, processing or deferred, and goes once the route has ended", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    const ids = await deliver(r, 6, 600);
    const [pending, processing, deferred, completed, ignored, failed] = ids;
    await expire(f, ids, "as-is");
    await setRouteStatus(f, processing, "processing");
    await setRouteStatus(f, deferred, "deferred");
    await setRouteStatus(f, completed, "completed");
    await setRouteStatus(f, ignored, "ignored");
    await setRouteStatus(f, failed, "failed");
    const held = [pending, processing, deferred];
    const heldText = await textOf(f, held);

    // Two slots per batch: the three receipts with a live route must not use
    // any of them, so the three ended ones take two batches, not more.
    assertEquals(
      await sweepExpiredReceipts(f.runtimePgDatabase!, 2),
      { deleted: 3, batches: 2 },
    );
    assertEquals(await receiptIds(f), [...held].sort());
    assertEquals(
      await textOf(f, held),
      heldText,
      "the held receipts and their routes are byte-identical",
    );
    assertEquals(
      await sweepExpiredReceipts(f.runtimePgDatabase!, 2),
      { deleted: 0, batches: 0 },
      "nothing more goes while the routes have work",
    );

    // A route that ends releases its receipt, one at a time.
    for (
      const [id, ended] of [
        [pending, "completed"],
        [processing, "ignored"],
        [deferred, "failed"],
      ]
    ) {
      await setRouteStatus(f, id, ended);
      assertEquals(
        await sweepExpiredReceipts(f.runtimePgDatabase!),
        { deleted: 1, batches: 1 },
        `a ${ended} route lets its receipt go`,
      );
      assertEquals(await routesOf(f, [id]), 0);
    }
    assertEquals((await receiptRows(f)).length, 0);
    assertEquals((await routeRows(f)).length, 0);
  });
});

Deno.test("issue 71 retention: a receipt routed to two organizations is kept whole while either route has work and deleted whole after", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    await sharedSecondConnection(r);
    const sent = await receipt(r, {
      event: "installation",
      payload: installationPayload(r, "unsuspend"),
    });
    const routes = await routeRows(f, sent.eventId);
    assertEquals(routes.length, 2, "one route per live connection");
    assertEquals(new Set(routes.map((row) => row.organization_id)).size, 2);
    await expire(f, [sent.eventId], "as-is");
    const status = async (routeId: string, value: string) => {
      const moved = await f.pgDatabase.query(
        "update bakery.inbound_event_routes set status = $2 where id = $1",
        [routeId, value],
      );
      assertEquals(moved.rowCount, 1);
    };
    await status(routes[0].id, "completed");
    await status(routes[1].id, "deferred");
    const text = await textOf(f, [sent.eventId]);

    assertEquals(
      await sweepExpiredReceipts(f.runtimePgDatabase!),
      { deleted: 0, batches: 0 },
      "one ended route does not free the receipt",
    );
    assertEquals(await textOf(f, [sent.eventId]), text);
    assertEquals(await routesOf(f, [sent.eventId]), 2);

    await status(routes[1].id, "failed");
    assertEquals(
      await sweepExpiredReceipts(f.runtimePgDatabase!),
      { deleted: 1, batches: 1 },
    );
    assertEquals((await receiptRows(f)).length, 0);
    assertEquals(
      (await routeRows(f)).length,
      0,
      "both organizations' routes went with the receipt",
    );
  });
});

Deno.test("issue 71 retention: a batch that fails keeps nothing and holds nothing, the batches before it stay deleted and the next run finishes", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    const ids = await deliver(r, 5, 700);
    await expire(f, ids);
    const flaky = failingQuery(
      f.runtimePgDatabase!,
      /delete from bakery\.inbound_events/,
      2,
    );
    await assertRejects(
      () => sweepExpiredReceipts(flaky, 2),
      Error,
      "terminating connection",
    );
    assertEquals(
      (await receiptRows(f)).length,
      3,
      "the first batch of two stays deleted; the failed one deleted nothing",
    );
    // No row is left locked: a no-wait lock of every remaining receipt works.
    const locked = await f.pgDatabase.query(
      "select id from bakery.inbound_events for update nowait",
    );
    assertEquals(locked.rows.length, 3);
    assertEquals(
      await sweepExpiredReceipts(f.runtimePgDatabase!, 2),
      { deleted: 3, batches: 2 },
      "the next run takes the rest",
    );
    assertEquals((await receiptRows(f)).length, 0);
  });
});

Deno.test("issue 71 retention: a run returns counts only and writes nothing to the console", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    const ids = await deliver(r, 4, 800);
    await expire(f, ids.slice(0, 3));
    const lines: string[] = [];
    const saved = {
      debug: console.debug,
      error: console.error,
      info: console.info,
      log: console.log,
      warn: console.warn,
    };
    const record = (line: unknown) => lines.push(String(line));
    Object.assign(console, {
      debug: record,
      error: record,
      info: record,
      log: record,
      warn: record,
    });
    let swept;
    try {
      swept = await sweepExpiredReceipts(f.runtimePgDatabase!, 2);
    } finally {
      Object.assign(console, saved);
    }
    assertEquals(swept, { deleted: 3, batches: 2 });
    assertEquals(Object.keys(swept).sort(), ["batches", "deleted"]);
    assertEquals(lines, [], "the sweep logged nothing");
    assertEquals(await receiptIds(f), [ids[3]]);
  });
});

Deno.test("issue 71 retention: a redelivery after expiry is accepted as a new receipt and remembers nothing of the old one", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    const body = JSON.stringify(issuesPayload(r, 41, "opened"));
    const deliveryId = crypto.randomUUID();
    const first = await receipt(r, { event: "issues", body, deliveryId });
    assertEquals(first.status, "accepted");
    const again = await receipt(r, { event: "issues", body, deliveryId });
    assertEquals(again.status, "duplicate", "a live receipt still dedupes");
    assertEquals(again.eventId, first.eventId);

    await expire(f, [first.eventId]);
    assertEquals(
      await sweepExpiredReceipts(f.runtimePgDatabase!),
      { deleted: 1, batches: 1 },
    );
    assertEquals((await receiptRows(f)).length, 0);

    const redelivered = await receipt(r, { event: "issues", body, deliveryId });
    assertEquals(redelivered.status, "accepted");
    assertNotEquals(redelivered.eventId, first.eventId);
    assert(
      Date.parse(redelivered.receivedAt) > Date.parse(first.receivedAt),
      "the new receipt carries its own arrival time",
    );
    const row = await receiptRow(f, redelivered.eventId);
    assertEquals(row.external_delivery_id, deliveryId);
    assertEquals(row.status, "routed");
    assertEquals(RECEIPT_RETENTION_DAYS, 7);
    assertEquals(
      row.expires_at.getTime() - row.received_at.getTime(),
      7 * DAY_MS,
      "the new receipt expires seven days after its own arrival",
    );
    assertEquals((await routeRows(f, redelivered.eventId)).length, 1);
    assertEquals((await receiptRows(f)).length, 1);

    // Once swept, even the same id with different bytes is a new delivery:
    // the digest of the old receipt is gone with it.
    const otherId = crypto.randomUUID();
    const original = await receipt(r, {
      event: "issues",
      payload: issuesPayload(r, 42, "opened"),
      deliveryId: otherId,
    });
    await expire(f, [original.eventId]);
    await sweepExpiredReceipts(f.runtimePgDatabase!);
    const changed = await receipt(r, {
      event: "issues",
      payload: issuesPayload(r, 43, "opened"),
      deliveryId: otherId,
    });
    assertEquals(changed.status, "accepted");
    assertNotEquals(changed.eventId, original.eventId);
  });
});

Deno.test("issue 71 retention: the retention function runs hourly at minute 17, one at a time, and sweeps through one step", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    let config: Record<string, unknown> = {};
    let handler:
      | ((context: { step: unknown }) => Promise<unknown>)
      | undefined;
    const client = {
      createFunction(options: Record<string, unknown>, body: typeof handler) {
        config = options;
        handler = body;
        return {};
      },
    } as unknown as Inngest;
    createIntegrationIntakeRetention({
      client,
      database: f.runtimePgDatabase!,
    });
    assertEquals(
      {
        id: config.id,
        retries: config.retries,
        concurrency: config.concurrency,
        triggers: config.triggers,
      },
      {
        id: "bakery-integration-intake-retention",
        retries: 3,
        concurrency: [{ limit: 1 }],
        triggers: [{ cron: "17 * * * *" }],
      },
    );
    const [live, ...old] = await deliver(r, 3, 500);
    await expire(f, old);
    const steps: string[] = [];
    const outcome = await handler!({
      step: {
        run: async <T>(id: string, work: () => Promise<T>) => {
          steps.push(id);
          return await work();
        },
      },
    });
    assertEquals(outcome, { deleted: 2, batches: 1 });
    assertEquals(steps, ["sweep-expired-intake-receipts"]);
    assertEquals(await receiptIds(f), [live]);
  });
});

Deno.test("issue 71 retention: the begin response carries the active hook and the five repository events", async () => {
  await withFixture(async (f) => {
    const start = await started(f);
    const manifest = JSON.parse(start.manifest);
    assertEquals(manifest.hook_attributes, {
      url: `${authTestOrigin}/v1/webhooks/github`,
      active: true,
    });
    assertEquals(manifest.default_events, [
      "issues",
      "pull_request",
      "check_run",
      "check_suite",
      "repository",
    ]);
    assertEquals(
      manifest.default_events,
      [...GITHUB_APP_DEFAULT_EVENTS],
      "the response and the constant agree",
    );
    assertEquals(
      JSON.parse(start.manifest),
      buildGitHubAppManifest(authTestOrigin),
    );
    assertEquals(
      await count(f, "select count(*) from bakery.inbound_events"),
      0,
      "registering an App stores no receipt",
    );
  });
});

Deno.test("issue 71 retention: every event the manifest subscribes to is read by the receiver, and the lifecycle events need no subscription", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    const payloads: Record<string, unknown> = {
      issues: issuesPayload(r, 7, "opened"),
      pull_request: pullRequestPayload(r, 7, SHA_A, "opened"),
      check_run: checkRunPayload(r, SHA_A),
      check_suite: checkSuitePayload(r, SHA_A),
      repository: {
        action: "renamed",
        repository: { id: r.repositoryId },
        installation: { id: r.installationId },
      },
    };
    assertEquals(
      Object.keys(payloads).sort(),
      [...GITHUB_APP_DEFAULT_EVENTS].sort(),
      "this test sends exactly the subscribed events",
    );
    for (const event of GITHUB_APP_DEFAULT_EVENTS) {
      const sent = await receipt(r, { event, payload: payloads[event] });
      const row = await receiptRow(f, sent.eventId);
      assertEquals(row.event_kind, event);
      assertNotEquals(
        row.rejection_reason,
        "unsupported_event",
        `${event} is a supported event`,
      );
    }
    // Pull request and check events about a pull request nobody tracks are
    // ignored for that reason; the other two route.
    const reasons = (await receiptRows(f)).map((
      { event_kind, status, rejection_reason },
    ) => [event_kind, status, rejection_reason]);
    assertEquals(reasons.sort(), [
      ["check_run", "ignored", "untracked_pull_request"],
      ["check_suite", "ignored", "untracked_pull_request"],
      ["issues", "routed", null],
      ["pull_request", "ignored", "untracked_pull_request"],
      ["repository", "routed", null],
    ]);

    // GitHub sends these two to every App; the manifest does not list them.
    const lifecycle = {
      installation: installationPayload(r, "unsuspend"),
      installation_repositories: installationPayload(r, "added"),
    };
    for (const [event, payload] of Object.entries(lifecycle)) {
      assert(
        !(GITHUB_APP_DEFAULT_EVENTS as readonly string[]).includes(event),
        `${event} is not subscribed`,
      );
      const sent = await receipt(r, { event, payload });
      assertEquals((await receiptRow(f, sent.eventId)).status, "routed");
    }
  });
});

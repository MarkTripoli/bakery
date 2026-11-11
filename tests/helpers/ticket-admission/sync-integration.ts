/**
 * Issue 82 integration lane: the per-source sync step on real Postgres.
 * Transactions run as the application role; the reader and the fact index are
 * in memory. The step is proved at its bounds (25 candidates, a share for new
 * issues, rotation over old requests, a tie group larger than the index's row
 * bound), at its dispatch (live labels decide, a request is rechecked), at its
 * failure handling (a failed candidate holds the checkpoint for three steps, a
 * rate limit idles the source), in operation mode (prefetched answers, one
 * savepoint per candidate) and at its locks.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import type { PgTransactionClient } from "../../../apps/server/src/platform/database.ts";
import type { AdmissionDeps } from "../../../apps/server/src/modules/work/ticket-admission.ts";
import {
  prefetchTicketReads,
  type TicketPrefetch,
  TicketPrefetchRequiredError,
} from "../../../apps/server/src/modules/work/ticket-prefetch.ts";
import { readSourceHandle } from "../../../apps/server/src/modules/work/ticket-store.ts";
import {
  runTicketSourceStep,
  selectSyncCandidates,
  SYNC_FAILURE_LIMIT,
  SYNC_OUTAGE_LIMIT,
  SYNC_STEP_LIMIT,
} from "../../../apps/server/src/modules/work/ticket-sync.ts";
import { assertNoDeadlock, holdRow, raceInOrder } from "../lock-race.ts";
import {
  AFTER_SINCE,
  automaticPolicy,
  createMemoryFactIndex,
  EXECUTE_LABEL,
  HOLD_LABEL,
  type IssueInit,
  type MemoryFactIndex,
  seedLabeler,
  type TicketFixture,
  withTicketFixture,
} from "./fixtures.ts";

const signal = new AbortController().signal;

let clock = Date.parse("2026-06-10T00:00:00Z");
/** A new provider-update instant, one second after the last. */
const instant = () => new Date(clock += 1000).toISOString();

/** An issue labeled for execution, known to the reader and the fact index alike. */
function labeled(
  fx: TicketFixture,
  index: MemoryFactIndex,
  number: number,
  overrides: Partial<IssueInit> = {},
) {
  const updatedAt = overrides.updatedAt ?? instant();
  const labels = overrides.labels ?? [EXECUTE_LABEL];
  fx.reader.setIssue({ ...overrides, number, labels, updatedAt });
  fx.reader.setLabelApplied(number, EXECUTE_LABEL, { appliedAt: AFTER_SINCE });
  index.set(number, updatedAt, labels);
}

function step(
  fx: TicketFixture,
  index: MemoryFactIndex,
  sourceId: string,
  options: {
    limit?: number;
    now?: Date;
    deps?: AdmissionDeps;
    prefetched?: Map<number, TicketPrefetch>;
  } = {},
) {
  const { now } = options;
  return runTicketSourceStep(
    {
      ...(options.deps ?? fx.automationDeps()),
      factIndex: index,
      ...(now === undefined ? {} : { now: () => now }),
    },
    {
      organizationId: fx.organizationId,
      sourceId,
      limit: options.limit ?? SYNC_STEP_LIMIT,
      prefetched: options.prefetched,
      signal,
    },
  );
}

type StepResult = Awaited<ReturnType<typeof step>>;
const row = (result: StepResult, number: number) => {
  const found = result.results.find((entry) => entry.number === number);
  assert(found !== undefined, `candidate ${number} was looked at`);
  return found;
};

async function sourceRow(fx: TicketFixture, sourceId: string) {
  const result = await fx.owner.query<{
    sync_checkpoint: Record<string, unknown> | null;
    sync_health: string;
    last_synced_at: Date | null;
    last_problem_code: string | null;
    version: number;
    policy_revision: number;
    updated_at: Date;
  }>(
    `select sync_checkpoint, sync_health, last_synced_at, last_problem_code,
            version, policy_revision, updated_at
       from bakery.ticket_sources where organization_id = $1 and id = $2`,
    [fx.organizationId, sourceId],
  );
  return result.rows[0];
}

/** An admin's `If-Match` update: it succeeds only while `version` is the one read. */
async function ifMatchUpdate(
  fx: TicketFixture,
  sourceId: string,
  version: number,
) {
  const result = await fx.runtime.query(
    `update bakery.ticket_sources
        set policy_revision = policy_revision + 1, version = version + 1,
            updated_at = now()
      where organization_id = $1 and id = $2 and version = $3`,
    [fx.organizationId, sourceId, version],
  );
  return result.rowCount;
}

async function prefetchMap(
  fx: TicketFixture,
  sourceId: string,
  numbers: number[],
) {
  const { source, handle } = await fx.inTransaction((tx) =>
    readSourceHandle(tx, fx.organizationId, sourceId)
  );
  const map = new Map<number, TicketPrefetch>();
  for (const number of numbers) {
    map.set(
      number,
      await prefetchTicketReads(
        fx.reader,
        handle,
        { number, policy: source.policy, origin: "poll" },
        signal,
      ),
    );
  }
  return map;
}

Deno.test("issue 82 sync: a step looks at no more than its limit, keeps a share for new issues, and reaches 26 old requests within two steps", () =>
  withTicketFixture(async (fx) => {
    const index = createMemoryFactIndex();
    const sourceId = await fx.insertSource({ policy: automaticPolicy(fx) });
    seedLabeler(fx);
    const old = Array.from({ length: 26 }, (_, i) => 1001 + i);
    for (const number of old) {
      fx.reader.setIssue({ number });
      await fx.admit(sourceId, { number, intent: "plan" });
    }
    for (let number = 1; number <= 12; number++) labeled(fx, index, number);

    // Selection reads the database only, and splits the limit two fifths to
    // new issues, the rest to known ones.
    fx.reader.clearCalls();
    const selection = await fx.inTransaction((tx) =>
      selectSyncCandidates(tx, { factIndex: index }, {
        organizationId: fx.organizationId,
        sourceId,
        limit: 10,
      })
    );
    assertEquals(
      selection.candidates.map(({ kind, number }) => [kind, number]),
      [
        ...[1, 2, 3, 4].map((n) => ["new", n]),
        ...[1001, 1002, 1003, 1004, 1005, 1006].map((n) => ["known", n]),
      ],
    );
    assertEquals(fx.reader.calls, []);

    // 26 old requests would fill all 25 slots; the share still admits new issues.
    const first = await step(fx, index, sourceId);
    assertEquals(first.outcome, "completed");
    assertEquals(first.results.length, 25);
    const fresh = first.results.filter(({ kind }) => kind === "new");
    assertEquals(fresh.map(({ number }) => number), [
      1,
      2,
      3,
      4,
      5,
      6,
      7,
      8,
      9,
      10,
    ]);
    assert(fresh.every(({ admission }) => admission === "admitted"));
    const known = first.results.filter(({ kind }) => kind === "known");
    assertEquals(known.map(({ number }) => number), old.slice(0, 15));
    assert(known.every(({ action }) => action === "recheck"));
    assertEquals((await fx.counts(sourceId)).nonterminalRequests, 36);
    assertEquals((await sourceRow(fx, sourceId)).sync_checkpoint?.cursor, 1015);

    const second = await step(fx, index, sourceId);
    assertEquals(
      second.results.filter(({ kind }) => kind === "new").map((
        r,
      ) => [r.number, r.admission]),
      [[11, "admitted"], [12, "admitted"]],
    );
    // The rotation wraps: the tail of the old requests, then the new ones, then the head.
    assertEquals(
      second.results.filter(({ kind }) => kind === "known").map((r) =>
        r.number
      ),
      [
        ...old.slice(15),
        ...Array.from({ length: 10 }, (_, i) => i + 1),
        1001,
        1002,
      ],
    );
    const rechecked = new Set(
      [first, second].flatMap(({ results }) =>
        results.filter(({ action }) => action === "recheck").map((r) =>
          r.number
        )
      ),
    );
    assert(old.every((number) => rechecked.has(number)), "all 26 rechecked");
  }));

Deno.test("issue 82 sync dispatch: live labels decide for a ticket without a request, a ticket with a request is rechecked, a reopened and relabeled ticket and a second generation are admitted, the rest is left alone", () =>
  withTicketFixture(async (fx) => {
    const index = createMemoryFactIndex();
    const sourceId = await fx.insertSource({ policy: automaticPolicy(fx) });
    seedLabeler(fx);
    labeled(fx, index, 101);
    labeled(fx, index, 102, { labels: ["bug"] });
    index.set(103, instant()); // the provider has no such issue
    labeled(fx, index, 104, { state: "closed", stateReason: "completed" });
    labeled(fx, index, 105, { labels: [EXECUTE_LABEL, HOLD_LABEL] });

    const first = await step(fx, index, sourceId);
    assertEquals([row(first, 101).action, row(first, 101).admission], [
      "admit",
      "admitted",
    ]);
    assertEquals(row(first, 102).action, "none");
    assertEquals(row(first, 103).action, "none");
    for (const number of [104, 105]) {
      assertEquals([row(first, number).action, row(first, number).admission], [
        "admit",
        "unadmitted",
      ], String(number));
    }
    const counts = await fx.counts(sourceId);
    assertEquals([counts.tickets, counts.nonterminalRequests], [3, 1]);

    // With nothing new, only the request is looked at: a rejected ticket and a
    // held one that waits are not selected again.
    const idle = await step(fx, index, sourceId);
    assertEquals(idle.results.map(({ number }) => number), [101]);

    // 101 owns a request: a withdrawn label suspends it, it is not admitted again.
    labeled(fx, index, 101, { labels: [] });
    // 104 and 105 are known tickets with no request and a rejected or waiting
    // report; the live issue is now open and labeled, or no longer held.
    labeled(fx, index, 104);
    labeled(fx, index, 105);
    const second = await step(fx, index, sourceId);
    const looked = second.results.map(({ number }) => number);
    assertEquals(new Set(looked).size, looked.length, "each number once");
    assertEquals([row(second, 101).action, row(second, 101).applied], [
      "recheck",
      ["suspend"],
    ]);
    assertEquals([row(second, 104).action, row(second, 104).admission], [
      "admit",
      "admitted",
    ]);
    assertEquals([row(second, 105).action, row(second, 105).admission], [
      "admit",
      "admitted",
    ]);

    // A completed request does not stop the next generation.
    const other = await fx.insertSource({ policy: automaticPolicy(fx) });
    const otherIndex = createMemoryFactIndex();
    labeled(fx, otherIndex, 201);
    assertEquals(
      row(await step(fx, otherIndex, other), 201).admission,
      "admitted",
    );
    await fx.finishRequests(other);
    labeled(fx, otherIndex, 201);
    assertEquals(
      row(await step(fx, otherIndex, other), 201).admission,
      "admitted",
    );
    const generations = await fx.owner.query<
      { generation: number; disposition: string }
    >(
      `select generation, disposition from bakery.ticket_requests
        where organization_id = $1 order by generation desc limit 1`,
      [fx.organizationId],
    );
    assertEquals(generations.rows[0], {
      generation: 2,
      disposition: "admitted",
    });
  }));

Deno.test("issue 82 sync: a ticket waiting on a blocker is selected every step and admitted by the first step after the blocker merges", () =>
  withTicketFixture(async (fx) => {
    const index = createMemoryFactIndex();
    const sourceId = await fx.insertSource({ policy: automaticPolicy(fx) });
    seedLabeler(fx);
    labeled(fx, index, 301);
    fx.reader.setLinks(301, {
      blockedBy: [{
        id: "5301",
        number: 3,
        repositoryFullName: fx.repositoryFullName,
      }],
    });
    fx.reader.setProof("5301", { kind: "open" });

    const waiting = await step(fx, index, sourceId);
    assertEquals(row(waiting, 301).admission, "unadmitted");
    assertEquals((await fx.counts(sourceId)).nonterminalRequests, 0);
    // The fact index lists nothing new; the report alone brings it back.
    const again = await step(fx, index, sourceId);
    assertEquals([row(again, 301).kind, row(again, 301).admission], [
      "known",
      "unadmitted",
    ]);

    fx.reader.setProof("5301", {
      kind: "satisfied",
      pullRequestNumber: 4,
      mergeSha: "b".repeat(40),
      mergedAt: AFTER_SINCE,
    });
    const merged = await step(fx, index, sourceId);
    assertEquals([row(merged, 301).kind, row(merged, 301).admission], [
      "known",
      "admitted",
    ]);
    assertEquals((await fx.counts(sourceId)).runs, 1);
  }));

Deno.test("issue 82 sync: a step writes the checkpoint, health and last sync and nothing that refuses an If-Match update; an invalid stored checkpoint reads as empty", () =>
  withTicketFixture(async (fx) => {
    const index = createMemoryFactIndex();
    const sourceId = await fx.insertSource({ policy: automaticPolicy(fx) });
    seedLabeler(fx);
    await fx.owner.query(
      `update bakery.ticket_sources set sync_checkpoint = '{"marker": 7}'::jsonb
        where organization_id = $1 and id = $2`,
      [fx.organizationId, sourceId],
    );
    for (const number of [401, 402, 403]) labeled(fx, index, number);
    const last = instant();
    labeled(fx, index, 404, { updatedAt: last });

    const before = await sourceRow(fx, sourceId);
    const done = await step(fx, index, sourceId);
    assertEquals([done.outcome, done.health], ["completed", "healthy"]);
    const after = await sourceRow(fx, sourceId);
    assertEquals(after.sync_health, "healthy");
    assert(after.last_synced_at !== null);
    assertEquals(after.last_problem_code, null);
    assert(after.sync_checkpoint !== null);
    const { attemptedAt, ...position } = after.sync_checkpoint;
    assert(
      typeof attemptedAt === "string" &&
        Number.isFinite(Date.parse(attemptedAt)),
      "the step stamps its attempt instant",
    );
    assertEquals(position, {
      marker: last,
      markerNumber: 404,
      cursor: null,
      notBefore: null,
      failure: null,
    });
    assertEquals(
      [after.version, after.policy_revision, after.updated_at.getTime()],
      [before.version, before.policy_revision, before.updated_at.getTime()],
    );
    assertEquals(await ifMatchUpdate(fx, sourceId, before.version), 1);
  }));

Deno.test("issue 82 sync: absence is never inferred; a request the index no longer lists is kept and a gone issue changes no ticket row", () =>
  withTicketFixture(async (fx) => {
    const index = createMemoryFactIndex();
    const sourceId = await fx.insertSource({ policy: automaticPolicy(fx) });
    seedLabeler(fx);
    labeled(fx, index, 801);
    labeled(fx, index, 802, { state: "closed", stateReason: "completed" });
    await step(fx, index, sourceId);
    const tickets = () =>
      fx.owner.query(
        `select number, version, state from bakery.external_tickets
          where organization_id = $1 and ticket_source_id = $2 order by number`,
        [fx.organizationId, sourceId],
      ).then((result) => result.rows);
    const stored = await tickets();
    assertEquals(stored.length, 2);

    index.remove(801);
    index.remove(802);
    const quiet = await step(fx, index, sourceId);
    assertEquals([row(quiet, 801).action, row(quiet, 801).applied], [
      "recheck",
      [],
    ]);
    assertEquals((await fx.counts(sourceId)).nonterminalRequests, 1);

    fx.reader.setIssueRead(802, { kind: "gone" });
    index.set(802, instant());
    const gone = await step(fx, index, sourceId);
    assertEquals([row(gone, 802).status, row(gone, 802).action], [
      "done",
      "none",
    ]);
    assertEquals(await tickets(), stored);
  }));

Deno.test("issue 82 sync: a candidate that keeps failing holds the checkpoint for three steps and then is passed, and a provider outage never passes a new issue", () =>
  withTicketFixture(async (fx) => {
    const index = createMemoryFactIndex();
    const sourceId = await fx.insertSource({ policy: automaticPolicy(fx) });
    seedLabeler(fx);
    // A title of white space is ready for admission but not a valid task
    // title: issue 1 fails the same way on every step.
    labeled(fx, index, 1, { title: " " });
    for (let number = 2; number <= 12; number++) labeled(fx, index, number);

    const code = "ticket_task_input_invalid";
    const tickets = async () => (await fx.counts(sourceId)).tickets;
    const first = await step(fx, index, sourceId);
    assertEquals([row(first, 1).status, row(first, 1).problem], [
      "failed",
      code,
    ]);
    assertEquals(
      first.results.filter(({ admission }) => admission === "admitted").length,
      9,
    );
    let source = await sourceRow(fx, sourceId);
    assertEquals(source.sync_checkpoint?.marker, null);
    assertEquals(source.sync_checkpoint?.failure, {
      number: 1,
      code,
      count: 1,
    });
    assertEquals([source.sync_health, source.last_problem_code], [
      "degraded",
      code,
    ]);

    await step(fx, index, sourceId);
    source = await sourceRow(fx, sourceId);
    assertEquals(source.sync_checkpoint?.failure, {
      number: 1,
      code,
      count: 2,
    });
    assertEquals(await tickets(), 9, "issues 11 and 12 are beyond the share");

    const third = await step(fx, index, sourceId);
    source = await sourceRow(fx, sourceId);
    assertEquals(source.sync_checkpoint?.markerNumber, 10);
    assertEquals(source.sync_checkpoint?.failure, null);
    assertEquals(source.last_problem_code, code);
    assertEquals(row(third, 1).status, "failed");
    assertEquals(await tickets(), 9);

    const fourth = await step(fx, index, sourceId);
    assertEquals(
      fourth.results.filter(({ kind }) => kind === "new").map((
        r,
      ) => [r.number, r.admission]),
      [[11, "admitted"], [12, "admitted"]],
    );
    source = await sourceRow(fx, sourceId);
    assertEquals([source.sync_health, source.last_problem_code], [
      "healthy",
      null,
    ]);
    assertEquals(await tickets(), 11);

    // An unavailable provider gives no labels: the new issue is not passed.
    const outageIndex = createMemoryFactIndex();
    const outageSource = await fx.insertSource({ policy: automaticPolicy(fx) });
    labeled(fx, outageIndex, 20);
    fx.reader.failNext("readIssue");
    const down = await step(fx, outageIndex, outageSource);
    assertEquals([row(down, 20).status, row(down, 20).problem], [
      "failed",
      "provider_unavailable",
    ]);
    assertEquals(
      (await sourceRow(fx, outageSource)).sync_checkpoint?.markerNumber,
      null,
    );
    assertEquals(
      row(await step(fx, outageIndex, outageSource), 20).admission,
      "admitted",
    );
  }));

Deno.test("issue 82 sync: an outage of many steps never passes the head issue and recovery admits it; a provider that never answers is passed after the outage limit, an issue with too many labels after three steps", () =>
  withTicketFixture(async (fx) => {
    const index = createMemoryFactIndex();
    const sourceId = await fx.insertSource({ policy: automaticPolicy(fx) });
    seedLabeler(fx);
    labeled(fx, index, 30);
    const outage = SYNC_FAILURE_LIMIT + 2;
    for (let count = 1; count <= outage; count++) {
      fx.reader.failNext("readIssue");
      const down = await step(fx, index, sourceId);
      assertEquals([row(down, 30).status, row(down, 30).problem], [
        "failed",
        "provider_unavailable",
      ]);
      const source = await sourceRow(fx, sourceId);
      assertEquals(source.sync_checkpoint?.markerNumber, null);
      assertEquals(source.sync_checkpoint?.failure, {
        number: 30,
        code: "provider_unavailable",
        count,
      });
      assertEquals(source.sync_health, "degraded");
    }
    assertEquals((await fx.counts(sourceId)).tickets, 0);
    assertEquals(
      row(await step(fx, index, sourceId), 30).admission,
      "admitted",
    );
    const healed = await sourceRow(fx, sourceId);
    assertEquals(healed.sync_checkpoint?.markerNumber, 30);
    assertEquals([healed.sync_checkpoint?.failure, healed.sync_health], [
      null,
      "healthy",
    ]);

    // An issue the provider never answers is passed on its outage-limit-th failing step.
    const stuck = await fx.insertSource({ policy: automaticPolicy(fx) });
    const stuckIndex = createMemoryFactIndex();
    labeled(fx, stuckIndex, 40);
    await fx.owner.query(
      `update bakery.ticket_sources set sync_checkpoint = $3::jsonb
        where organization_id = $1 and id = $2`,
      [
        fx.organizationId,
        stuck,
        JSON.stringify({
          marker: null,
          markerNumber: null,
          cursor: null,
          notBefore: null,
          failure: {
            number: 40,
            code: "provider_unavailable",
            count: SYNC_OUTAGE_LIMIT - 1,
          },
        }),
      ],
    );
    fx.reader.failNext("readIssue");
    await step(fx, stuckIndex, stuck);
    const passed = await sourceRow(fx, stuck);
    assertEquals(passed.sync_checkpoint?.markerNumber, 40);
    assertEquals(passed.sync_checkpoint?.failure, null);

    // Too many labels lasts as long as the issue does: three steps, not a day.
    const wide = await fx.insertSource({ policy: automaticPolicy(fx) });
    const wideIndex = createMemoryFactIndex();
    labeled(fx, wideIndex, 50);
    fx.reader.setIssueRead(50, {
      kind: "unavailable",
      reason: "labels_truncated",
      retryAfterSeconds: null,
    });
    for (let count = 1; count <= SYNC_FAILURE_LIMIT; count++) {
      await step(fx, wideIndex, wide);
    }
    assertEquals(
      (await sourceRow(fx, wide)).sync_checkpoint?.markerNumber,
      50,
    );
  }));

Deno.test("issue 82 sync: a rate limit stops the step and idles the source until the retry-after; lost authority marks it auth_required", () =>
  withTicketFixture(async (fx) => {
    const index = createMemoryFactIndex();
    const sourceId = await fx.insertSource({ policy: automaticPolicy(fx) });
    seedLabeler(fx);
    labeled(fx, index, 501);
    labeled(fx, index, 502);
    const now = new Date("2026-08-01T12:00:00Z");

    fx.reader.failNext("readIssue", {
      kind: "unavailable",
      reason: "rate_limited",
      retryAfterSeconds: 120,
    });
    const limited = await step(fx, index, sourceId, { now });
    assertEquals(limited.outcome, "rate_limited");
    assert(limited.results.every(({ status }) => status === "unprocessed"));
    assertEquals((await fx.counts(sourceId)).tickets, 0);
    let source = await sourceRow(fx, sourceId);
    assertEquals([source.sync_health, source.last_problem_code], [
      "degraded",
      "rate_limited",
    ]);
    assertEquals(source.sync_checkpoint?.notBefore, "2026-08-01T12:02:00.000Z");
    assertEquals(source.last_synced_at, null);

    // Inside the wait nothing is read and nothing is written.
    fx.reader.clearCalls();
    const idle = await step(fx, index, sourceId, {
      now: new Date(now.getTime() + 60_000),
    });
    assertEquals([idle.outcome, idle.results], ["not_before", []]);
    assertEquals(fx.reader.calls, []);
    assertEquals(await sourceRow(fx, sourceId), source);

    const resumed = await step(fx, index, sourceId, {
      now: new Date(now.getTime() + 121_000),
    });
    assertEquals(resumed.outcome, "completed");
    assertEquals((await fx.counts(sourceId)).nonterminalRequests, 2);
    source = await sourceRow(fx, sourceId);
    assertEquals([
      source.sync_health,
      source.last_problem_code,
      source.sync_checkpoint?.notBefore,
    ], ["healthy", null, null]);

    // No wait given: one minute. A very long wait is cut to an hour.
    labeled(fx, index, 503);
    const wait = (seconds: number | null) =>
      fx.reader.failNext("readIssue", {
        kind: "unavailable",
        reason: "rate_limited",
        retryAfterSeconds: seconds,
      });
    const notBefore = async () =>
      (await sourceRow(fx, sourceId)).sync_checkpoint?.notBefore;
    const t1 = new Date("2026-08-02T00:00:00Z");
    wait(null);
    await step(fx, index, sourceId, { now: t1 });
    assertEquals(await notBefore(), "2026-08-02T00:01:00.000Z");
    const t2 = new Date(t1.getTime() + 61_000);
    wait(1_000_000);
    await step(fx, index, sourceId, { now: t2 });
    assertEquals(await notBefore(), "2026-08-02T01:01:01.000Z");

    const t3 = new Date(t2.getTime() + 3_601_000);
    fx.reader.failNext("readIssue", {
      kind: "unavailable",
      reason: "forbidden",
      retryAfterSeconds: null,
    });
    const refused = await step(fx, index, sourceId, { now: t3 });
    assertEquals(refused.outcome, "auth_required");
    source = await sourceRow(fx, sourceId);
    assertEquals([source.sync_health, source.last_problem_code], [
      "auth_required",
      "auth_required",
    ]);
    assertEquals(
      row(await step(fx, index, sourceId), 503).admission,
      "admitted",
    );
  }));

Deno.test("issue 82 sync operation mode: a failing candidate rolls back to its savepoint while the others commit, a candidate without an answer is skipped and retried, and a step that may not read needs its answers", () =>
  withTicketFixture(async (fx) => {
    const index = createMemoryFactIndex();
    const sourceId = await fx.insertSource({ policy: automaticPolicy(fx) });
    seedLabeler(fx);
    for (const number of [601, 602, 603]) labeled(fx, index, number);
    const before = await sourceRow(fx, sourceId);

    // The first request insert collides with a rival row after the task, link
    // and report exist, so the refusal has something to roll back.
    let injected = false;
    const colliding = (transaction: PgTransactionClient) =>
      ({
        query: async (text: unknown, values?: unknown[]) => {
          if (
            !injected && typeof text === "string" &&
            /insert into bakery\.ticket_requests/.test(text)
          ) {
            injected = true;
            const copy = [...values!];
            copy[0] = crypto.randomUUID();
            copy[5] = (copy[5] as number) + 1;
            await transaction.query(text, copy);
          }
          return await transaction.query(text as string, values);
        },
      }) as never as PgTransactionClient;
    const prefetched = await prefetchMap(fx, sourceId, [601, 602]);
    fx.reader.clearCalls();
    const partial = await fx.inTransaction((transaction) =>
      step(fx, index, sourceId, {
        deps: fx.operationDeps(colliding(transaction)),
        prefetched,
        limit: 10,
      })
    );
    assert(injected, "the collision was forced");
    assertEquals(
      partial.results.map((
        { number, status, problem },
      ) => [number, status, problem]),
      [
        [601, "failed", "ticket_request_exists"],
        [602, "done", null],
        [603, "unprocessed", null],
      ],
    );
    assertEquals(fx.reader.calls, [], "operation mode reads nothing");
    const counts = await fx.counts(sourceId);
    assertEquals([counts.tickets, counts.tasks, counts.requests], [1, 1, 1]);
    const orphans = await fx.owner.query(
      `select 1 from bakery.tasks where organization_id = $1 and title = 'Issue 601'`,
      [fx.organizationId],
    );
    assertEquals(
      orphans.rows.length,
      0,
      "no orphan task of the refused candidate",
    );
    const held = await sourceRow(fx, sourceId);
    assertEquals(held.sync_checkpoint?.markerNumber, null);
    assertEquals(held.sync_checkpoint?.failure, {
      number: 601,
      code: "ticket_request_exists",
      count: 1,
    });
    assertEquals([held.version, held.policy_revision], [
      before.version,
      before.policy_revision,
    ]);

    // The failed and the skipped candidate are looked at again.
    const everything = await prefetchMap(fx, sourceId, [601, 602, 603]);
    const next = await fx.inTransaction((transaction) =>
      step(fx, index, sourceId, {
        deps: fx.operationDeps(transaction),
        prefetched: everything,
        limit: 10,
      })
    );
    assertEquals(
      next.results.map((
        { number, action, admission },
      ) => [number, action, admission]),
      [[601, "admit", "admitted"], [602, "recheck", null], [
        603,
        "admit",
        "admitted",
      ]],
    );
    const done = await sourceRow(fx, sourceId);
    assertEquals([
      done.sync_checkpoint?.markerNumber,
      done.sync_checkpoint?.failure,
      done.sync_health,
    ], [603, null, "healthy"]);

    // Answers belong to operation mode: automation with a map is a misuse.
    await assertRejects(
      () => step(fx, index, sourceId, { prefetched: new Map() }),
      Error,
      "TICKET_ADMISSION_DEPS_INVALID",
    );
    // No answers and no right to read: the step refuses before it looks at anything.
    await assertRejects(
      () =>
        fx.inTransaction((transaction) =>
          step(fx, index, sourceId, { deps: fx.operationDeps(transaction) })
        ),
      TicketPrefetchRequiredError,
    );
    await assertRejects(
      () =>
        step(fx, index, sourceId, {
          deps: { ...fx.automationDeps(), readsAllowed: false },
        }),
      TicketPrefetchRequiredError,
    );
  }));

Deno.test("issue 82 sync locks: an operation-mode step and admitTicket for one ticket never deadlock in either order, leave one request, and leave the source open to an If-Match update", () =>
  withTicketFixture(async (fx) => {
    const index = createMemoryFactIndex();
    const sourceId = await fx.insertSource({ policy: automaticPolicy(fx) });
    seedLabeler(fx);
    for (
      const [number, order] of [[701, "sync first"], [
        702,
        "admit first",
      ]] as const
    ) {
      // Stored without criteria so the ticket row exists, then made ready.
      labeled(fx, index, number, { body: "No criteria here." });
      const stored = await fx.admit(sourceId, { number, origin: "poll" });
      assertEquals(stored.kind, "unadmitted");
      labeled(fx, index, number);
      const prefetched = await prefetchMap(fx, sourceId, [number]);
      const sync = () =>
        fx.inTransaction((transaction) =>
          step(fx, index, sourceId, {
            deps: fx.operationDeps(transaction),
            prefetched,
            limit: 10,
          })
        );
      const admit = () => fx.admit(sourceId, { number, intent: "start" });
      const hold = await holdRow(
        fx.owner,
        "select id from bakery.external_tickets where organization_id = $1 and id = $2 for update",
        [fx.organizationId, stored.ticketId],
      );
      const [first, second] = order === "sync first"
        ? await raceInOrder(fx.owner, hold, sync, admit)
        : await raceInOrder(fx.owner, hold, admit, sync);
      assertNoDeadlock(first);
      assertNoDeadlock(second);
      assertEquals(
        [first.status, second.status],
        ["fulfilled", "fulfilled"],
        order,
      );
      const requests = await fx.owner.query<{ count: number }>(
        `select count(*)::int as count from bakery.ticket_requests
          where organization_id = $1 and external_ticket_id = $2`,
        [fx.organizationId, stored.ticketId],
      );
      assertEquals(requests.rows[0].count, 1, order);
      const source = await sourceRow(fx, sourceId);
      assertEquals(await ifMatchUpdate(fx, sourceId, source.version), 1, order);
    }
  }));

Deno.test("issue 82 sync: a group of 120 issues updated at one instant is read in full over successive steps", () =>
  withTicketFixture(async (fx) => {
    const index = createMemoryFactIndex();
    const sourceId = await fx.insertSource({ policy: automaticPolicy(fx) });
    for (let number = 1; number <= 120; number++) {
      index.set(number, "2026-07-02T00:00:00.000Z");
    }
    const seen: number[] = [];
    let steps = 0;
    for (;;) {
      const result = await step(fx, index, sourceId);
      const fresh = result.results.filter(({ kind }) => kind === "new");
      if (fresh.length === 0) break;
      assert(fresh.every(({ status }) => status === "done"));
      seen.push(...fresh.map(({ number }) => number));
      steps += 1;
    }
    assertEquals(seen, Array.from({ length: 120 }, (_, i) => i + 1));
    assertEquals(steps, 12);
    assertEquals(
      (await sourceRow(fx, sourceId)).sync_checkpoint?.markerNumber,
      120,
    );
  }));

Deno.test("issue 82 sync: a poll step never undoes an operation-mode sync that committed between its read and its write", () =>
  withTicketFixture(async (fx) => {
    const index = createMemoryFactIndex();
    const sourceId = await fx.insertSource({ policy: automaticPolicy(fx) });
    seedLabeler(fx);
    for (const number of [800, 801, 802]) {
      labeled(fx, createMemoryFactIndex(), number);
      await fx.admit(sourceId, { number, origin: "poll" });
    }
    for (const number of [901, 902, 903]) labeled(fx, index, number);
    const now = new Date("2026-09-01T12:00:00Z");
    const operation = (prefetched: Map<number, TicketPrefetch>) =>
      fx.inTransaction((transaction) =>
        step(fx, index, sourceId, {
          deps: fx.operationDeps(transaction),
          prefetched,
          limit: 10,
          now,
        })
      );

    // The poll reads the empty checkpoint and takes one new issue and two old
    // requests (limit 3). Its first provider read lets two syncs commit: one
    // passes all six candidates, the next meets a rate limit.
    let interfered = false;
    const reader = {
      ...fx.reader,
      readIssue: async (...args: Parameters<typeof fx.reader.readIssue>) => {
        if (!interfered) {
          interfered = true;
          const passed = await operation(
            await prefetchMap(fx, sourceId, [901, 902, 903, 800, 801, 802]),
          );
          assertEquals(passed.outcome, "completed");
          const limited = await prefetchMap(fx, sourceId, [800]);
          limited.set(800, {
            ...limited.get(800)!,
            issue: {
              kind: "unavailable",
              reason: "rate_limited",
              retryAfterSeconds: 600,
            },
          });
          assertEquals((await operation(limited)).outcome, "rate_limited");
        }
        return await fx.reader.readIssue(...args);
      },
    };
    const poll = await step(fx, index, sourceId, {
      deps: { ...fx.automationDeps(), reader },
      limit: 3,
      now,
    });
    assert(
      interfered,
      "the interference ran between the poll's read and write",
    );
    assertEquals(poll.results.map(({ number }) => number), [901, 800, 801]);
    assertEquals([poll.health, poll.problemCode], ["degraded", "rate_limited"]);
    const source = await sourceRow(fx, sourceId);
    assertEquals(source.sync_checkpoint?.markerNumber, 903);
    assertEquals(source.sync_checkpoint?.cursor, 802);
    assertEquals(source.sync_checkpoint?.notBefore, "2026-09-01T12:10:00.000Z");
    assertEquals([source.sync_health, source.last_problem_code], [
      "degraded",
      "rate_limited",
    ]);

    // Once the wait is over the next poll step clears it.
    const later = await step(fx, index, sourceId, {
      now: new Date(now.getTime() + 601_000),
    });
    assertEquals(later.outcome, "completed");
    const healed = await sourceRow(fx, sourceId);
    assertEquals(healed.sync_checkpoint?.notBefore, null);
    assertEquals(healed.sync_health, "healthy");
  }));

Deno.test("issue 82 sync locks: two poll steps on one source never deadlock, both finish, and the stored checkpoint is the merge", () =>
  withTicketFixture(async (fx) => {
    const index = createMemoryFactIndex();
    const sourceId = await fx.insertSource({ policy: automaticPolicy(fx) });
    // No request label: dispatch leaves each issue alone and takes no lock, so
    // both steps reach their write transaction and queue there, behind a hold.
    for (let number = 1; number <= 4; number++) {
      labeled(fx, index, number, { labels: [] });
    }
    const poll = (limit: number) => () => step(fx, index, sourceId, { limit });
    const hold = await holdRow(
      fx.owner,
      "select id from bakery.ticket_sources where organization_id = $1 and id = $2 for update",
      [fx.organizationId, sourceId],
    );
    // Limit 10 passes four new issues, limit 5 passes two: whichever writes
    // last, the position that stays is the later one.
    const [wide, narrow] = await raceInOrder(fx.owner, hold, poll(10), poll(5));
    assertNoDeadlock(wide);
    assertNoDeadlock(narrow);
    assertEquals([wide.status, narrow.status], ["fulfilled", "fulfilled"]);
    const source = await sourceRow(fx, sourceId);
    assertEquals(source.sync_checkpoint?.markerNumber, 4);
    assertEquals(source.sync_health, "healthy");
  }));

Deno.test("issue 82 sync: a step that lost authority keeps auth_required over another run's rate-limit wait, and the wait still holds", () =>
  withTicketFixture(async (fx) => {
    const index = createMemoryFactIndex();
    const sourceId = await fx.insertSource({ policy: automaticPolicy(fx) });
    seedLabeler(fx);
    labeled(fx, index, 810);
    const now = new Date("2026-09-02T12:00:00Z");

    // The poll's first provider read lets an operation-mode sync commit a
    // rate-limit wait, then the poll itself is refused.
    let interfered = false;
    const reader = {
      ...fx.reader,
      readIssue: async (...args: Parameters<typeof fx.reader.readIssue>) => {
        if (!interfered) {
          interfered = true;
          const limited = await prefetchMap(fx, sourceId, [810]);
          limited.set(810, {
            ...limited.get(810)!,
            issue: {
              kind: "unavailable",
              reason: "rate_limited",
              retryAfterSeconds: 600,
            },
          });
          const waiting = await fx.inTransaction((transaction) =>
            step(fx, index, sourceId, {
              deps: fx.operationDeps(transaction),
              prefetched: limited,
              limit: 10,
              now,
            })
          );
          assertEquals(waiting.outcome, "rate_limited");
          fx.reader.failNext("readIssue", {
            kind: "unavailable",
            reason: "forbidden",
            retryAfterSeconds: null,
          });
        }
        return await fx.reader.readIssue(...args);
      },
    };
    const poll = await step(fx, index, sourceId, {
      deps: { ...fx.automationDeps(), reader },
      limit: 1,
      now,
    });
    assert(
      interfered,
      "the interference ran between the poll's read and write",
    );
    assertEquals([poll.outcome, poll.health, poll.problemCode], [
      "auth_required",
      "auth_required",
      "auth_required",
    ]);
    const source = await sourceRow(fx, sourceId);
    assertEquals([
      source.sync_health,
      source.last_problem_code,
      source.sync_checkpoint?.notBefore,
    ], ["auth_required", "auth_required", "2026-09-02T12:10:00.000Z"]);

    // The wait is kept: nothing is read inside it, and a step after it clears both.
    fx.reader.clearCalls();
    const idle = await step(fx, index, sourceId, {
      now: new Date(now.getTime() + 60_000),
    });
    assertEquals([idle.outcome, fx.reader.calls], ["not_before", []]);
    const later = await step(fx, index, sourceId, {
      now: new Date(now.getTime() + 601_000),
    });
    assertEquals(later.outcome, "completed");
    const healed = await sourceRow(fx, sourceId);
    assertEquals([
      healed.sync_health,
      healed.last_problem_code,
      healed.sync_checkpoint?.notBefore,
    ], ["healthy", null, null]);
  }));

import { assert, assertEquals } from "@std/assert";
import {
  type PgDatabase,
  withPgTransaction,
} from "../../apps/server/src/platform/database.ts";

/**
 * Lock-order race helpers: a third transaction holds a row lock, two racers
 * queue behind it in a chosen order (detected through pg_locks, never a
 * sleep), then the hold is released. A wrong lock order surfaces as 40P01.
 */
export type Hold = { release(): void; done: Promise<void>; pid: number };

export async function holdRow(
  database: PgDatabase,
  sql: string,
  params: unknown[],
): Promise<Hold> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => release = resolve);
  let held!: () => void;
  const ready = new Promise<void>((resolve) => held = resolve);
  let pid = 0;
  const done = withPgTransaction(database, async (transaction) => {
    const locked = await transaction.query(sql, params);
    assertEquals(locked.rows.length, 1, "the hold locks one row");
    const backend = await transaction.query<{ pid: number }>(
      `select pg_backend_pid()::int as pid`,
    );
    pid = backend.rows[0].pid;
    held();
    await gate;
  });
  await Promise.race([ready, done]);
  return { release, done, pid };
}

/**
 * Counts sessions queued behind the hold: sessions blocked by the hold's
 * backend, directly or through another waiter ahead of them in the queue.
 * Unrelated waiters elsewhere in the cluster never count. Without a hold pid
 * it counts every ungranted lock in the cluster (legacy callers only).
 */
export async function lockWaiters(
  database: PgDatabase,
  holdPid?: number,
): Promise<number> {
  if (holdPid === undefined) {
    const result = await database.query<{ count: number }>(
      `select count(distinct pid)::int as count from pg_locks where not granted`,
    );
    return result.rows[0].count;
  }
  const result = await database.query<{ count: number }>(
    `with recursive queued(pid) as (
       select activity.pid
         from pg_stat_activity activity
        where pg_blocking_pids(activity.pid) @> array[$1::int]
       union
       select activity.pid
         from pg_stat_activity activity
         join queued on pg_blocking_pids(activity.pid) @> array[queued.pid]
     )
     select count(*)::int as count from queued`,
    [holdPid],
  );
  return result.rows[0].count;
}

export async function waitFor(
  label: string,
  ready: () => Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!(await ready())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export function settled(promise: Promise<unknown>): () => boolean {
  let done = false;
  promise.then(() => done = true, () => done = true);
  return () => done;
}

export function assertNoDeadlock(outcome: PromiseSettledResult<unknown>): void {
  if (outcome.status === "rejected") {
    const text = String(
      (outcome.reason as { cause?: unknown })?.cause ?? outcome.reason,
    );
    assert(!/40P01|deadlock/i.test(text), `deadlock: ${text}`);
  }
}

/**
 * Queues `first` behind `hold`, then `second` behind it, then releases. Each
 * racer must be observed queued behind the hold; a racer that finishes
 * without ever waiting makes the order proof vacuous and fails the race.
 */
export async function raceInOrder<A, B>(
  side: PgDatabase,
  hold: Hold,
  first: () => Promise<A>,
  second: () => Promise<B>,
): Promise<[PromiseSettledResult<A>, PromiseSettledResult<B>]> {
  assert(hold.pid > 0, "the hold must report its backend pid");
  const a = first();
  const aDone = settled(a);
  let aQueued = false;
  await waitFor("first racer queued", async () => {
    aQueued = await lockWaiters(side, hold.pid) >= 1;
    return aQueued || aDone();
  });
  assert(aQueued, "the first racer finished without waiting on the hold");
  const b = second();
  const bDone = settled(b);
  let bQueued = false;
  await waitFor("second racer queued", async () => {
    bQueued = await lockWaiters(side, hold.pid) >= 2;
    return bQueued || bDone();
  });
  assert(bQueued, "the second racer finished without waiting on the hold");
  hold.release();
  await hold.done;
  return await Promise.all([
    Promise.allSettled([a]).then(([r]) => r),
    Promise.allSettled([b]).then(([r]) => r),
  ]);
}

/** Runs `claim` and `other` in the given order and returns their outcomes as [claim, other]. */
export async function raceClaim<C, O>(
  side: PgDatabase,
  hold: Hold,
  order: "claim-first" | "other-first",
  claim: () => Promise<C>,
  other: () => Promise<O>,
): Promise<[PromiseSettledResult<C>, PromiseSettledResult<O>]> {
  if (order === "claim-first") {
    return await raceInOrder(side, hold, claim, other);
  }
  const [o, c] = await raceInOrder(side, hold, other, claim);
  return [c, o];
}

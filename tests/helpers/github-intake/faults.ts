import type { PgDatabase } from "../../../apps/server/src/platform/database.ts";

/** Faults and waits the issue 71 integration tests inject around a step or a route. */

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Polls until `condition` holds; code that never reaches it fails the test. */
export async function waitUntil(
  condition: () => Promise<boolean>,
  what: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!await condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

/**
 * Resolves with the value of `work`, or with `"waited"` when it is still
 * pending after `ms`. The timer is cleared, so a test that gets either answer
 * leaves no timer behind. The caller still owns `work` and must let it end.
 */
export async function settlesWithin<T>(
  ms: number,
  work: Promise<T>,
): Promise<{ value: T } | "waited"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<"waited">((resolve) => {
    timer = setTimeout(() => resolve("waited"), ms);
  });
  try {
    return await Promise.race([work.then((value) => ({ value })), waited]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A pool whose `failOn`-th connection attempts (counted from 1) fail, as a
 * dropped database connection would. Queries that go through the pool without
 * asking for a connection, `pool.query`, are not counted and never fail.
 */
export function flakyDatabase(
  pool: PgDatabase,
  failOn: number | readonly number[],
): PgDatabase {
  const failing = new Set(typeof failOn === "number" ? [failOn] : failOn);
  let attempts = 0;
  return new Proxy(pool, {
    get(target, property) {
      if (property === "connect") {
        return (...args: unknown[]) => {
          attempts += 1;
          return failing.has(attempts)
            ? Promise.reject(new Error("injected connection failure"))
            : Reflect.apply(target.connect, target, args);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * A pool whose `nth` pooled `query` matching `pattern` (counted from 1) first
 * runs `before`, so a test can change the database right before a statement
 * the code under test issues, such as the recheck ahead of a request.
 */
export function beforeQuery(
  pool: PgDatabase,
  pattern: RegExp,
  nth: number,
  before: () => Promise<unknown>,
): PgDatabase {
  let seen = 0;
  return new Proxy(pool, {
    get(target, property) {
      if (property === "query") {
        return async (...args: unknown[]) => {
          const text = typeof args[0] === "string" ? args[0] : "";
          if (pattern.test(text)) {
            seen += 1;
            if (seen === nth) await before();
          }
          return await Reflect.apply(target.query, target, args);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * A pool whose `nth` pooled `query` matching `pattern` (counted from 1) is
 * rejected with a database shutdown error (SQLSTATE 57P01), as a dropped
 * connection would. Every other query goes through, so a test can fail one
 * batch of a loop and look at what the batches around it left.
 */
export function failingQuery(
  pool: PgDatabase,
  pattern: RegExp,
  nth: number,
): PgDatabase {
  let seen = 0;
  return new Proxy(pool, {
    get(target, property) {
      if (property === "query") {
        return (...args: unknown[]) => {
          const text = typeof args[0] === "string" ? args[0] : "";
          if (pattern.test(text)) {
            seen += 1;
            if (seen === nth) {
              return Promise.reject(
                Object.assign(new Error("terminating connection"), {
                  code: "57P01",
                }),
              );
            }
          }
          return Reflect.apply(target.query, target, args);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

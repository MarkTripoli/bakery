import { assertEquals, assertRejects } from "@std/assert";
import type { PgDatabase } from "../../packages/persistence/src/postgres.ts";
import { recordPgFaults } from "../helpers/pg-faults.ts";

function failure(message: string, code?: string): Error {
  return Object.assign(new Error(message), code === undefined ? {} : { code });
}

function pool(options: { connect?: Error; query?: Error }): PgDatabase {
  const client = {
    released: false,
    query: () =>
      options.query ? Promise.reject(options.query) : Promise.resolve("rows"),
    release() {
      this.released = true;
    },
  };
  return {
    totalCount: 2,
    connect() {
      return options.connect
        ? Promise.reject(options.connect)
        : Promise.resolve(client);
    },
  } as unknown as PgDatabase;
}

Deno.test("recordPgFaults keeps the connect failure a pool wait raised", async () => {
  const recorded = recordPgFaults(
    pool({ connect: failure("timeout exceeded when trying to connect") }),
  );
  await assertRejects(
    () => recorded.database.connect(),
    Error,
    "timeout exceeded when trying to connect",
  );
  assertEquals(recorded.faults, [
    "connect - timeout exceeded when trying to connect",
  ]);
});

Deno.test("recordPgFaults keeps a cut connection's code and still rethrows it", async () => {
  const recorded = recordPgFaults(
    pool({
      query: failure(
        "terminating connection due to administrator command",
        "57P01",
      ),
    }),
  );
  const client = await recorded.database.connect();
  await assertRejects(
    () => client.query("select 1"),
    Error,
    "terminating connection",
  );
  assertEquals(recorded.faults, [
    "query 57P01 terminating connection due to administrator command",
  ]);
  client.release();
  assertEquals((client as unknown as { released: boolean }).released, true);
});

Deno.test("recordPgFaults ignores errors a worker route does not turn into 503", async () => {
  const recorded = recordPgFaults(
    pool({ query: failure('syntax error at or near "selec"', "42601") }),
  );
  const client = await recorded.database.connect();
  await assertRejects(() => client.query("selec 1"), Error, "syntax error");
  assertEquals(recorded.faults, []);
  assertEquals(recorded.database.totalCount, 2);
});

Deno.test("recordPgFaults passes the callback form of connect straight through", () => {
  const seen: unknown[][] = [];
  const recorded = recordPgFaults({
    connect: (...args: unknown[]) => {
      seen.push(args);
      return "from the pool";
    },
  } as unknown as PgDatabase);
  const callback = () => undefined;
  const connect = recorded.database.connect as unknown as (
    callback: () => void,
  ) => unknown;
  assertEquals(connect(callback) instanceof Promise, true);
  assertEquals(seen, [[callback]]);
  assertEquals(recorded.faults, []);
});

Deno.test("recordPgFaults returns a query that is not a promise unchanged", async () => {
  const recorded = recordPgFaults({
    connect: () => Promise.resolve({ query: () => "queued without a promise" }),
  } as unknown as PgDatabase);
  const client = await recorded.database.connect();
  assertEquals(
    (client.query as unknown as () => unknown)(),
    "queued without a promise",
  );
  assertEquals(recorded.faults, []);
});

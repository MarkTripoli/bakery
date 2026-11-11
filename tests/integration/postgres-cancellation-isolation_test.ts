import { assert, assertEquals } from "@std/assert";
import {
  closePgDatabase,
  openPgDatabase,
  withPgTransaction,
} from "../../packages/persistence/src/postgres.ts";
import { createSuperuser } from "../../apps/server/src/modules/auth/index.ts";
import {
  authRequest,
  authTestOrigin,
  openAuthFixture,
  sessionCookie,
} from "../helpers/auth.ts";
import { upPostgresStack } from "../e2e/helpers/stack.ts";

async function waitFor(check: () => Promise<boolean>) {
  const deadline = performance.now() + 5_000;
  while (!await check()) {
    assert(
      performance.now() < deadline,
      "owned PostgreSQL barrier not reached",
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

type PoolClient = {
  query(queryText: string): Promise<unknown>;
  release(): void;
};

type CancelConnection = {
  cancel(processId: number, secretKey: number): void;
  once(event: "end", listener: () => void): void;
  end(): void;
};

type CancelClient = {
  cancel(client: unknown, query: unknown): void;
  connection: CancelConnection;
};

type CancelClientConstructor = {
  prototype: CancelClient;
};

Deno.test("a late canceled request cannot cancel the next mounted organizations read", async () => {
  const stack = await upPostgresStack("cancel-isolation");
  const observer = openPgDatabase(stack.adminDatabaseUrl, 1);
  let fixture: Awaited<ReturnType<typeof openAuthFixture>> | undefined;
  let blocker: PoolClient | undefined;
  let sendCancel: (() => void) | undefined;
  let cancelConnection: CancelConnection | undefined;
  let cancelPrototype: CancelClient | undefined;
  let originalCancel: CancelClient["cancel"] | undefined;
  let nextRequest: Promise<Response> | undefined;
  try {
    fixture = await openAuthFixture({
      databaseConfig: {
        databaseUrl: stack.ownerDatabaseUrl,
        appDatabaseUrl: stack.appDatabaseUrl,
      },
    });
    const ownedRealPgClient = await fixture.runtimePgDatabase.connect();
    const runtimePrototype =
      (ownedRealPgClient.constructor as unknown as CancelClientConstructor)
        .prototype;
    const originalCancelMethod = runtimePrototype.cancel;
    cancelPrototype = runtimePrototype;
    originalCancel = originalCancelMethod;
    ownedRealPgClient.release();
    // One real backend makes reuse deterministic, not dependent on pool scheduling.
    fixture.runtimePgDatabase.options.max = 1;
    const suffix = crypto.randomUUID();
    const email = `cancel-isolation-${suffix}@example.test`;
    const password = `Cancel-Isolation-${suffix}`;
    await createSuperuser({
      pgDatabase: fixture.pgDatabase,
      config: fixture.config.auth!,
    }, { email, displayName: "Cancellation isolation", password });
    const signIn = await fixture.app.fetch(
      authRequest("/api/auth/sign-in/email", { email, password }),
    );
    assertEquals(signIn.status, 200);
    const cookie = sessionCookie(signIn);
    assertEquals(
      (await fixture.runtimePgDatabase.query("select current_user as role"))
        .rows[0].role,
      "bakery_app",
    );

    // Delay only the real CancelRequest packet, as a slow second connection can.
    // The original query/result, rollback, pool and HTTP handler are unmodified.
    runtimePrototype.cancel = function (
      this: CancelClient,
      client,
      query,
    ) {
      const connection = this.connection;
      const originalSend = connection.cancel;
      cancelConnection = connection;
      connection.cancel = (processId: number, secretKey: number) => {
        sendCancel = () => originalSend.call(connection, processId, secretKey);
      };
      originalCancelMethod.call(this, client, query);
    };
    const abort = new AbortController();
    let firstPid = 0;
    const prior = withPgTransaction(fixture.runtimePgDatabase, async (tx) => {
      firstPid =
        (await tx.query<{ pid: number }>("select pg_backend_pid() as pid"))
          .rows[0].pid;
      await tx.query("select pg_sleep(0.5)");
    }, abort.signal).then(
      () => new Error("aborted transaction unexpectedly committed"),
      (error: unknown) => error,
    );
    await waitFor(async () => {
      const state = await observer.query(
        "select 1 from pg_stat_activity where pid = $1 and wait_event = 'PgSleep'",
        [firstPid],
      );
      return state.rowCount === 1;
    });
    abort.abort();
    await waitFor(() => Promise.resolve(sendCancel !== undefined));
    const priorError = await prior;
    assert(priorError instanceof DOMException);
    assertEquals(priorError.name, "AbortError");
    runtimePrototype.cancel = originalCancelMethod;

    blocker = await fixture.pgDatabase.connect();
    await blocker.query("begin");
    await blocker.query(
      "lock table bakery.organizations in access exclusive mode",
    );
    nextRequest = Promise.resolve(fixture.app.fetch(
      new Request(
        `${authTestOrigin}/v1/organizations`,
        { headers: { cookie } },
      ),
    ));
    // Hold the real consumer query until the delayed packet reaches PostgreSQL.
    await waitFor(async () => {
      const state = await observer.query(
        `select 1 from pg_stat_activity
         where usename = 'bakery_app' and datname = current_database()
           and state = 'active' and wait_event_type = 'Lock'`,
      );
      return state.rowCount === 1;
    });
    assert(cancelConnection);
    const cancelClosed = new Promise<void>((resolve) => {
      cancelConnection!.once("end", resolve);
    });
    assert(sendCancel);
    sendCancel();
    await cancelClosed;
    await blocker.query("rollback");
    blocker.release();
    blocker = undefined;
    const response = await nextRequest;
    const body = await response.json();
    assertEquals(response.status, 200, JSON.stringify(body));
    assert(body.items.length > 0, "authenticated organizations remain visible");
    console.log("LATE_CANCEL_ORGANIZATIONS_READ=200");
  } finally {
    if (cancelPrototype && originalCancel) {
      cancelPrototype.cancel = originalCancel;
    }
    cancelConnection?.end();
    if (blocker) {
      try {
        await blocker.query("rollback");
      } finally {
        blocker.release();
      }
    }
    await nextRequest?.catch(() => {});
    await fixture?.close();
    await closePgDatabase(observer);
    await stack.down();
  }
});

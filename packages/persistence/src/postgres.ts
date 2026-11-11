import {
  Client,
  Pool,
  type PoolClient,
  type Query,
  type QueryConfig,
  type QueryResult,
  type QueryResultRow,
} from "pg";
import postgres from "postgres";

export type Database = postgres.Sql;
export type PgDatabase = Pool;
export type PgTransactionClient = {
  query<R extends QueryResultRow = QueryResultRow>(
    queryTextOrConfig: string | QueryConfig<unknown[]>,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
};

type CancelablePgClient = PoolClient & {
  _getActiveQuery?: () => Query | null;
};

type PgCancelClient = Client & {
  cancel?: (client: PoolClient, query: Query) => void;
};

function cancelQuery(client: PoolClient, query: Query): void {
  const cancelClient = new Client({
    user: client.user,
    database: client.database,
    host: client.host,
    port: client.port,
    password: client.password,
    ssl: client.ssl,
  });
  cancelClient.connection.on("error", () => {});
  const cancel = (cancelClient as unknown as PgCancelClient).cancel;
  if (typeof cancel === "function") cancel.call(cancelClient, client, query);
}

function abortError(): DOMException {
  return new DOMException("Action aborted", "AbortError");
}

function queryWithAbort<R extends QueryResultRow>(
  client: PoolClient,
  queryTextOrConfig: string | QueryConfig<unknown[]>,
  values: unknown[] | undefined,
  signal: AbortSignal,
): Promise<QueryResult<R>> {
  if (signal.aborted) return Promise.reject(abortError());
  const cancelable = client as CancelablePgClient;
  let cancelSent = false;
  const cancelActiveQuery = () => {
    if (cancelSent) return;
    if (typeof cancelable._getActiveQuery !== "function") return;
    const activeQuery = cancelable._getActiveQuery();
    if (!activeQuery) return;
    cancelSent = true;
    cancelQuery(client, activeQuery);
  };
  const onAbort = () => cancelActiveQuery();
  signal.addEventListener("abort", onAbort, { once: true });
  let pending: Promise<QueryResult<R>>;
  try {
    pending = values === undefined
      ? client.query<R>(queryTextOrConfig)
      : client.query<R, unknown[]>(queryTextOrConfig, values);
    if (signal.aborted) cancelActiveQuery();
  } catch (error) {
    signal.removeEventListener("abort", onAbort);
    throw error;
  }
  return Promise.resolve(pending).finally(() => {
    signal.removeEventListener("abort", onAbort);
  });
}

function abortableTransactionClient(
  client: PoolClient,
  signal: AbortSignal | undefined,
): PgTransactionClient {
  return {
    query<R extends QueryResultRow = QueryResultRow>(
      queryTextOrConfig: string | QueryConfig<unknown[]>,
      values?: unknown[],
    ): Promise<QueryResult<R>> {
      if (!signal) {
        return values === undefined
          ? client.query<R>(queryTextOrConfig)
          : client.query<R, unknown[]>(queryTextOrConfig, values);
      }
      return queryWithAbort(client, queryTextOrConfig, values, signal);
    },
  };
}

export function openDatabase(url: string, max = 4): Database {
  return postgres(url, {
    max,
    idle_timeout: 20,
    connect_timeout: 5,
    onnotice: () => {},
  });
}

export function openPgDatabase(url: string, max = 4): PgDatabase {
  return new Pool({
    connectionString: url,
    max,
    idleTimeoutMillis: 20_000,
    connectionTimeoutMillis: 5_000,
    options: "-c search_path=public",
  });
}

const PG_CONNECTION_SQLSTATE = /^(08[0-9A-Z]{3}|57P0[123])$/;
const PG_CONNECTION_ERRNO = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
]);
const PG_CONNECTION_MESSAGES = [
  "Connection terminated",
  "Client has encountered a connection error and is not queryable",
  "timeout exceeded when trying to connect",
];
const PG_CONNECTION_CAUSE_DEPTH = 3;

/**
 * True when `error` (or a cause up to three levels deep) says the database
 * connection failed or was cut: SQLSTATE class 08 or an administrator shutdown
 * (57P01-57P03), a socket errno, or one of the node-postgres connection
 * messages. That is a dependency outage, not an internal fault. Serialization
 * and deadlock failures (40001, 40P01) are not connection failures; the
 * coordinator retry owns them.
 */
export function isPgConnectionFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < PG_CONNECTION_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== "object" || current === null) return false;
    const code = (current as { code?: unknown }).code;
    if (
      typeof code === "string" &&
      (PG_CONNECTION_SQLSTATE.test(code) || PG_CONNECTION_ERRNO.has(code))
    ) return true;
    const message = (current as { message?: unknown }).message;
    if (
      typeof message === "string" &&
      PG_CONNECTION_MESSAGES.some((fragment) => message.includes(fragment))
    ) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export async function withPgTransaction<T>(
  database: PgDatabase,
  work: (client: PgTransactionClient) => Promise<T>,
  signal?: AbortSignal,
  isolation: "read committed" | "repeatable read" = "read committed",
): Promise<T> {
  const client = await database.connect();
  const transaction = abortableTransactionClient(client, signal);
  let started = false;
  let releaseError: Error | undefined;
  try {
    await transaction.query(`begin isolation level ${isolation}`);
    started = true;
    const result = await work(transaction);
    if (signal?.aborted) throw abortError();
    await client.query("commit");
    return result;
  } catch (error) {
    if (started) {
      try {
        await client.query("rollback");
      } catch (rollbackError) {
        releaseError = rollbackError instanceof Error
          ? rollbackError
          : new Error(String(rollbackError));
      }
    }
    throw error;
  } finally {
    // CancelRequest travels on a separate connection and may arrive after the
    // original query/rollback settles. Never lend that backend to a new request.
    if (signal?.aborted) releaseError ??= abortError();
    client.release(releaseError);
  }
}

export async function closeDatabase(db: Database): Promise<void> {
  await db.end({ timeout: 5 });
}

export async function closePgDatabase(db: PgDatabase): Promise<void> {
  await db.end();
}

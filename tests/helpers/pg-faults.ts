import {
  isPgConnectionFailure,
  type PgDatabase,
} from "../../packages/persistence/src/postgres.ts";

export type PgFaults = Readonly<{
  /** Pool to hand to the code under test; it behaves exactly like `database`. */
  database: PgDatabase;
  /** Connection failures its transactions hit, oldest first: what a worker route answers 503 for. */
  faults: readonly string[];
}>;

/**
 * Wraps `database` so a connect or query failure that a worker route turns into
 * a 503 DEPENDENCY_UNAVAILABLE leaves its own code and message behind. The
 * problem body names only the dependency, never the pg error under it.
 */
export function recordPgFaults(database: PgDatabase): PgFaults {
  const faults: string[] = [];
  const record = (where: string, error: unknown): never => {
    if (isPgConnectionFailure(error)) {
      const { code, message } = error as { code?: unknown; message?: unknown };
      faults.push(`${where} ${String(code ?? "-")} ${String(message)}`);
    }
    throw error;
  };
  const recorded = new Proxy(database, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (property !== "connect") return value.bind(target);
      return async (...args: unknown[]) => {
        // The callback form carries its own error path; transactions use this one.
        if (args.length > 0) return value.apply(target, args);
        const client = await value.call(target).catch((error: unknown) =>
          record("connect", error)
        );
        return new Proxy(client, {
          get(connected, clientProperty) {
            const member = Reflect.get(connected, clientProperty, connected);
            if (typeof member !== "function") return member;
            if (clientProperty !== "query") return member.bind(connected);
            return (...queryArgs: unknown[]) => {
              const pending = member.apply(connected, queryArgs);
              return pending instanceof Promise
                ? pending.catch((error: unknown) => record("query", error))
                : pending;
            };
          },
        });
      };
    },
  });
  return { database: recorded, faults };
}

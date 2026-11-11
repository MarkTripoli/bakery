/** Postgres SQLSTATE for a unique-constraint violation. */
export const POSTGRES_UNIQUE_VIOLATION = "23505";

/** Reads `.code` off an unknown thrown value without asserting its shape. */
export function postgresErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const { code } = error;
  return typeof code === "string" ? code : undefined;
}

/** Reads `.cause` off an unknown thrown value without asserting its shape. */
function errorCause(error: unknown): unknown {
  if (typeof error !== "object" || error === null || !("cause" in error)) {
    return undefined;
  }
  return error.cause;
}

/**
 * Walks `.cause` chains (kysely/pg wrap the driver error) looking for a
 * Postgres unique-violation. Only this specific, identified failure means
 * "the code was already accepted or is in flight"; anything else (a
 * connection drop, a genuine adapter bug) must surface as a 500, not be
 * silently reinterpreted as a wrong code.
 */
export function isPostgresUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current !== undefined; depth++) {
    if (postgresErrorCode(current) === POSTGRES_UNIQUE_VIOLATION) return true;
    current = errorCause(current);
  }
  return false;
}

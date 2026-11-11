import type { QueryClient } from "@tanstack/react-query";

// Deno resolves a bare npm specifier relative to the *importing file's* own
// node_modules, so `tests/unit/*.ts` (outside apps/web) cannot name
// `@tanstack/react-query` directly. Re-exporting the class value here — from
// a module that already depends on it — gives those unit tests a real
// `QueryClient` without adding a second, hand-rolled fake for it.
export { QueryClient } from "@tanstack/react-query";

/**
 * Opaque, per-tab identity for protected (Authenticated/Developer) API queries.
 * No credential ever enters a cache key: `sessionGeneration` is a local counter
 * and `organizationId` is a non-secret identifier.
 */
export type ProtectedScope = Readonly<{
  sessionGeneration: number;
  organizationId: string | null;
}>;

export function protectedQueryKey(
  scope: ProtectedScope,
  operationId: string,
  normalizedInput: Readonly<Record<string, unknown>>,
) {
  return [
    "protected",
    scope.sessionGeneration,
    scope.organizationId ?? "none",
    operationId,
    normalizedInput,
  ] as const;
}

function scopePrefix(scope: ProtectedScope) {
  return ["protected", scope.sessionGeneration] as const;
}

/**
 * Increments the session generation and drops the previous generation's
 * protected cache whenever organization identity changes, so a switched tenant
 * can never render from another tenant's cached data.
 */
export class QueryScopeController {
  #scope: ProtectedScope = { sessionGeneration: 0, organizationId: null };
  readonly #queryClient: QueryClient;
  readonly #listeners = new Set<() => void>();

  constructor(queryClient: QueryClient) {
    this.#queryClient = queryClient;
  }

  readonly subscribe = (listener: () => void): () => void => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): ProtectedScope => this.#scope;

  setIdentity(organizationId: string | null): ProtectedScope {
    if (organizationId === this.#scope.organizationId) return this.#scope;
    const prior = this.#scope;
    this.#scope = {
      sessionGeneration: prior.sessionGeneration + 1,
      organizationId,
    };
    void this.#queryClient.cancelQueries({ queryKey: scopePrefix(prior) });
    this.#queryClient.removeQueries({ queryKey: scopePrefix(prior) });
    for (const listener of this.#listeners) listener();
    return this.#scope;
  }

  /**
   * Unconditionally advances the session generation and clears the *entire*
   * protected cache — every generation, not just the one being left —
   * independent of organization identity. `setIdentity` short-circuits on an
   * equal organization id, which sign-out must not: the next sign-in can
   * reuse the same organization id yet must never see the prior session's
   * cached data, and no future generation may survive a sign-out either.
   */
  reset(): ProtectedScope {
    const prior = this.#scope;
    this.#scope = {
      sessionGeneration: prior.sessionGeneration + 1,
      organizationId: null,
    };
    void this.#queryClient.cancelQueries({ queryKey: ["protected"] });
    this.#queryClient.removeQueries({ queryKey: ["protected"] });
    for (const listener of this.#listeners) listener();
    return this.#scope;
  }
}

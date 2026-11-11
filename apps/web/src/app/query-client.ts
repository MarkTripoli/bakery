import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryObserver,
  shouldThrowError,
} from "@tanstack/react-query";
import { operationFor, reportsFailure } from "./failure-attribution.ts";

/** One handled data-layer failure, named by the operation that produced it. */
export type ReportedFailure = {
  readonly source: "query" | "mutation";
  readonly operation: string;
  readonly error: unknown;
};

/**
 * Root unit tests cannot name the query library themselves, because Deno
 * resolves a bare specifier against the importing file's own node_modules;
 * this module reads it from inside `apps/web`.
 */
export { QueryObserver };

/**
 * Builds the application query client, forwarding every failure it resolves
 * into a state. Only an observer that actually rethrows this error keeps its
 * own channel to Sentry through the root error handlers, so a predicate that
 * declines the error still reports from here.
 */
export function createReportedQueryClient(
  report: (failure: ReportedFailure) => void,
): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => {
        if (!reportsFailure(query.meta)) return;
        if (
          query.observers.some((observer) =>
            shouldThrowError(observer.options.throwOnError, [error, query])
          )
        ) return;
        report({
          source: "query",
          operation: operationFor(query.queryKey),
          error,
        });
      },
    }),
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) => {
        if (!reportsFailure(mutation.meta)) return;
        report({
          source: "mutation",
          operation: operationFor(mutation.options.mutationKey ?? []),
          error,
        });
      },
    }),
    defaultOptions: {
      queries: { staleTime: 15_000 },
      mutations: { retry: false },
    },
  });
}

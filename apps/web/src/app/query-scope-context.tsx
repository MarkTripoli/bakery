import {
  createContext,
  type ReactNode,
  useContext,
  useMemo,
  useSyncExternalStore,
} from "react";
import type { QueryClient } from "@tanstack/react-query";
import { type ProtectedScope, QueryScopeController } from "./query-scope.ts";

const QueryScopeContext = createContext<QueryScopeController | null>(null);

export function QueryScopeProvider(
  { children, queryClient }: {
    readonly children: ReactNode;
    readonly queryClient: QueryClient;
  },
) {
  const controller = useMemo(
    () => new QueryScopeController(queryClient),
    [queryClient],
  );
  return (
    <QueryScopeContext.Provider value={controller}>
      {children}
    </QueryScopeContext.Provider>
  );
}

export function useQueryScopeController(): QueryScopeController {
  const controller = useContext(QueryScopeContext);
  if (!controller) throw new Error("QUERY_SCOPE_PROVIDER_MISSING");
  return controller;
}

export function useProtectedScope(): ProtectedScope {
  const controller = useQueryScopeController();
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot);
}

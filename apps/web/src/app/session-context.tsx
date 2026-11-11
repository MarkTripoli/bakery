import {
  createContext,
  type ReactNode,
  useContext,
  useMemo,
  useSyncExternalStore,
} from "react";
import type { BakeryApiClient } from "../api/client.ts";
import { useQueryScopeController } from "./query-scope-context.tsx";
import { SessionController, type SessionSnapshot } from "./session.ts";

const SessionContext = createContext<SessionController | null>(null);

export function SessionProvider(
  { children, api }: {
    readonly children: ReactNode;
    readonly api: BakeryApiClient;
  },
) {
  const queryScope = useQueryScopeController();
  const controller = useMemo(
    () => new SessionController(api, queryScope),
    [api, queryScope],
  );
  return (
    <SessionContext.Provider value={controller}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSessionController(): SessionController {
  const controller = useContext(SessionContext);
  if (!controller) throw new Error("SESSION_PROVIDER_MISSING");
  return controller;
}

export function useSession(): SessionSnapshot {
  const controller = useSessionController();
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot);
}

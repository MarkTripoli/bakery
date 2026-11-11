import { createContext, type ReactNode, useContext } from "react";
import type { BakeryApiClient } from "./client.ts";

const ApiContext = createContext<BakeryApiClient | null>(null);

export function ApiProvider({
  children,
  client,
}: {
  readonly children: ReactNode;
  readonly client: BakeryApiClient;
}) {
  return <ApiContext.Provider value={client}>{children}</ApiContext.Provider>;
}

export function useBakeryApi(): BakeryApiClient {
  const client = useContext(ApiContext);
  if (!client) throw new Error("useBakeryApi must be used within ApiProvider");
  return client;
}

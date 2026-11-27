import { useRef, useState } from "react";
import { useBakeryApi } from "../../../api/context.tsx";
import { useProtectedScope } from "../../../app/query-scope-context.tsx";
import { type ConnectStatus, problemReason } from "../connect.ts";
import type { ConnectOptions } from "./github/use-github-connect.ts";

export type OAuthProvider = "slack";

export function useOAuthConnect(
  { organizationId, provider }: {
    readonly organizationId: string | null;
    readonly provider: OAuthProvider;
  },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const generation = useRef(scope.sessionGeneration);
  generation.current = scope.sessionGeneration;
  const [connectStatus, setConnectStatus] = useState<ConnectStatus>("idle");
  const connecting = useRef(false);
  const connect = async (options: ConnectOptions = {}) => {
    if (organizationId === null || connecting.current) return;
    connecting.current = true;
    try {
      setConnectStatus("starting");
      const started = scope.sessionGeneration;
      const result = await api.integrationAuthAttempts.create({
        ...options,
        provider,
        organizationId,
        idempotencyKey: crypto.randomUUID(),
      });
      if (started !== generation.current) return;
      if (!result.ok) {
        setConnectStatus(
          problemReason(result.error) === "provider_unregistered"
            ? "unregistered"
            : "failed",
        );
        return;
      }
      setConnectStatus("redirecting");
      globalThis.location.assign(result.data.authorizationUrl);
    } finally {
      connecting.current = false;
    }
  };
  return { connect, connectStatus };
}

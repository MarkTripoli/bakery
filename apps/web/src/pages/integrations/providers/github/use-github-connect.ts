import { useEffect, useRef, useState } from "react";
import { useBakeryApi } from "../../../../api/context.tsx";
import {
  clearGitHubConnectHandoff,
  saveGitHubConnectHandoff,
  takeGitHubConnectUrl,
} from "../../../../app/github-connect-handoff.ts";
import { useProtectedScope } from "../../../../app/query-scope-context.tsx";
import { type ConnectStatus, problemReason } from "../../connect.ts";
import type { ConnectionOutcome } from "../../outcomes.ts";

/** What a connect or reconnect starts with. */
export type ConnectOptions = {
  /** Refresh this connection's access instead of adding a new one. */
  readonly reconnectConnectionId?: string;
  /** The in-app path GitHub's setup returns to. */
  readonly returnPath?: string;
};

/** Leaves the page for github.com; replaced so Back skips the spent hop. */
function leaveForGitHub(url: string) {
  globalThis.location.replace(url);
}

/**
 * Starting a GitHub connection (or reconnecting one) and carrying it through
 * GitHub's two steps. A redirect that stops half way continues to the other
 * step on its own, install first then authorize (or the reverse), never by
 * hand; that continuation runs on whichever page the callback returns to.
 */
export function useGitHubConnect(
  { organizationId, outcome }: {
    readonly organizationId: string | null;
    readonly outcome: ConnectionOutcome | null;
  },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  // The live session generation, read after an await: `scope` itself is the
  // render's snapshot and never changes under a pending request.
  const generation = useRef(scope.sessionGeneration);
  generation.current = scope.sessionGeneration;

  const [continuing, setContinuing] = useState(false);
  const continued = useRef(false);
  useEffect(() => {
    if (organizationId === null || continued.current) return;
    if (
      outcome !== "awaiting_authorization" &&
      outcome !== "awaiting_installation"
    ) {
      // Any other outcome ends the attempt; its links are useless now.
      if (outcome !== null) clearGitHubConnectHandoff();
      return;
    }
    continued.current = true;
    const next = takeGitHubConnectUrl(
      organizationId,
      outcome === "awaiting_authorization"
        ? "authorizationUrl"
        : "installationUrl",
    );
    if (next === null) return;
    setContinuing(true);
    leaveForGitHub(next);
  }, [organizationId, outcome]);

  const [connectStatus, setConnectStatus] = useState<ConnectStatus>("idle");
  const connecting = useRef(false);
  const connect = async (options: ConnectOptions = {}) => {
    if (organizationId === null || connecting.current) return;
    connecting.current = true;
    try {
      setConnectStatus("starting");
      clearGitHubConnectHandoff();
      const started = scope.sessionGeneration;
      const result = await api.integrationAuthAttempts.create({
        organizationId,
        idempotencyKey: crypto.randomUUID(),
        ...(options.reconnectConnectionId === undefined
          ? {}
          : { reconnectConnectionId: options.reconnectConnectionId }),
        ...(options.returnPath === undefined
          ? {}
          : { returnPath: options.returnPath }),
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
      const { authorizationUrl, installationUrl, expiresAt } = result.data;
      // Install first: GitHub hands the state to the Setup URL, and the page
      // continues to authorization when the setup redirect lands here. The
      // install link is kept for an OAuth callback that still finds no
      // installation (`awaiting_installation`).
      const saved = saveGitHubConnectHandoff({
        organizationId,
        expiresAt,
        authorizationUrl,
        installationUrl: installationUrl ?? null,
      });
      if (!installationUrl || !saved) {
        setConnectStatus(saved ? "failed" : "storageUnavailable");
        if (saved) clearGitHubConnectHandoff();
        return;
      }
      setConnectStatus("redirecting");
      leaveForGitHub(installationUrl);
    } finally {
      connecting.current = false;
    }
  };

  const busy = connectStatus === "starting" ||
    connectStatus === "redirecting" || continuing;
  return { busy, connect, connectStatus, continuing };
}

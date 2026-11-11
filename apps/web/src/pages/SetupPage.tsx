import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useBakeryApi } from "../api/context.tsx";
import { installationStatusQueryOptions } from "../api/query.ts";
import { SIGN_IN_PATH } from "../app/auth-required.tsx";
import { reset as resetInstallationStatusCache } from "../app/installation-status-cache.ts";
import { SetupScreen } from "../screens/SetupScreen.tsx";

/**
 * `/setup`: `bootstrapped=false` shows the CLI bootstrap instructions
 * (`default`); the query itself polls until it flips (see
 * `installationStatusQueryOptions`), so there is no manual "check again"
 * affordance, matching the Paper artboard. `bootstrapped=true` shows a
 * `ready` confirmation with an explicit "Continue to sign in" instead of
 * redirecting away immediately — resetting the root route's own
 * `installationStatus` memo first, so that navigation's `beforeLoad`
 * re-fetches fresh rather than replaying the stale pre-bootstrap cache. A
 * query failure renders `unavailable` — the same interstitial the sign-in
 * family shows for an unreachable authentication service — with a retry that
 * probes the installation status again.
 */
export function SetupPage() {
  const client = useBakeryApi();
  const navigate = useNavigate();
  const status = useQuery(installationStatusQueryOptions(client));
  const bootstrapped = status.data?.bootstrapped ?? null;

  useEffect(() => {
    if (bootstrapped === true) resetInstallationStatusCache();
  }, [bootstrapped]);

  return (
    <SetupScreen
      onContinue={() => void navigate({ to: SIGN_IN_PATH })}
      onRetry={() => void status.refetch()}
      state={status.isPending
        ? "probing"
        : status.isError
        ? "unavailable"
        : bootstrapped === true
        ? "ready"
        : "default"}
    />
  );
}

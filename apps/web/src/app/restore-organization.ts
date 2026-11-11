import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useBakeryApi } from "../api/context.tsx";
import { ORGANIZATIONS_PATH } from "./auth-paths.ts";
import { rememberDestination } from "./auth-return.ts";
import * as organizationSelection from "./organization-selection.ts";
import {
  useProtectedScope,
  useQueryScopeController,
} from "./query-scope-context.tsx";

/**
 * What a page learns from {@link useRestoreOrganizationScope}.
 *
 * `failure` is the rejection of the latest organization lookup, in the shape
 * `BakeryApiClient` reports it (a `problem`, `network` or `invalid-response`
 * failure), or `null` while no lookup has failed. It never carries an
 * aborted lookup or one superseded by a scope change: those are the effect
 * restarting or another restore winning, not an outage. `retry` runs the
 * lookup again.
 */
export interface OrganizationScopeRestore {
  readonly failure: unknown;
  readonly retry: () => void;
}

/**
 * For a page that needs an organization: a reload leaves the protected scope
 * empty, so restore the remembered one (or the only one the person has), and
 * send a person who has to choose to `/organizations` with this page as the
 * way back. `{ redirect: false }` restores quietly and never navigates (shell
 * chrome); `enabled: false` skips the restore on screens that own selection.
 *
 * A real lookup failure (outage, forbidden, bad response) is returned as
 * `failure` so a page can say so instead of loading forever; an abort or a
 * lookup superseded by a scope change stays silent and is never an unhandled
 * rejection.
 */
export function useRestoreOrganizationScope(
  options: { readonly redirect?: boolean; readonly enabled?: boolean } = {},
): OrganizationScopeRestore {
  const { redirect = true, enabled = true } = options;
  const scope = useProtectedScope();
  const controller = useQueryScopeController();
  const api = useBakeryApi();
  const navigate = useNavigate();
  const location = useRouterState({ select: (state) => state.location });
  // The router publishes a new `location` object on every load, including the
  // pending one `navigate` below starts. Depending on that object made each
  // navigation re-run this effect, which resolved again, chose again and
  // navigated again, cancelling its own load in an unbounded
  // `/v1/me` + `/v1/organizations` loop. The latest location is read through
  // a ref and the effect restarts only for a different page (`href`).
  const [failure, setFailure] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((count) => count + 1), []);
  const locationRef = useRef(location);
  locationRef.current = location;
  const { href } = location;
  useEffect(() => {
    setFailure(null);
    if (!enabled || scope.organizationId !== null) return;
    const initialScope = controller.getSnapshot();
    const abort = new AbortController();
    const onChoose = redirect
      ? () => {
        rememberDestination(locationRef.current);
        void navigate({ to: ORGANIZATIONS_PATH });
      }
      : null;
    organizationSelection.restore(api, controller, onChoose, abort.signal)
      .catch((error: unknown) => {
        // Cleanup aborts a lookup whose page left or restarted, and another
        // restore may set the scope first; neither is a failure to report.
        if (abort.signal.aborted || controller.getSnapshot() !== initialScope) {
          return;
        }
        setFailure(error);
      });
    return () => abort.abort();
  }, [
    api,
    attempt,
    controller,
    enabled,
    href,
    navigate,
    redirect,
    scope.organizationId,
  ]);
  return { failure, retry };
}

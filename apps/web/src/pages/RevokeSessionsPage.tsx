import { useCallback, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type ApiFailure, authProblemCode } from "../api/client.ts";
import { useBakeryApi } from "../api/context.tsx";
import { browserSessionsListQueryOptions } from "../api/query.ts";
import { useSingleFlightSubmit } from "../app/auth-form.ts";
import {
  ORGANIZATIONS_PATH,
  rememberCurrentReturnTo,
  SESSIONS_SETTINGS_PATH,
  SIGN_IN_PATH,
  TWO_FACTOR_PATH,
} from "../app/auth-required.tsx";
import { otherSessions } from "../app/browser-sessions.ts";
import * as organizationSelection from "../app/organization-selection.ts";
import {
  useProtectedScope,
  useQueryScopeController,
} from "../app/query-scope-context.tsx";
import { useSessionController } from "../app/session-context.tsx";
import { RevokeSessionsScreen } from "../screens/RevokeSessionsScreen.tsx";

/**
 * `/settings/sessions/revoke`: confirms signing out browser sessions.
 * With `?session=<id>` (a row's Revoke link) it revokes that one session and,
 * once done, returns to the sessions list with its "signed out" notice —
 * unless that session was this device's, in which case the local session is
 * cleared and the person lands on sign-in. Without it (the "Sign out all
 * other sessions" button) it revokes every other session and stays on its
 * own success state. The count in the heading and button comes from the same
 * scoped session list the sessions page shows.
 *
 * Failures that mean the session itself is no longer usable go where every
 * protected page sends them (two-factor, sign-in, organizations); a session
 * already gone from another device (`RESOURCE_NOT_FOUND`) has nothing left to
 * confirm and returns to the list; anything else stays here as a retryable
 * error notice.
 */
export function RevokeSessionsPage(
  { sessionId }: { readonly sessionId: string | null },
) {
  const api = useBakeryApi();
  const queryScope = useQueryScopeController();
  const scope = useProtectedScope();
  const sessionController = useSessionController();
  const navigate = useNavigate();
  const [failed, setFailed] = useState(false);
  const [done, setDone] = useState(false);

  const sessions = useQuery({
    ...browserSessionsListQueryOptions(api, scope),
    throwOnError: (error) => authProblemCode(error) !== null,
  });

  const revoke = useMutation<{ current: boolean }, ApiFailure, void>({
    // One hook serves both calls, so the name follows the one it will make.
    mutationKey: [
      sessionId === null
        ? "browserSessions.revokeOthers"
        : "browserSessions.revoke",
    ],
    mutationFn: async () => {
      const result = sessionId === null
        ? await api.browserSessions.revokeOthers()
        : await api.browserSessions.revoke(sessionId);
      if (!result.ok) throw result.error;
      return { current: "current" in result.data && result.data.current };
    },
  });

  const returnToSessions = useCallback(
    (revoked: boolean) =>
      void navigate({
        to: SESSIONS_SETTINGS_PATH,
        search: revoked ? { revoked: true } : {},
      }),
    [navigate],
  );

  const handleConfirm = useCallback(async () => {
    setFailed(false);
    try {
      const result = await revoke.mutateAsync();
      if (result.current) {
        await sessionController.signOut();
        void navigate({ to: SIGN_IN_PATH });
        return;
      }
      await sessions.refetch();
      if (sessionId === null) {
        setDone(true);
      } else {
        returnToSessions(true);
      }
    } catch (error) {
      const failure = error as ApiFailure;
      const code = authProblemCode(failure);
      if (code === "AUTH_FACTOR_REQUIRED") {
        rememberCurrentReturnTo();
        void navigate({ to: TWO_FACTOR_PATH });
        return;
      }
      if (code === "AUTH_INVALID" || code === "AUTH_EXPIRED") {
        rememberCurrentReturnTo();
        void navigate({ to: SIGN_IN_PATH, search: { reason: "expired" } });
        return;
      }
      if (code === "AUTH_REQUIRED") {
        rememberCurrentReturnTo();
        void navigate({ to: SIGN_IN_PATH });
        return;
      }
      if (code === "AUTH_FORBIDDEN") {
        organizationSelection.handleForbidden(queryScope);
        void navigate({
          to: ORGANIZATIONS_PATH,
          search: { reason: "forbidden" },
        });
        return;
      }
      if (
        failure.kind === "problem" &&
        failure.problem.code === "RESOURCE_NOT_FOUND"
      ) {
        await sessions.refetch();
        returnToSessions(false);
        return;
      }
      setFailed(true);
    }
  }, [
    navigate,
    queryScope,
    returnToSessions,
    revoke,
    sessionController,
    sessionId,
    sessions,
  ]);

  const [pending, runConfirm] = useSingleFlightSubmit(handleConfirm);

  const count = sessionId !== null
    ? 1
    : sessions.data
    ? otherSessions(sessions.data).length
    : 0;

  return (
    <RevokeSessionsScreen
      count={count}
      failed={failed}
      onCancel={() => returnToSessions(false)}
      onConfirm={() => void runConfirm()}
      onRetry={() => void sessions.refetch()}
      onReturn={() => returnToSessions(false)}
      pending={pending}
      state={done
        ? "success"
        : sessionId === null && sessions.isPending
        ? "loading"
        : sessionId === null && sessions.isError
        ? "error"
        : "confirm"}
    />
  );
}

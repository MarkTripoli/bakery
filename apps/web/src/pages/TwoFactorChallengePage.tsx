import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { type AuthProblemCode, authProblemCode } from "../api/client.ts";
import { AuthProviderError } from "@bakery/contracts/auth-provider-client";
import { useBakeryApi } from "../api/context.tsx";
import { useSingleFlightSubmit } from "../app/auth-form.ts";
import { postSignInDestination } from "../app/auth-return.ts";
import {
  ORGANIZATIONS_PATH,
  SIGN_IN_PATH,
  TWO_FACTOR_PATH,
} from "../app/auth-required.tsx";
import * as organizationSelection from "../app/organization-selection.ts";
import { useQueryScopeController } from "../app/query-scope-context.tsx";
import type { SessionContinuationResult } from "../app/session.ts";
import { useSessionController } from "../app/session-context.tsx";
import {
  TWO_FACTOR_CODE_INPUT_ID,
  type TwoFactorChallengeFailure,
  TwoFactorChallengeScreen,
} from "../screens/TwoFactorChallengeScreen.tsx";

type AuthContinuationStatus =
  | "anonymous"
  | "expired"
  | "factor-pending"
  | "forbidden";

function authContinuationStatusForCode(
  code: AuthProblemCode | null,
): AuthContinuationStatus | null {
  switch (code) {
    case "AUTH_REQUIRED":
      return "anonymous";
    case "AUTH_INVALID":
    case "AUTH_EXPIRED":
      return "expired";
    case "AUTH_FACTOR_REQUIRED":
      return "factor-pending";
    case "AUTH_FORBIDDEN":
      return "forbidden";
    default:
      return null;
  }
}

/**
 * `/sign-in/two-factor`: verifies a pending sign-in's TOTP second factor and
 * continues exactly like `/sign-in`'s success path. `TWO_FACTOR_INVALID` is a
 * per-field code error; `RATE_LIMITED`/`LOCKED` replace the form with
 * Paper's dedicated "wait before trying again" screen (unified the same way
 * `/sign-in`'s `throttled` screen unifies them). `TWO_FACTOR_SESSION_EXPIRED`
 * (the 10-minute `two_factor` cookie lapsing, distinct from a wrong code) is
 * a dead-end "expired" screen — a `Back to sign in` escape is always
 * rendered too, so the screen is never truly unescapable. A transport or
 * unknown response is reconciled against a fresh identity result; an
 * indeterminate reconciliation exposes continuation retry and never replays
 * the consumed code.
 */
export function TwoFactorChallengePage() {
  const api = useBakeryApi();
  const session = useSessionController();
  const queryScope = useQueryScopeController();
  const navigate = useNavigate();

  const [code, setCode] = useState("");
  const [failure, setFailure] = useState<TwoFactorChallengeFailure | null>(
    null,
  );
  const [verificationComplete, setVerificationComplete] = useState(false);
  const continuationAbort = useRef<AbortController | null>(null);
  const mutationAbort = useRef<AbortController | null>(null);
  const resetContinuationState = () => {
    setCode("");
    setFailure(null);
    setVerificationComplete(false);
  };
  useEffect(() => () => {
    continuationAbort.current?.abort();
    mutationAbort.current?.abort();
  }, []);

  const navigateForAuthStatus = async (
    status: AuthContinuationStatus,
    signal: AbortSignal,
  ): Promise<void> => {
    if (signal.aborted) return;
    if (status === "forbidden") {
      organizationSelection.handleForbidden(queryScope);
      if (signal.aborted) return;
      await navigate({
        to: ORGANIZATIONS_PATH,
        search: { reason: "forbidden" },
      });
      return;
    }
    if (status === "factor-pending") {
      // Same-route auth transitions do not remount this page. The consumed
      // factor must be replaced with a fresh challenge before another submit.
      resetContinuationState();
      await navigate({ to: TWO_FACTOR_PATH });
      return;
    }
    await navigate({
      to: SIGN_IN_PATH,
      ...(status === "expired" ? { search: { reason: "expired" } } : {}),
    });
  };

  const abortContinuation = () => {
    continuationAbort.current?.abort();
    continuationAbort.current = null;
  };
  const abortMutation = () => {
    mutationAbort.current?.abort();
    mutationAbort.current = null;
  };

  const continueWithSession = async (
    result: SessionContinuationResult,
    signal: AbortSignal,
  ): Promise<void> => {
    if (signal.aborted) return;
    if (result.freshness !== "fresh") {
      setVerificationComplete(true);
      setFailure("continuation-failed");
      return;
    }
    const snapshot = result.snapshot;
    if (snapshot.status === "unknown") {
      setVerificationComplete(true);
      setFailure("continuation-failed");
      return;
    }
    if (snapshot.status !== "authenticated") {
      await navigateForAuthStatus(snapshot.status, signal);
      return;
    }
    const outcome = await organizationSelection.resolve(
      api,
      queryScope,
      undefined,
      signal,
    );
    if (signal.aborted) return;
    await navigate({ to: postSignInDestination({ outcome }) });
  };

  const continueAfterVerification = async () => {
    const controller = new AbortController();
    continuationAbort.current?.abort();
    continuationAbort.current = controller;
    const { signal } = controller;
    try {
      const result = await session.refreshForContinuation(signal);
      await continueWithSession(result, signal);
    } catch (error) {
      if (signal.aborted) return;
      const status = authContinuationStatusForCode(authProblemCode(error));
      if (status !== null) {
        await navigateForAuthStatus(status, signal);
        return;
      }
      // The factor was consumed already. Retrying this operation must not
      // submit the same code again after a scope resolution failure.
      setVerificationComplete(true);
      setFailure("continuation-failed");
    } finally {
      if (continuationAbort.current === controller) {
        continuationAbort.current = null;
      }
    }
  };

  const [submitting, run] = useSingleFlightSubmit(async () => {
    if (verificationComplete) {
      await continueAfterVerification();
      return;
    }
    setFailure(null);
    if (code.length === 0) {
      setFailure("invalid");
      document.getElementById(TWO_FACTOR_CODE_INPUT_ID)?.focus();
      return;
    }

    const controller = new AbortController();
    abortMutation();
    mutationAbort.current = controller;
    const { signal } = controller;
    try {
      try {
        await api.auth.twoFactor.verifyTotp({ code }, signal);
        if (signal.aborted) return;
      } catch (error) {
        if (signal.aborted) return;
        const providerCode = error instanceof AuthProviderError
          ? error.code
          : "NETWORK";
        if (providerCode === "TWO_FACTOR_INVALID") {
          setCode("");
          setFailure("invalid");
          document.getElementById(TWO_FACTOR_CODE_INPUT_ID)?.focus();
          return;
        }
        if (providerCode === "TWO_FACTOR_SESSION_EXPIRED") {
          setCode("");
          setFailure("expired");
          return;
        }
        if (providerCode === "RATE_LIMITED" || providerCode === "LOCKED") {
          setCode("");
          setFailure("rate-limited");
          return;
        }

        // A transport or unknown response may have arrived after the
        // provider consumed the code. Reconcile once; retrying only
        // continuation is safe even when that response is indeterminate.
        setCode("");
        setVerificationComplete(true);
        try {
          const reconciled = await session.refreshForContinuation(signal);
          if (signal.aborted) return;
          await continueWithSession(reconciled, signal);
        } catch (reconciliationError) {
          if (signal.aborted) return;
          const status = authContinuationStatusForCode(
            authProblemCode(reconciliationError),
          );
          if (status !== null) {
            await navigateForAuthStatus(status, signal);
            return;
          }
          setFailure("continuation-failed");
        }
        return;
      }
      setVerificationComplete(true);
      setCode("");
      await continueAfterVerification();
    } finally {
      if (mutationAbort.current === controller) {
        mutationAbort.current = null;
      }
    }
  });

  return (
    <TwoFactorChallengeScreen
      code={code}
      failure={failure}
      focusRecoveryHeading
      onBackToSignIn={() => {
        abortContinuation();
        abortMutation();
        void navigate({ to: SIGN_IN_PATH });
      }}
      onCodeChange={setCode}
      onSubmit={() => void run()}
      pending={submitting}
    />
  );
}

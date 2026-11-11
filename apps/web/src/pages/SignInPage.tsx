import { type MouseEvent, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import type { MessageKey } from "@bakery/i18n";
import { type AuthProblemCode, authProblemCode } from "../api/client.ts";
import {
  AuthProviderError,
  type AuthProviderFailureCode,
} from "@bakery/contracts/auth-provider-client";
import { useBakeryApi } from "../api/context.tsx";
import { invitationPreviewQueryOptions } from "../api/query.ts";
import {
  focusFirstInvalidField,
  useSingleFlightSubmit,
} from "../app/auth-form.ts";
import {
  postSignInDestination,
  rememberReturnTo,
  safeSessionStorage,
} from "../app/auth-return.ts";
import {
  INVITATION_PATH,
  ORGANIZATIONS_PATH,
  REGISTER_PATH,
  SIGN_IN_PATH,
  TWO_FACTOR_PATH,
} from "../app/auth-required.tsx";
import * as organizationSelection from "../app/organization-selection.ts";
import { useQueryScopeController } from "../app/query-scope-context.tsx";
import type { SessionContinuationResult } from "../app/session.ts";
import { useSessionController } from "../app/session-context.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { useAuthBrandProps } from "../screens/auth-brand.tsx";
import { InvitationContextCard } from "../screens/InvitationContextCard.tsx";
import { useInvitationSignInProps } from "../screens/invitation-sign-in.tsx";
import { InvitationScreen } from "../screens/InvitationScreen.tsx";
import {
  SIGN_IN_EMAIL_FIELD_ID,
  SIGN_IN_PASSWORD_FIELD_ID,
  SignInScreen,
} from "../screens/SignInScreen.tsx";

const FAILURE_MESSAGE_KEYS: Readonly<
  Partial<Record<AuthProviderFailureCode, MessageKey>>
> = {
  INVALID_CREDENTIALS: "auth.signIn.genericFailure",
  CROSS_ORIGIN_BLOCKED: "auth.signIn.crossOrigin",
};

type RecoveryKind = "offline" | "unavailable" | "throttled";

function recoveryKindFor(
  code: AuthProviderFailureCode | null,
): RecoveryKind | null {
  if (code === "NETWORK") return "offline";
  if (code === "RATE_LIMITED" || code === "LOCKED") return "throttled";
  if (code === null) return null;
  if (
    code === "UNAVAILABLE" || code === "TWO_FACTOR_REQUIRED" ||
    code === "FACTOR_PROOF_REQUIRED" || code === "FRESH_SIGN_IN_REQUIRED" ||
    code === "TWO_FACTOR_INVALID" || code === "TWO_FACTOR_SESSION_EXPIRED" ||
    code === "ACCOUNT_EXISTS" || code === "WEAK_PASSWORD"
  ) {
    return "unavailable";
  }
  return null;
}

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
 * `/sign-in`: three request shapes share this one route through
 * `SignInPage`'s props rather than three separate pages, matching
 * `routeCoverage`'s single `sign-in` entry — `invitation` switches the
 * `context` variant used to sign in toward a pending invitation
 * (`auth.js` `invite-login`), `reason==="expired"` renders the dead-end
 * session-expired interstitial in place of the form (`auth.js` `expired`),
 * and the bare route is the ordinary sign-in form (`auth.js` `login`,
 * whose only reachable Paper artboard is `github-disabled` — GitHub OAuth
 * is out of scope for #127, so the button never renders here).
 *
 * `signInEmail` → `signed-in` continues through a fresh
 * `session.refreshForContinuation()` → `organizationSelection.resolve()` →
 * `postSignInDestination()` for the ordinary form; the invitation form
 * instead returns straight to `/invitations/:id` (with or without an
 * intervening two-factor challenge — the pending destination is remembered
 * before navigating there so `postSignInDestination` still resolves it
 * afterwards).
 * `two-factor-required` hands off to `/sign-in/two-factor` without consuming
 * the remembered deep link either way.
 * After credentials are accepted, a session or organization-resolution
 * failure retries only that continuation; it never resubmits the credentials.
 * An unknown sign-in response first reconciles the session. If that identity
 * response is indeterminate, the page exposes continuation retry instead of
 * replaying credentials.
 *
 * Definitive provider failures keep their existing states. An outcome-unknown
 * provider failure reconciles the session before showing a continuation-only
 * recovery state.
 */
export function SignInPage(
  { invitation, reason }: {
    readonly invitation: string | null;
    readonly reason: "expired" | "factor" | null;
  },
) {
  const { translate } = useI18n();
  const brand = useAuthBrandProps();
  const api = useBakeryApi();
  const session = useSessionController();
  const queryScope = useQueryScopeController();
  const navigate = useNavigate();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [emailInvalid, setEmailInvalid] = useState(false);
  const [passwordInvalid, setPasswordInvalid] = useState(false);
  const [failureCode, setFailureCode] = useState<
    AuthProviderFailureCode | null
  >(null);
  const [dismissedExpired, setDismissedExpired] = useState(false);
  const [movingOn, setMovingOn] = useState<"two-factor" | null>(null);
  const [postAuthenticationFailure, setPostAuthenticationFailure] = useState(
    false,
  );
  const continuationAbort = useRef<AbortController | null>(null);
  const mutationAbort = useRef<AbortController | null>(null);
  const resetContinuationState = () => {
    setEmailInvalid(false);
    setPasswordInvalid(false);
    setFailureCode(null);
    setPassword("");
    setDismissedExpired(false);
    setPostAuthenticationFailure(false);
  };
  const abortContinuation = () => {
    continuationAbort.current?.abort();
    continuationAbort.current = null;
  };
  const abortMutation = () => {
    mutationAbort.current?.abort();
    mutationAbort.current = null;
  };
  useEffect(() => () => {
    abortContinuation();
    abortMutation();
  }, []);

  const registerHref = invitation === null
    ? REGISTER_PATH
    : `${REGISTER_PATH}?invitation=${invitation}`;
  const onRegister = (event: MouseEvent<HTMLAnchorElement>) => {
    if (
      event.defaultPrevented || event.button !== 0 || event.metaKey ||
      event.ctrlKey || event.shiftKey || event.altKey ||
      (event.currentTarget.target && event.currentTarget.target !== "_self") ||
      event.currentTarget.hasAttribute("download")
    ) return;
    event.preventDefault();
    abortMutation();
    abortContinuation();
    void navigate({
      to: REGISTER_PATH,
      search: invitation === null ? {} : { invitation },
    });
  };

  const rememberInvitationDestination = () => {
    if (!invitation) return;
    rememberReturnTo(
      { pathname: `/invitations/${invitation}`, search: "", hash: "" },
      safeSessionStorage(),
    );
  };

  const navigateForAuthStatus = async (
    status: AuthContinuationStatus,
    signal: AbortSignal,
  ): Promise<void> => {
    if (signal.aborted) return;
    // Reconciliation can discover any auth status after the provider response
    // was indeterminate. Preserve the invitation before handing off to the
    // status-specific route, without retaining the submitted credentials.
    rememberInvitationDestination();
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
      await navigate({ to: TWO_FACTOR_PATH });
      return;
    }
    // Same-route auth transitions do not remount this page. Drop the
    // consumed continuation state before exposing the fresh sign-in route.
    resetContinuationState();
    await navigate({
      to: SIGN_IN_PATH,
      ...(status === "expired" ? { search: { reason: "expired" } } : {}),
    });
  };

  // `?invitation=` switches this route to Paper's `invite-login` artboard:
  // the anonymous preview fills the summary column and locks the address
  // field to the invited one, so the visitor can only sign in as the
  // account the invitation was addressed to. A preview that does not
  // resolve means the invitation is no longer pending and unexpired, so
  // there is nothing to sign in toward — the same `invite/revoked` dead end
  // `/invitations/:id` shows.
  const preview = useQuery({
    ...invitationPreviewQueryOptions(api, invitation ?? ""),
    enabled: invitation !== null,
  });
  const invited = invitation === null ? null : preview.data ?? null;
  const invitedEmail = invited?.email ?? null;
  const invitationSignIn = useInvitationSignInProps({
    context: invited === null ? null : (
      <InvitationContextCard
        inviterDisplayName={invited.inviterDisplayName}
        organizationName={invited.organizationName}
        role={invited.role}
      />
    ),
    registerHref: `${REGISTER_PATH}?invitation=${invitation ?? ""}`,
  });

  const continueWithSession = async (
    result: SessionContinuationResult,
    signal: AbortSignal,
  ): Promise<void> => {
    if (signal.aborted) return;
    if (result.freshness !== "fresh") {
      setPostAuthenticationFailure(true);
      return;
    }
    const snapshot = result.snapshot;
    if (snapshot.status === "unknown") {
      setPostAuthenticationFailure(true);
      return;
    }
    if (snapshot.status !== "authenticated") {
      await navigateForAuthStatus(snapshot.status, signal);
      return;
    }
    if (invitation) {
      if (signal.aborted) return;
      await navigate({
        to: INVITATION_PATH,
        params: { invitationId: invitation },
      });
      return;
    }
    const outcome = await organizationSelection.resolve(
      api,
      queryScope,
      undefined,
      signal,
    );
    if (signal.aborted) return;
    // Keep accepted-credential recovery visible until the destination commits.
    // Its identity loader may still be pending after scope resolution succeeds.
    await navigate({ to: postSignInDestination({ outcome }) });
  };

  const continueAfterAuthentication = async () => {
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
      // Credentials were accepted already. Retrying this operation must not
      // submit them again after a scope lookup fails.
      setPostAuthenticationFailure(true);
    } finally {
      if (continuationAbort.current === controller) {
        continuationAbort.current = null;
      }
    }
  };

  const [submitting, run] = useSingleFlightSubmit(async () => {
    if (postAuthenticationFailure) {
      await continueAfterAuthentication();
      return;
    }
    const trimmedEmail = (invitedEmail ?? email).trim();
    const emailBad = trimmedEmail.length === 0;
    const passwordBad = password.length === 0;
    setEmailInvalid(emailBad);
    setPasswordInvalid(passwordBad);
    setFailureCode(null);
    setPostAuthenticationFailure(false);
    if (emailBad || passwordBad) {
      focusFirstInvalidField([
        { id: SIGN_IN_EMAIL_FIELD_ID, invalid: emailBad },
        { id: SIGN_IN_PASSWORD_FIELD_ID, invalid: passwordBad },
      ]);
      return;
    }

    const controller = new AbortController();
    abortMutation();
    mutationAbort.current = controller;
    const { signal } = controller;
    try {
      try {
        const result = await api.auth.signInEmail(
          { email: trimmedEmail, password },
          signal,
        );
        if (signal.aborted) return;
        setPassword("");
        if (result.kind === "two-factor-required") {
          if (invitation) rememberInvitationDestination();
          setMovingOn("two-factor");
          await navigate({ to: TWO_FACTOR_PATH });
          return;
        }
      } catch (error) {
        if (signal.aborted) return;
        const code = error instanceof AuthProviderError ? error.code : null;
        if (
          code === "INVALID_CREDENTIALS" ||
          code === "RATE_LIMITED" ||
          code === "LOCKED" ||
          code === "CROSS_ORIGIN_BLOCKED"
        ) {
          if (code === "INVALID_CREDENTIALS") setPassword("");
          setFailureCode(code ?? "UNAVAILABLE");
          return;
        }

        setPassword("");
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
          setPostAuthenticationFailure(true);
        }
        return;
      }
      await continueAfterAuthentication();
    } finally {
      if (mutationAbort.current === controller) {
        mutationAbort.current = null;
      }
    }
  });

  // The invitation variant waits for its preview instead of rendering the
  // brand shell first and swapping columns once the summary arrives.
  if (movingOn === "two-factor" || (invitation !== null && preview.isPending)) {
    return (
      <UI.AuthEntry
        {...brand}
        variant={invitation ? "context" : "brand"}
      >
        <UI.Stack data-testid="sign-in-two-factor" gap="spacious">
          <UI.Heading level="page" tabIndex={-1}>
            {translate("shell.states.loadingTitle")}
          </UI.Heading>
          <UI.Skeleton shape="text" />
        </UI.Stack>
      </UI.AuthEntry>
    );
  }

  const recoveryKind = failureCode === "INVALID_CREDENTIALS"
    ? null
    : recoveryKindFor(failureCode);
  const state = postAuthenticationFailure
    ? "continuation-failed"
    : reason === "expired" && !dismissedExpired
    ? "expired"
    : recoveryKind ?? "form";

  const previewFailure = preview.isError ? preview.error : null;
  if (
    previewFailure !== null && previewFailure.kind === "problem" &&
    (previewFailure.problem.code === "RESOURCE_NOT_FOUND" ||
      previewFailure.problem.code === "MALFORMED_REQUEST")
  ) {
    return (
      <InvitationScreen
        onAccept={() => {}}
        onBackToSignIn={() => void navigate({ to: SIGN_IN_PATH, search: {} })}
        onCreateAccount={() => {}}
        onDecline={() => {}}
        onOpenOrganization={() => {}}
        onSignIn={() => {}}
        onSwitchAccount={() => {}}
        signInHref={SIGN_IN_PATH}
        state="revoked"
      />
    );
  }

  return (
    <SignInScreen
      {...(invited === null ? {} : {
        ...invitationSignIn,
        footer: (
          <UI.Link href={registerHref} onClick={onRegister}>
            {translate("auth.invitationSignIn.needAccount")}
          </UI.Link>
        ),
      })}
      email={invitedEmail ?? email}
      emailInvalid={emailInvalid}
      failure={failureCode ? FAILURE_MESSAGE_KEYS[failureCode] ?? null : null}
      focusRecoveryHeading
      notice={reason === "factor" ? "auth.factorRequired.description" : null}
      onBackToSignIn={() => {
        abortContinuation();
        abortMutation();
        setFailureCode(null);
        setPostAuthenticationFailure(false);
        setPassword("");
      }}
      onEmailChange={setEmail}
      onPasswordChange={setPassword}
      onRegister={onRegister}
      onRetry={() => void run()}
      onReturnToSignIn={() => {
        abortContinuation();
        abortMutation();
        setFailureCode(null);
        setPostAuthenticationFailure(false);
      }}
      onSignInAgain={() => {
        abortContinuation();
        abortMutation();
        setDismissedExpired(true);
      }}
      onSubmit={() => void run()}
      onUseDifferentAccount={() => {
        abortContinuation();
        abortMutation();
        setDismissedExpired(true);
      }}
      password={password}
      passwordInvalid={passwordInvalid}
      pending={submitting}
      registerHref={registerHref}
      state={state}
      variant={invited === null ? "brand" : "context"}
    />
  );
}

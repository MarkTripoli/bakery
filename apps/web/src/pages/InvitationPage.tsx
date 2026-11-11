import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import {
  type ApiFailure,
  authProblemCode,
  type OrganizationInvitationRecipientResult,
} from "../api/client.ts";
import { useBakeryApi } from "../api/context.tsx";
import {
  invitationPreviewQueryOptions,
  invitationRecipientQueryOptions,
} from "../api/query.ts";
import {
  REGISTER_PATH,
  rememberCurrentReturnTo,
  SIGN_IN_PATH,
  TWO_FACTOR_PATH,
} from "../app/auth-required.tsx";
import * as organizationSelection from "../app/organization-selection.ts";
import {
  useProtectedScope,
  useQueryScopeController,
} from "../app/query-scope-context.tsx";
import { useSession, useSessionController } from "../app/session-context.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import {
  InvitationScreen,
  type InvitationScreenProps,
} from "../screens/InvitationScreen.tsx";

/**
 * `/invitations/$invitationId`: public. `organizationInvitations.preview` is
 * an anonymous action, so the invitation's organization, inviter, role and
 * invited address are readable before sign-in — that is what fills Paper's
 * `contextShell` summary on both the anonymous (`default`) and the
 * authenticated artboard. The preview resolves only pending, unexpired
 * invitations, so a revoked, expired, already-accepted or nonexistent id all
 * return the identical `RESOURCE_NOT_FOUND` (anti-enumeration, by design)
 * and land on Paper's single `revoked` dead end.
 *
 * Accepting and declining stay Authenticated `recipientGet`/
 * `recipientAccept`/`recipientReject` calls, so a pending second factor or a
 * stale session is handled exactly as on a protected route. `wrong-account`
 * is the one state the client can tell apart itself: the preview's invited
 * address does not match the signed-in identity's, so `recipientGet` would
 * 404 for a reason the visitor can actually fix.
 */
export function InvitationPage() {
  const { invitationId } = useParams({ from: "/invitations/$invitationId" });
  const { translate } = useI18n();
  const api = useBakeryApi();
  const session = useSession();
  const sessionController = useSessionController();
  const queryScope = useQueryScopeController();
  const scope = useProtectedScope();
  const navigate = useNavigate();
  // TanStack Query only flips a mutation's `isSuccess` after its `onSuccess`
  // callback resolves, so gating the post-action render on
  // `accept.isSuccess` still let the scope switch's refetch race ahead of
  // it. This local flag is set synchronously, before any `await`, in the
  // same tick as the scope switch, so React batches both updates into one
  // render.
  const [outcome, setOutcome] = useState<"accepted" | "declined" | null>(null);

  const preview = useQuery(invitationPreviewQueryOptions(api, invitationId));
  const invitation = preview.data ?? null;
  const previewFailure = preview.isError ? preview.error : null;
  // A malformed id is as unavailable as an unknown one: neither can ever
  // resolve, so both are the `revoked` dead end rather than a retry.
  const previewNotFound = previewFailure !== null &&
    previewFailure.kind === "problem" &&
    (previewFailure.problem.code === "RESOURCE_NOT_FOUND" ||
      previewFailure.problem.code === "MALFORMED_REQUEST");

  const identityEmail = session.identity?.email ?? null;
  const authenticated = session.status === "authenticated" &&
    identityEmail !== null;
  const wrongAccount = authenticated && invitation !== null &&
    identityEmail?.toLowerCase() !== invitation.email.toLowerCase();

  const recipient = useQuery({
    ...invitationRecipientQueryOptions(api, scope, invitationId),
    enabled: authenticated && invitation !== null && !wrongAccount,
  });
  const recipientCode = recipient.isError
    ? authProblemCode(recipient.error)
    : null;

  // A session the root refresh already classified as pending its second
  // factor or expired never reaches the recipient query (it is gated on
  // `authenticated`), so those states route from the session itself; the
  // same problem codes on the query cover a session that lapsed underneath
  // an open page.
  const sessionStatus = session.status;
  useEffect(() => {
    if (
      sessionStatus === "factor-pending" ||
      recipientCode === "AUTH_FACTOR_REQUIRED"
    ) {
      rememberCurrentReturnTo();
      void navigate({ to: TWO_FACTOR_PATH });
    } else if (
      sessionStatus === "expired" ||
      recipientCode === "AUTH_REQUIRED" || recipientCode === "AUTH_INVALID" ||
      recipientCode === "AUTH_EXPIRED"
    ) {
      rememberCurrentReturnTo();
      void navigate({ to: SIGN_IN_PATH, search: { reason: "expired" } });
    }
  }, [recipientCode, navigate, sessionStatus]);

  const accept = useMutation<OrganizationInvitationRecipientResult, ApiFailure>(
    {
      mutationKey: ["organizationInvitations.recipientAccept"],
      mutationFn: async () => {
        const result = await api.invitations.recipientAccept(invitationId);
        if (!result.ok) throw result.error;
        return result.data;
      },
      onSuccess: async (result) => {
        setOutcome("accepted");
        queryScope.setIdentity(result.invitation.organizationId);
        organizationSelection.remember(result.invitation.organizationId);
        await sessionController.refresh();
      },
    },
  );
  const decline = useMutation<
    OrganizationInvitationRecipientResult,
    ApiFailure
  >({
    mutationKey: ["organizationInvitations.recipientReject"],
    mutationFn: async () => {
      const result = await api.invitations.recipientReject(invitationId);
      if (!result.ok) throw result.error;
      return result.data;
    },
    onSuccess: () => setOutcome("declined"),
  });

  const actionError = accept.error ?? decline.error;
  const actionCode = actionError ? authProblemCode(actionError) : null;

  useEffect(() => {
    if (actionCode === "AUTH_FACTOR_REQUIRED") {
      rememberCurrentReturnTo();
      void navigate({ to: TWO_FACTOR_PATH });
    } else if (
      actionCode === "AUTH_REQUIRED" || actionCode === "AUTH_INVALID" ||
      actionCode === "AUTH_EXPIRED"
    ) {
      rememberCurrentReturnTo();
      void navigate({ to: SIGN_IN_PATH, search: { reason: "expired" } });
    }
  }, [actionCode, navigate]);

  const actions: Pick<
    InvitationScreenProps,
    | "onAccept"
    | "onBackToSignIn"
    | "onCreateAccount"
    | "onDecline"
    | "onOpenOrganization"
    | "onSignIn"
    | "onSwitchAccount"
    | "signInHref"
  > = {
    signInHref: `${SIGN_IN_PATH}?invitation=${
      encodeURIComponent(invitationId)
    }`,
    onAccept: () => accept.mutate(),
    onBackToSignIn: () => void navigate({ to: SIGN_IN_PATH }),
    onCreateAccount: () =>
      void navigate({
        to: REGISTER_PATH,
        search: { invitation: invitationId },
      }),
    // Declining is an Authenticated action: an anonymous visitor proves they
    // are the recipient by signing in first, then declines from the
    // authenticated artboard.
    onDecline: () =>
      authenticated ? decline.mutate() : void navigate({
        to: SIGN_IN_PATH,
        search: { invitation: invitationId },
      }),
    onOpenOrganization: () => void navigate({ to: "/" }),
    onSignIn: () =>
      void navigate({
        to: SIGN_IN_PATH,
        search: { invitation: invitationId },
      }),
    onSwitchAccount: () =>
      void sessionController.signOut().then(() =>
        navigate({ to: SIGN_IN_PATH, search: { invitation: invitationId } })
      ),
  };

  if (outcome === "declined") {
    return (
      <InvitationScreen
        {...actions}
        organizationName={invitation?.organizationName ?? ""}
        state="declined"
      />
    );
  }

  if (previewNotFound) {
    return <InvitationScreen {...actions} state="revoked" />;
  }

  if (preview.isPending) {
    return (
      <UI.AuthEntry variant="context">
        <UI.Stack data-testid="invitation-loading" gap="spacious">
          <UI.Heading level="page" tabIndex={-1}>
            {translate("shell.states.loadingTitle")}
          </UI.Heading>
          <UI.Skeleton shape="text" />
        </UI.Stack>
      </UI.AuthEntry>
    );
  }

  if (invitation === null) {
    return (
      <UI.AuthEntry variant="context">
        <UI.ErrorState
          action={
            <UI.Button onClick={() => void preview.refetch()}>
              {translate("core.actions.retry")}
            </UI.Button>
          }
          data-testid="invitation-error"
          description={translate("problems.UNKNOWN.description")}
          title={translate("problems.UNKNOWN.title")}
          variant="page"
        />
      </UI.AuthEntry>
    );
  }

  const subject = {
    email: invitation.email,
    inviterDisplayName: invitation.inviterDisplayName,
    organizationName: invitation.organizationName,
    role: invitation.role,
  } as const;

  if (outcome === "accepted") {
    return <InvitationScreen {...actions} {...subject} state="accepted" />;
  }

  if (wrongAccount) {
    return <InvitationScreen {...actions} {...subject} state="wrong-account" />;
  }

  if (!authenticated) {
    return <InvitationScreen {...actions} {...subject} state="default" />;
  }

  // `recipientGet` is what proves this principal may act on the invitation;
  // its `RESOURCE_NOT_FOUND` means the invitation stopped being actionable
  // between the preview and now, which is Paper's `revoked` dead end.
  if (
    recipient.isError && recipient.error.kind === "problem" &&
    recipient.error.problem.code === "RESOURCE_NOT_FOUND"
  ) {
    return <InvitationScreen {...actions} state="revoked" />;
  }

  return (
    <InvitationScreen
      {...actions}
      {...subject}
      failure={actionCode !== null || actionError === null
        ? null
        : actionError.kind === "network"
        ? "auth.signIn.offline"
        : "problems.UNKNOWN.description"}
      pendingAction={accept.isPending
        ? "accept"
        : decline.isPending
        ? "decline"
        : null}
      signedInName={session.identity?.displayName ?? invitation.email}
      state="authenticated"
    />
  );
}

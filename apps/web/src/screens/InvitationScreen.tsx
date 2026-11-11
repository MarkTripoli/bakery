import type { MessageKey } from "@bakery/i18n";
import * as UI from "@bakery/ui";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { useAuthBrandProps } from "./auth-brand.tsx";
import {
  InvitationContextCard,
  type InvitationContextCardProps,
  invitationRoleMessageKey,
} from "./InvitationContextCard.tsx";

/**
 * Which Paper `invite` artboard the screen is showing (`auth.js` L153-159).
 *
 * The four states that still have an invitation to describe keep the
 * `contextShell` and its summary column; `revoked` and `declined` are dead
 * ends Paper draws on the brand `authShell` instead, because there is no
 * longer an invitation to summarise.
 */
export type InvitationScreenState =
  | "default"
  | "authenticated"
  | "wrong-account"
  | "accepted"
  | "declined"
  | "revoked";

type InvitationActions = {
  /** `Create your account` (anonymous visitor) → `/register?invitation=`. */
  readonly onCreateAccount: () => void;
  /** `Already have an account? Sign in` → `/sign-in?invitation=`. */
  readonly onSignIn: () => void;
  /** The real sign-in URL behind that link, so middle-click and copy work. */
  readonly signInHref: string;
  readonly onAccept: () => void;
  readonly onDecline: () => void;
  /** `Switch account`: sign out, then sign in as the invited address. */
  readonly onSwitchAccount: () => void;
  /** `Open {organization}` once the invitation has been accepted. */
  readonly onOpenOrganization: () => void;
  /** `Back to sign in` on the two dead-end artboards. */
  readonly onBackToSignIn: () => void;
};

type InvitationSubject = InvitationContextCardProps & {
  /** The address the invitation was sent to (`identity('mail', …)`). */
  readonly email: string;
  /**
   * `Signed in as {name}` replaces `Email on the invitation` once the
   * recipient is authenticated (`auth.js` L159).
   */
  readonly signedInName?: string;
  /** Which action is in flight, if any. */
  readonly pendingAction?: "accept" | "decline" | null;
  /** Error notice below the heading, when an action failed. */
  readonly failure?: MessageKey | null;
};

export type InvitationScreenProps =
  & InvitationActions
  & (
    | ({
      readonly state:
        | "default"
        | "authenticated"
        | "wrong-account"
        | "accepted";
    } & InvitationSubject)
    | { readonly state: "declined"; readonly organizationName: string }
    | { readonly state: "revoked" }
  );

/**
 * `/invitations/$invitationId` in every shape Paper draws it. Pure
 * presenter: the page owns the preview query, `recipientAccept`/
 * `recipientReject` and every navigation.
 */
export function InvitationScreen(props: InvitationScreenProps) {
  const { translate } = useI18n();
  const brand = useAuthBrandProps();

  if (props.state === "revoked" || props.state === "declined") {
    return (
      <UI.AuthEntry {...brand} variant="brand">
        <UI.AuthHeading
          data-testid={`invitation-${props.state}`}
          description={props.state === "revoked"
            ? translate("auth.invitation.revokedDescription")
            : translate("auth.invitation.declinedDescription", {
              organization: props.organizationName,
            })}
          title={translate(
            props.state === "revoked"
              ? "auth.invitation.revokedTitle"
              : "auth.invitation.declined",
          )}
        />
        <UI.Button
          data-testid="invitation-back-to-sign-in"
          onClick={props.onBackToSignIn}
        >
          {translate("auth.invitation.backToSignIn")}
        </UI.Button>
      </UI.AuthEntry>
    );
  }

  const {
    email,
    failure = null,
    inviterDisplayName,
    onAccept,
    onCreateAccount,
    onDecline,
    onOpenOrganization,
    onSignIn,
    signInHref,
    onSwitchAccount,
    organizationName,
    pendingAction = null,
    role,
    signedInName,
    state,
  } = props;
  const card = (
    <InvitationContextCard
      inviterDisplayName={inviterDisplayName}
      organizationName={organizationName}
      role={role}
    />
  );

  if (state === "wrong-account" || state === "accepted") {
    return (
      <UI.AuthEntry {...brand} context={card} variant="context">
        <UI.AuthHeading
          data-testid={`invitation-${state}`}
          description={translate(
            state === "wrong-account"
              ? "auth.invitation.wrongAccountDescription"
              : "auth.invitation.alreadyAcceptedDescription",
          )}
          title={state === "wrong-account"
            ? translate("auth.invitation.wrongAccountTitle")
            : translate("auth.invitation.accepted", {
              organization: organizationName,
            })}
        />
        {state === "wrong-account"
          ? (
            <UI.Button
              data-testid="invitation-switch-account"
              onClick={onSwitchAccount}
            >
              {translate("auth.invitation.switchAccount")}
            </UI.Button>
          )
          : (
            <UI.Button
              data-testid="invitation-open-organization"
              onClick={onOpenOrganization}
            >
              {translate("auth.invitation.openOrganization", {
                organization: organizationName,
              })}
            </UI.Button>
          )}
      </UI.AuthEntry>
    );
  }

  const busy = pendingAction !== null;
  return (
    <UI.AuthEntry {...brand} context={card} variant="context">
      <UI.AuthHeading
        data-testid={`invitation-${state}`}
        description={translate("auth.invitation.description", {
          role: translate(invitationRoleMessageKey(role)),
        })}
        title={translate("auth.invitation.title", {
          organization: organizationName,
        })}
      />
      {failure
        ? <UI.InlineNotice tone="error">{translate(failure)}</UI.InlineNotice>
        : null}
      <UI.DescriptionItem
        description={signedInName === undefined
          ? translate("auth.invitation.emailCaption")
          : translate("auth.invitation.signedInAs", { name: signedInName })}
        icon={<UI.IconGlyph name="mail" size="large" />}
        title={email}
      />
      <UI.InlineNotice>
        {translate("auth.invitation.roleNotice")}
      </UI.InlineNotice>
      {state === "authenticated"
        ? (
          <UI.Button
            data-testid="invitation-accept"
            disabled={busy}
            loading={pendingAction === "accept"}
            onClick={onAccept}
          >
            {translate(
              pendingAction === "accept"
                ? "auth.common.pendingAction"
                : "auth.invitation.accept",
            )}
          </UI.Button>
        )
        : (
          <>
            <UI.Button
              data-testid="invitation-create-account"
              onClick={onCreateAccount}
            >
              {translate("auth.invitation.createYourAccount")}
            </UI.Button>
            <UI.Link
              href={signInHref}
              onClick={(event) => {
                event.preventDefault();
                onSignIn();
              }}
            >
              {translate("auth.invitation.alreadyHaveAccount")}
            </UI.Link>
          </>
        )}
      {
        /* auth.js L159 draws `Decline invitation` as a `.text-link`, not a
          button, on both the anonymous and the authenticated artboard. */
      }
      <UI.Link
        aria-disabled={busy || undefined}
        data-testid="invitation-decline"
        href="#"
        onClick={(event) => {
          event.preventDefault();
          if (!busy) onDecline();
        }}
      >
        {translate(
          pendingAction === "decline"
            ? "auth.common.pendingAction"
            : "auth.invitation.decline",
        )}
      </UI.Link>
    </UI.AuthEntry>
  );
}

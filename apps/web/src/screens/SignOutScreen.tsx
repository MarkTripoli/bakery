import * as UI from "@bakery/ui";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { useAuthBrandProps } from "./auth-brand.tsx";

export type SignOutScreenProps = {
  readonly state: "confirm" | "success";
  /** `confirm` only: the sign-out request is in flight. */
  readonly pending: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  /** `success` only: the "Sign in" button. */
  readonly onSignIn: () => void;
};

/**
 * `/sign-out` presenter — Paper `signout` (auth.js): `confirm` is the
 * heading, the muted "other work stays active" line and a Cancel/Sign out
 * pair (`.two-actions`); `success` is the heading with a single "Sign in".
 */
export function SignOutScreen(
  { onCancel, onConfirm, onSignIn, pending, state }: SignOutScreenProps,
) {
  const { translate } = useI18n();
  const brand = useAuthBrandProps();

  if (state === "success") {
    return (
      <UI.AuthEntry variant="brand" {...brand}>
        <UI.AuthHeading
          data-testid="sign-out-success"
          description={translate("auth.signOut.successDescription")}
          title={translate("auth.signOut.successTitle")}
        />
        <UI.Button onClick={onSignIn}>
          {translate("auth.signOut.signIn")}
        </UI.Button>
      </UI.AuthEntry>
    );
  }

  return (
    <UI.AuthEntry variant="brand" {...brand}>
      <UI.AuthHeading
        data-testid="sign-out-confirm"
        description={translate("auth.sessions.revokeConfirm")}
        title={translate("auth.signOut.confirmTitle")}
      />
      <UI.Text variant="muted">
        {translate("auth.signOut.stayActiveNotice")}
      </UI.Text>
      <UI.Inline variant="actions">
        <UI.Button onClick={onCancel} variant="secondary">
          {translate("auth.signOut.cancel")}
        </UI.Button>
        <UI.Button busy={pending} onClick={onConfirm}>
          {translate(
            pending ? "auth.common.pendingAction" : "auth.signOut.confirm",
          )}
        </UI.Button>
      </UI.Inline>
    </UI.AuthEntry>
  );
}

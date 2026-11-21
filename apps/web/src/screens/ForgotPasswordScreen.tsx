import * as UI from "@bakery/ui";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { useAuthBrandProps } from "./auth-brand.tsx";

export type ForgotPasswordScreenProps = {
  /** Leave for `/sign-in`. */
  readonly onBackToSignIn: () => void;
};

/**
 * `/sign-in/forgot-password`. Bakery cannot send a reset link yet, so the page
 * says so, says who can help, and gives the one way back. It never offers a
 * form that would do nothing.
 */
export function ForgotPasswordScreen(
  { onBackToSignIn }: ForgotPasswordScreenProps,
) {
  const { translate } = useI18n();
  const brand = useAuthBrandProps();
  return (
    <UI.AuthEntry variant="brand" {...brand}>
      <UI.AuthHeading
        data-testid="forgot-password"
        description={translate("auth.forgotPassword.description")}
        title={translate("auth.forgotPassword.title")}
      />
      <UI.Text variant="muted">
        {translate("auth.forgotPassword.signedInElsewhere")}
      </UI.Text>
      <UI.Button onClick={onBackToSignIn} variant="secondary">
        {translate("auth.forgotPassword.back")}
      </UI.Button>
    </UI.AuthEntry>
  );
}

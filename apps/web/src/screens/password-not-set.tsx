import * as UI from "@bakery/ui";
import { useI18n } from "../i18n/I18nProvider.tsx";

/**
 * Shown when an account has no password to re-prove (it signs in with a
 * passkey or a social provider). Re-authentication cannot happen in place,
 * so the person is offered one clear way forward: sign out, then sign in
 * again, which returns them to the page they were on.
 */
export function PasswordNotSetNotice(
  { onSignOutThenSignIn }: { readonly onSignOutThenSignIn: () => void },
) {
  const { translate } = useI18n();
  return (
    <>
      <UI.InlineNotice tone="warning">
        {translate("settings.passwordNotSet.notice")}
      </UI.InlineNotice>
      <UI.Button onClick={onSignOutThenSignIn} variant="secondary">
        {translate("settings.passwordNotSet.action")}
      </UI.Button>
    </>
  );
}

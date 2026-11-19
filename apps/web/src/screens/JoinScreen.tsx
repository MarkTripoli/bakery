import * as UI from "@bakery/ui";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { useAuthBrandProps } from "./auth-brand.tsx";

export type JoinScreenProps = {
  /** Signups are switched off for this installation: say so. */
  readonly registrationPaused?: boolean;
  /** Leave for `/sign-in`. */
  readonly onSignIn: () => void;
};

/**
 * `/register` with no invitation. Bakery accounts are always created from an
 * invitation, so the page says so in its heading, says what to ask for and from
 * whom, and offers the one way back. When new accounts are paused on this
 * server, it says that instead.
 */
export function JoinScreen(
  { onSignIn, registrationPaused = false }: JoinScreenProps,
) {
  const { translate } = useI18n();
  const brand = useAuthBrandProps();
  return (
    <UI.AuthEntry variant="brand" {...brand}>
      <UI.AuthHeading
        data-testid={registrationPaused ? "registration-paused" : "join"}
        description={translate(
          registrationPaused
            ? "auth.invitationRequired.pausedDescription"
            : "auth.invitationRequired.description",
        )}
        title={translate(
          registrationPaused
            ? "auth.invitationRequired.pausedTitle"
            : "auth.invitationRequired.title",
        )}
      />
      <UI.Button onClick={onSignIn} variant="secondary">
        {translate("auth.invitationRequired.signIn")}
      </UI.Button>
    </UI.AuthEntry>
  );
}

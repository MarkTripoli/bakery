import * as UI from "@bakery/ui";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { useAuthBrandProps } from "./auth-brand.tsx";

export type JoinScreenProps = {
  /** Signups are switched off for this installation: say so. */
  readonly registrationPaused?: boolean;
  /** Leave for `/sign-in`; Paper renders this as the primary action. */
  readonly onSignIn: () => void;
};

/**
 * `/register` with no invitation — Paper `join` (auth.js L152). Registration
 * is closed, so the screen explains the invitation path and offers the one
 * action a visitor without an invitation can still take.
 */
export function JoinScreen(
  { onSignIn, registrationPaused = false }: JoinScreenProps,
) {
  const { translate } = useI18n();
  const brand = useAuthBrandProps();
  return (
    <UI.AuthEntry variant="brand" {...brand}>
      <UI.AuthHeading
        data-testid="join"
        description={translate("auth.invitationRequired.description")}
        title={translate("auth.invitationRequired.title")}
      />
      {registrationPaused
        ? (
          <UI.InlineNotice data-testid="registration-paused" tone="warning">
            {translate("features.registrationPaused.notice")}
          </UI.InlineNotice>
        )
        : null}
      <UI.Text variant="muted">{translate("auth.join.instructions")}</UI.Text>
      <UI.Button onClick={onSignIn}>
        {translate("auth.invitationRequired.signIn")}
      </UI.Button>
    </UI.AuthEntry>
  );
}

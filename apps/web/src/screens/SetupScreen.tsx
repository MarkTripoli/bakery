import * as UI from "@bakery/ui";
import { SIGN_IN_PATH } from "../app/auth-paths.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { useAuthBrandProps } from "./auth-brand.tsx";

export type SetupScreenProps = {
  /**
   * `probing` is the installation-status request itself and `unavailable`
   * its failure; the Paper artboard has neither because the mock knows the
   * answer already. `unavailable` reuses the sign-in family's recovery
   * interstitial (Paper `login/unavailable`), the one the design draws for
   * an unreachable authentication service.
   */
  readonly state: "probing" | "default" | "ready" | "unavailable";
  /** `ready` only: continue to sign in with the new first Admin. */
  readonly onContinue: () => void;
  /** `unavailable` only: probe the installation status again. */
  readonly onRetry: () => void;
};

/**
 * `/setup` presenter — Paper `setup` (auth.js L207). `default` states the
 * situation in a notice (there is no HTTP admin creation to offer), `ready`
 * offers the single primary action; both end with the "Back to sign in"
 * link.
 */
export function SetupScreen({ onContinue, onRetry, state }: SetupScreenProps) {
  const { translate } = useI18n();
  const brand = useAuthBrandProps();

  if (state === "probing") {
    return (
      <UI.AuthEntry variant="brand" {...brand}>
        <UI.Stack data-testid="setup-loading" gap="spacious">
          <UI.AuthHeading
            description={translate("auth.bootstrap.description")}
            title={translate("shell.states.loadingTitle")}
          />
          <UI.Skeleton shape="surface" />
        </UI.Stack>
      </UI.AuthEntry>
    );
  }

  if (state === "unavailable") {
    return (
      <UI.AuthEntry variant="brand" {...brand}>
        <UI.Stack data-testid="setup-unavailable" gap="spacious">
          <UI.AuthHeading
            description={translate("auth.signIn.unavailableDescription")}
            title={translate("auth.signIn.unavailableTitle")}
          />
          <UI.AlertBanner tone="warning">
            {translate("auth.signIn.unavailable")}
          </UI.AlertBanner>
          <UI.Button onClick={onRetry}>
            {translate("auth.signIn.tryAgain")}
          </UI.Button>
          <UI.Link href={SIGN_IN_PATH}>
            {translate("auth.setup.backToSignIn")}
          </UI.Link>
        </UI.Stack>
      </UI.AuthEntry>
    );
  }

  const ready = state === "ready";
  return (
    <UI.AuthEntry variant="brand" {...brand}>
      <UI.AuthHeading
        data-testid={ready ? "setup-ready" : "setup-default"}
        description={translate(
          ready ? "auth.setup.readyDescription" : "auth.bootstrap.description",
        )}
        title={translate(
          ready ? "auth.setup.readyTitle" : "auth.bootstrap.title",
        )}
      />
      {ready
        ? (
          <UI.Button onClick={onContinue}>
            {translate("auth.setup.continueToSignIn")}
          </UI.Button>
        )
        : (
          <UI.InlineNotice tone="information">
            {translate("auth.setup.instructionsNotice")}
          </UI.InlineNotice>
        )}
      <UI.Link href={SIGN_IN_PATH}>
        {translate("auth.setup.backToSignIn")}
      </UI.Link>
    </UI.AuthEntry>
  );
}

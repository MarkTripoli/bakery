import * as UI from "@bakery/ui";
import { SECURITY_SETTINGS_PATH } from "../app/auth-paths.ts";
import { RouterLink } from "../app/router-link.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";

export type RevokeSessionsScreenProps = {
  /** `loading`/`error` cover the session list the count comes from. */
  readonly state: "loading" | "error" | "confirm" | "success";
  /** `confirm` only: how many sessions the confirmation signs out. */
  readonly count: number;
  /** `confirm` only: the revocation is in flight. */
  readonly pending: boolean;
  /** `confirm` only: the last attempt failed and may be retried. */
  readonly failed: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  /** `error` only: retries the session list query. */
  readonly onRetry: () => void;
  /** `success` only: "Return to sessions". */
  readonly onReturn: () => void;
};

/**
 * `/settings/sessions/revoke` presenter — Paper `revoke` (auth.js
 * L189): a back link and a 520px form column holding the heading, one notice
 * (warning while confirming, error after a failed attempt, success once
 * done) and either the Cancel / "Sign out N sessions" pair or the single
 * "Return to sessions" button.
 */
export function RevokeSessionsScreen(
  { count, failed, onCancel, onConfirm, onRetry, onReturn, pending, state }:
    RevokeSessionsScreenProps,
) {
  const { translate } = useI18n();
  const success = state === "success";
  const back = (
    <RouterLink to={SECURITY_SETTINGS_PATH}>
      <UI.IconGlyph name="back" size="large" />
      {translate("auth.settings.security.title")}
    </RouterLink>
  );
  if (state === "loading" || state === "error") {
    return (
      <UI.SettingsContent back={back} data-testid="revoke-sessions">
        {state === "loading"
          ? (
            <UI.Stack data-testid="revoke-sessions-loading" gap="compact">
              <UI.Skeleton shape="row" />
              <UI.Skeleton shape="row" />
            </UI.Stack>
          )
          : (
            <UI.ErrorState
              action={
                <UI.Button onClick={onRetry}>
                  {translate("core.actions.retry")}
                </UI.Button>
              }
              data-testid="revoke-sessions-error"
              description={translate("problems.UNKNOWN.description")}
              title={translate("shell.states.errorTitle")}
              variant="region"
            />
          )}
      </UI.SettingsContent>
    );
  }
  return (
    <UI.SettingsContent back={back} data-testid="revoke-sessions">
      <UI.FormContent>
        <UI.AuthHeading
          description={success
            ? translate("auth.settings.sessions.revoke.successDescription")
            : translate("auth.settings.sessions.revoke.confirmDescription", {
              count,
            })}
          title={translate(
            success
              ? "auth.settings.sessions.revoke.successTitle"
              : "auth.settings.sessions.revoke.confirmTitle",
          )}
        />
        {failed
          ? (
            <UI.InlineNotice tone="error">
              {translate("auth.settings.sessions.revoke.failedNotice")}
            </UI.InlineNotice>
          )
          : (
            <UI.InlineNotice tone={success ? "success" : "warning"}>
              {translate("auth.settings.sessions.revoke.staysSignedInNotice")}
            </UI.InlineNotice>
          )}
        {success
          ? (
            <UI.Button onClick={onReturn} variant="secondary">
              {translate("auth.settings.sessions.revoke.returnToSessions")}
            </UI.Button>
          )
          : (
            <UI.Inline variant="actions">
              <UI.Button onClick={onCancel} variant="secondary">
                {translate("auth.settings.sessions.revoke.cancel")}
              </UI.Button>
              <UI.Button
                data-testid="revoke-sessions-confirm"
                loading={pending}
                onClick={onConfirm}
                variant="destructive"
              >
                {pending
                  ? translate("auth.common.pendingAction")
                  : translate("auth.settings.sessions.revoke.confirmButton", {
                    count,
                  })}
              </UI.Button>
            </UI.Inline>
          )}
      </UI.FormContent>
    </UI.SettingsContent>
  );
}

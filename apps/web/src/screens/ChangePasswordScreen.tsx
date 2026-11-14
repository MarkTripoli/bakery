import * as UI from "@bakery/ui";
import {
  SECURITY_SETTINGS_PATH,
  SESSIONS_SETTINGS_PATH,
} from "../app/auth-paths.ts";
import { RouterLink } from "../app/router-link.tsx";
import type { SecurityFailure } from "../app/security-failures.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import {
  isDisconnected,
  SecurityAsyncBoundary,
  type SecurityAsyncKind,
} from "./security-async.tsx";

/** Exported so the container can focus the field a failure rejected. */
export const PASSWORD_CURRENT_INPUT_ID = "change-password-current";
export const PASSWORD_NEW_INPUT_ID = "change-password-new";

export type ChangePasswordScreenProps = {
  /** `form` is Paper `default`/`invalid`/`loading`; `success` the done state. */
  readonly state: "form" | "success";
  readonly currentPassword: string;
  readonly newPassword: string;
  readonly pending: boolean;
  readonly failure: SecurityFailure | null;
  readonly async: SecurityAsyncKind | null;
  readonly onCurrentChange: (value: string) => void;
  readonly onNewChange: (value: string) => void;
  readonly onSubmit: () => void;
  readonly onRetry: () => void;
  readonly onReload: () => void;
  readonly onRefresh: () => void;
};

/**
 * `/settings/security/password` presenter — Paper V-0 `password` (auth.js
 * `password`): the heading, the form-level error, current and new password
 * fields, "Save password" and Cancel; or, once saved, the "Password changed"
 * confirmation with a link on to the active sessions.
 */
export function ChangePasswordScreen(
  {
    async,
    currentPassword,
    failure,
    newPassword,
    onCurrentChange,
    onNewChange,
    onRefresh,
    onReload,
    onRetry,
    onSubmit,
    pending,
    state,
  }: ChangePasswordScreenProps,
) {
  const { translate } = useI18n();
  const revealLabels = {
    hide: translate("auth.signIn.hidePassword"),
    show: translate("auth.signIn.showPassword"),
  };

  const content = state === "success"
    ? (
      <>
        <UI.AuthHeading
          description={translate("settings.password.successDescription")}
          title={translate("settings.password.successTitle")}
        />
        <UI.InlineNotice tone="success">
          {translate("settings.password.successNotice")}
        </UI.InlineNotice>
        <RouterLink to={SESSIONS_SETTINGS_PATH}>
          {translate("settings.password.reviewSessions")}
        </RouterLink>
      </>
    )
    : (
      <>
        <UI.AuthHeading
          description={translate("settings.password.description")}
          title={translate("settings.password.title")}
        />
        <SecurityAsyncBoundary
          emptyDescription={translate("settings.password.emptyDescription")}
          emptyTitle={translate("settings.password.emptyTitle")}
          kind={async}
          onRefresh={onRefresh}
          onReload={onReload}
          onRetry={onRetry}
        >
          <UI.FormContent>
            {failure === null
              ? null
              : failure.kind === "notice"
              ? (
                <UI.InlineNotice tone="error">
                  {failure.retryAfterSeconds === null
                    ? translate(failure.messageKey)
                    : translate(failure.messageKey, {
                      retryAfterSeconds: failure.retryAfterSeconds,
                    })}
                </UI.InlineNotice>
              )
              : failure.kind === "offline"
              ? (
                <UI.InlineNotice tone="warning">
                  {translate("settings.async.offlineNotice")}
                </UI.InlineNotice>
              )
              : (
                <UI.InlineNotice tone="error">
                  {translate("settings.password.formError")}
                </UI.InlineNotice>
              )}
            <form
              onSubmit={(event) => {
                event.preventDefault();
                onSubmit();
              }}
            >
              <UI.Stack gap="standard">
                <UI.Field
                  error={failure?.kind === "invalidPassword"
                    ? translate("settings.password.currentError")
                    : undefined}
                  htmlFor={PASSWORD_CURRENT_INPUT_ID}
                  label={translate("settings.password.currentLabel")}
                >
                  <UI.PasswordInput
                    autoComplete="current-password"
                    id={PASSWORD_CURRENT_INPUT_ID}
                    invalid={failure?.kind === "invalidPassword"}
                    name="current-password"
                    onChange={onCurrentChange}
                    placeholder={translate(
                      "settings.password.currentPlaceholder",
                    )}
                    revealLabels={revealLabels}
                    value={currentPassword}
                  />
                </UI.Field>
                <UI.Field
                  error={failure?.kind === "weakPassword"
                    ? translate("settings.password.newError")
                    : undefined}
                  htmlFor={PASSWORD_NEW_INPUT_ID}
                  label={translate("settings.password.newLabel")}
                >
                  <UI.PasswordInput
                    autoComplete="new-password"
                    id={PASSWORD_NEW_INPUT_ID}
                    invalid={failure?.kind === "weakPassword"}
                    name="new-password"
                    onChange={onNewChange}
                    placeholder={translate("settings.password.newPlaceholder")}
                    revealLabels={revealLabels}
                    value={newPassword}
                  />
                </UI.Field>
                <UI.Button
                  disabled={isDisconnected(async)}
                  loading={pending}
                  type="submit"
                >
                  {translate(
                    pending
                      ? "auth.common.pendingAction"
                      : "settings.password.save",
                  )}
                </UI.Button>
              </UI.Stack>
            </form>
            <RouterLink to={SECURITY_SETTINGS_PATH}>
              {translate("settings.password.cancel")}
            </RouterLink>
          </UI.FormContent>
        </SecurityAsyncBoundary>
      </>
    );

  return (
    <UI.SettingsContent data-testid="change-password">
      {content}
    </UI.SettingsContent>
  );
}

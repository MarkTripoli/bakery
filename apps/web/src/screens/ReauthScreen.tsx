import * as UI from "@bakery/ui";
import { RouterLink } from "../app/router-link.tsx";
import type { SecurityFailure } from "../app/security-failures.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { useAuthBrandProps } from "./auth-brand.tsx";
import { PasswordNotSetNotice } from "./password-not-set.tsx";
import {
  isDisconnected,
  SecurityAsyncBoundary,
  type SecurityAsyncKind,
} from "./security-async.tsx";

export const REAUTH_PASSWORD_INPUT_ID = "reauth-password";

export type ReauthScreenProps = {
  readonly displayName: string;
  readonly email: string;
  readonly password: string;
  readonly pending: boolean;
  readonly failure: SecurityFailure | null;
  /** Where Cancel goes: the page the person came from. */
  readonly cancelTo: string;
  readonly async: SecurityAsyncKind | null;
  readonly onPasswordChange: (value: string) => void;
  readonly onSubmit: () => void;
  /** Passwordless accounts: ends the session and returns to sign-in. */
  readonly onSignOutThenSignIn: () => void;
  readonly onRetry: () => void;
  readonly onReload: () => void;
  readonly onRefresh: () => void;
};

/**
 * `/account/reauthenticate` presenter — Paper V-0 `reauth` (auth.js
 * `reauth`, `authShell`): "Confirm it’s you", the signed-in identity, one
 * password field and "Confirm identity". Reached when an action needs a
 * fresh sign-in or factor proof; the container returns to the page that
 * sent the person here.
 */
export function ReauthScreen(props: ReauthScreenProps) {
  const { translate } = useI18n();
  const brand = useAuthBrandProps();
  const { async, failure } = props;
  const failed = failure !== null && failure.kind !== "offline" &&
    failure.kind !== "passwordNotSet";
  const notice = failure === null
    ? null
    : failure.kind === "offline"
    ? (
      <UI.InlineNotice tone="warning">
        {translate("settings.async.offlineNotice")}
      </UI.InlineNotice>
    )
    : failure.kind === "passwordNotSet"
    ? (
      <PasswordNotSetNotice
        onSignOutThenSignIn={props.onSignOutThenSignIn}
      />
    )
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
    : (
      <UI.InlineNotice tone="error">
        {translate("settings.reauth.formError")}
      </UI.InlineNotice>
    );
  return (
    <UI.AuthEntry
      variant="brand"
      {...brand}
    >
      <UI.AuthHeading
        description={translate("settings.reauth.description")}
        title={translate("settings.reauth.title")}
      />
      <SecurityAsyncBoundary
        emptyDescription={translate("settings.reauth.emptyDescription")}
        emptyTitle={translate("settings.reauth.emptyTitle")}
        kind={async}
        onRefresh={props.onRefresh}
        onReload={props.onReload}
        onRetry={props.onRetry}
      >
        <UI.DescriptionItem
          description={props.email}
          icon={<UI.IconGlyph name="person" size="large" />}
          title={props.displayName}
        />
        {notice}
        <form
          data-form="reauth"
          onSubmit={(event) => {
            event.preventDefault();
            props.onSubmit();
          }}
        >
          <UI.Stack gap="standard">
            <UI.Field
              htmlFor={REAUTH_PASSWORD_INPUT_ID}
              label={translate("settings.reauth.passwordLabel")}
            >
              <UI.PasswordInput
                autoComplete="current-password"
                id={REAUTH_PASSWORD_INPUT_ID}
                invalid={failed}
                name="current-password"
                onChange={props.onPasswordChange}
                placeholder={translate("settings.reauth.passwordPlaceholder")}
                revealLabels={{
                  hide: translate("auth.signIn.hidePassword"),
                  show: translate("auth.signIn.showPassword"),
                }}
                value={props.password}
              />
            </UI.Field>
            <UI.Button
              disabled={isDisconnected(async)}
              loading={props.pending}
              type="submit"
            >
              {translate(
                props.pending
                  ? "auth.common.pendingAction"
                  : "settings.reauth.confirm",
              )}
            </UI.Button>
          </UI.Stack>
        </form>
        <RouterLink to={props.cancelTo}>
          {translate("settings.reauth.cancel")}
        </RouterLink>
      </SecurityAsyncBoundary>
    </UI.AuthEntry>
  );
}

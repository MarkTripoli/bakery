import * as UI from "@bakery/ui";
import { PASSKEYS_SETTINGS_PATH } from "../app/auth-paths.ts";
import { RouterLink } from "../app/router-link.tsx";
import type { SecurityFailure } from "../app/security-failures.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import {
  isDisconnected,
  SecurityAsyncBoundary,
  type SecurityAsyncKind,
} from "./security-async.tsx";
import { ActionLink } from "./action-link.tsx";
import { PasswordNotSetNotice } from "./password-not-set.tsx";
import { AccountSettingsBackLink } from "./settings-back.tsx";

export const PASSKEY_ADD_NAME_INPUT_ID = "passkey-add-name";
export const PASSKEY_ADD_PASSWORD_INPUT_ID = "passkey-add-password";

/** The ceremony's step, one per Paper `passkey-add` state. */
export type AddPasskeyStep =
  | "form"
  | "prompt"
  | "canceled"
  | "unsupported"
  | "failed"
  | "success";

export type AddPasskeyScreenProps = {
  readonly step: AddPasskeyStep;
  readonly nameDraft: string;
  readonly passwordDraft: string;
  /** The server said the account has no password: the field is not needed. */
  readonly passwordless: boolean;
  /** Email shown on the device-prompt identity row. */
  readonly email: string;
  /** The name the new passkey was saved under (`success`). */
  readonly savedName: string;
  readonly pending: boolean;
  readonly failure: SecurityFailure | null;
  readonly async: SecurityAsyncKind | null;
  readonly onNameChange: (value: string) => void;
  readonly onPasswordChange: (value: string) => void;
  readonly onSubmit: () => void;
  /** "Manage passkeys" on success: the passkeys page this link navigates to. */
  readonly manageTo: string;
  /** "Try again" after a canceled or failed ceremony. */
  readonly onTryAgain: () => void;
  /** Passwordless accounts: ends the session and returns to sign-in. */
  readonly onSignOutThenSignIn: () => void;
  /** Cancel on the form and on the device prompt. */
  readonly onCancel: () => void;
  readonly onRetry: () => void;
  readonly onReload: () => void;
  readonly onRefresh: () => void;
};

/**
 * `/settings/security/passkeys/new` presenter — Paper V-0 `passkey-add`
 * (auth.js `passkey-add`): name and confirm, then the device prompt, then one
 * of canceled, unsupported, failed or success. The browser ceremony itself
 * lives in the container; this only renders the step it reports.
 */
export function AddPasskeyScreen(props: AddPasskeyScreenProps) {
  const { translate } = useI18n();
  const { async, step } = props;
  const back = <AccountSettingsBackLink />;

  if (step === "success") {
    return (
      <UI.SettingsContent back={back} data-testid="passkey-add-success">
        <UI.FormContent>
          <UI.AuthHeading
            description={translate("passkeys.add.successDescription", {
              name: props.savedName,
            })}
            title={translate("passkeys.add.successTitle")}
          />
          <UI.InlineNotice tone="success">
            {translate("passkeys.add.successNotice")}
          </UI.InlineNotice>
          <RouterLink to={props.manageTo} variant="primaryButton">
            {translate("passkeys.add.manage")}
          </RouterLink>
        </UI.FormContent>
      </UI.SettingsContent>
    );
  }

  if (step === "unsupported") {
    return (
      <UI.SettingsContent back={back} data-testid="passkey-add-unsupported">
        <UI.FormContent>
          <UI.AuthHeading
            description={translate("passkeys.add.unsupportedDescription")}
            title={translate("passkeys.add.unsupportedTitle")}
          />
          <UI.InlineNotice tone="information">
            {translate("passkeys.add.unsupportedNotice")}
          </UI.InlineNotice>
          <RouterLink to={PASSKEYS_SETTINGS_PATH} variant="button">
            {translate("passkeys.add.backToPasskeys")}
          </RouterLink>
        </UI.FormContent>
      </UI.SettingsContent>
    );
  }

  if (step === "canceled" || step === "failed") {
    return (
      <UI.SettingsContent back={back} data-testid={`passkey-add-${step}`}>
        <UI.FormContent>
          <UI.AuthHeading
            description={translate(
              step === "canceled"
                ? "passkeys.add.canceledDescription"
                : "passkeys.add.failedNotice",
            )}
            title={translate(
              step === "canceled"
                ? "passkeys.add.canceledTitle"
                : "passkeys.add.failedTitle",
            )}
          />
          <UI.Button onClick={props.onTryAgain}>
            {translate("passkeys.add.tryAgain")}
          </UI.Button>
          <RouterLink to={PASSKEYS_SETTINGS_PATH}>
            {translate("passkeys.add.backToPasskeys")}
          </RouterLink>
        </UI.FormContent>
      </UI.SettingsContent>
    );
  }

  if (step === "prompt") {
    return (
      <UI.SettingsContent back={back} data-testid="passkey-add-prompt">
        <UI.FormContent>
          <UI.AuthHeading
            description={translate("passkeys.add.promptDescription")}
            title={translate("passkeys.add.promptTitle")}
          />
          <UI.DescriptionItem
            description={translate("passkeys.add.promptIdentity", {
              email: props.email,
            })}
            icon={<UI.IconGlyph name="key" size="large" />}
            title={props.nameDraft}
          />
          <UI.InlineNotice tone="neutral">
            {translate("passkeys.add.promptNotice")}
          </UI.InlineNotice>
          <ActionLink href="?" onActivate={props.onCancel}>
            {translate("passkeys.add.promptCancel")}
          </ActionLink>
        </UI.FormContent>
      </UI.SettingsContent>
    );
  }

  return (
    <UI.SettingsContent back={back} data-testid="passkey-add">
      <UI.AuthHeading
        description={translate("passkeys.add.description")}
        title={translate("passkeys.add.title")}
      />
      <SecurityAsyncBoundary
        emptyDescription={translate("passkeys.add.emptyDescription")}
        emptyTitle={translate("passkeys.add.emptyTitle")}
        kind={async}
        onRefresh={props.onRefresh}
        onReload={props.onReload}
        onRetry={props.onRetry}
      >
        <UI.FormContent>
          {props.failure === null
            ? null
            : props.failure.kind === "notice"
            ? (
              <UI.InlineNotice tone="error">
                {props.failure.retryAfterSeconds === null
                  ? translate(props.failure.messageKey)
                  : translate(props.failure.messageKey, {
                    retryAfterSeconds: props.failure.retryAfterSeconds,
                  })}
              </UI.InlineNotice>
            )
            : props.failure.kind === "offline"
            ? (
              <UI.InlineNotice tone="warning">
                {translate("settings.async.offlineNotice")}
              </UI.InlineNotice>
            )
            : props.failure.kind === "passwordNotSet"
            ? (
              <PasswordNotSetNotice
                onSignOutThenSignIn={props.onSignOutThenSignIn}
              />
            )
            : null}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              props.onSubmit();
            }}
          >
            <UI.Stack gap="standard">
              <UI.Field
                hint={translate("passkeys.add.nameHint")}
                htmlFor={PASSKEY_ADD_NAME_INPUT_ID}
                label={translate("passkeys.add.nameLabel")}
              >
                <UI.TextInput
                  autoComplete="off"
                  id={PASSKEY_ADD_NAME_INPUT_ID}
                  name="passkey-name"
                  onChange={props.onNameChange}
                  type="text"
                  value={props.nameDraft}
                />
              </UI.Field>
              {props.passwordless
                ? (
                  <UI.InlineNotice tone="neutral">
                    {translate("settings.passwordless.note")}
                  </UI.InlineNotice>
                )
                : (
                  <UI.Field
                    error={props.failure?.kind === "invalidPassword"
                      ? translate("passkeys.add.passwordError")
                      : undefined}
                    htmlFor={PASSKEY_ADD_PASSWORD_INPUT_ID}
                    label={translate("passkeys.add.passwordLabel")}
                  >
                    <UI.PasswordInput
                      autoComplete="current-password"
                      id={PASSKEY_ADD_PASSWORD_INPUT_ID}
                      invalid={props.failure?.kind === "invalidPassword"}
                      name="current-password"
                      onChange={props.onPasswordChange}
                      placeholder={translate(
                        "passkeys.add.passwordPlaceholder",
                      )}
                      revealLabels={{
                        hide: translate("auth.signIn.hidePassword"),
                        show: translate("auth.signIn.showPassword"),
                      }}
                      value={props.passwordDraft}
                    />
                  </UI.Field>
                )}
              <UI.Button
                disabled={isDisconnected(async)}
                loading={props.pending}
                type="submit"
              >
                {translate(
                  props.pending
                    ? "auth.common.pendingAction"
                    : "passkeys.add.continue",
                )}
              </UI.Button>
            </UI.Stack>
          </form>
          <ActionLink href={PASSKEYS_SETTINGS_PATH} onActivate={props.onCancel}>
            {translate("passkeys.add.cancel")}
          </ActionLink>
        </UI.FormContent>
      </SecurityAsyncBoundary>
    </UI.SettingsContent>
  );
}
